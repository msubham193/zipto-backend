import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CustomerProfile } from './entities/customer-profile.entity';
import { User } from '../auth/entities/user.entity';
import {
  WalletTransaction,
  WalletTxnType,
  WalletTxnSource,
} from './entities/wallet-transaction.entity';
import { UpdateCustomerDto, SavedLocationDto } from './dto/customer.dto';
import { HdfcPaymentService } from '../../services/hdfc-payment.service';
import { TransactionLogService } from '../transaction-log/transaction-log.service';
import { RedisService } from '../../services/redis.service';
import { MapboxService } from '../../services/mapbox.service';

// Presence naturally disappears if the customer's app stops pinging (closed,
// backgrounded, or lost connectivity) — no explicit "went offline" event needed.
const PRESENCE_TTL_MS = 2 * 60 * 1000;
const PRESENCE_KEY_PREFIX = 'customer:presence:';
const LIVE_HEATMAP_CACHE_KEY = 'live_customer_heatmap';
const LIVE_HEATMAP_CACHE_TTL_MS = 15 * 1000;

@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(CustomerProfile)
    private customerProfileRepository: Repository<CustomerProfile>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(WalletTransaction)
    private walletTxnRepository: Repository<WalletTransaction>,
    private dataSource: DataSource,
    private hdfcService: HdfcPaymentService,
    private readonly transactionLog: TransactionLogService,
    private readonly redisService: RedisService,
    private readonly mapboxService: MapboxService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────────────────────────────────

  async getProfile(userId: string) {
    let profile = await this.customerProfileRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      const newProfile = this.customerProfileRepository.create({
        user_id: userId,
        saved_locations: [],
      });
      await this.customerProfileRepository.save(newProfile);

      profile = await this.customerProfileRepository.findOne({
        where: { user_id: userId },
        relations: ['user'],
      });

      if (!profile) {
        throw new NotFoundException('Unable to create customer profile');
      }
    }

    return profile;
  }

  async updateProfile(userId: string, updateCustomerDto: UpdateCustomerDto) {
    const profile = await this.getProfile(userId);

    const { name, email, language_preference } = updateCustomerDto;
    if (name || email || language_preference) {
      await this.userRepository.update(userId, {
        ...(name && { name, is_profile_complete: true }),
        ...(email && { email }),
        ...(language_preference && { language_preference }),
      });
    }

    const { address } = updateCustomerDto;
    if (address !== undefined) {
      profile.address = address;
      await this.customerProfileRepository.save(profile);
    }

    return this.getProfile(userId);
  }

  async getSavedLocations(userId: string) {
    const profile = await this.getProfile(userId);
    return profile.saved_locations || [];
  }

  async addSavedLocation(userId: string, locationDto: SavedLocationDto) {
    const profile = await this.getProfile(userId);
    const locations = profile.saved_locations || [];
    locations.push(locationDto);
    profile.saved_locations = locations;
    await this.customerProfileRepository.save(profile);
    return profile.saved_locations;
  }

  async removeSavedLocation(userId: string, index: number) {
    const profile = await this.getProfile(userId);
    const locations = profile.saved_locations || [];

    if (index < 0 || index >= locations.length) {
      throw new NotFoundException('Location not found');
    }

    locations.splice(index, 1);
    profile.saved_locations = locations;
    await this.customerProfileRepository.save(profile);
    return profile.saved_locations;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Live presence (real-time "app is open here" signal for the driver-facing
  // live heatmap — deliberately Redis-only/ephemeral, never written to
  // Postgres. Distinct from BookingDemandLog, which only logs an actual
  // booking attempt; this reflects anyone with the app open, whether or not
  // they ever book.
  // ─────────────────────────────────────────────────────────────────────────

  async updatePresence(userId: string, latitude: number, longitude: number) {
    await this.redisService.set(
      `${PRESENCE_KEY_PREFIX}${userId}`,
      { latitude, longitude },
      PRESENCE_TTL_MS,
    );

    // Lazily derive the customer's state from where they open the app — this
    // covers customers who never booked (they'd otherwise have no location to
    // geocode). Once per customer, fire-and-forget so it never slows the ping.
    this.populateStateIfMissing(userId, latitude, longitude);

    return { message: 'Presence updated' };
  }

  /**
   * Reverse-geocode a coordinate to an Indian state and store it on the user,
   * only if they have no state yet — so it runs at most once per customer.
   * Fire-and-forget: any failure is swallowed and retried on the next ping.
   */
  private populateStateIfMissing(userId: string, latitude: number, longitude: number): void {
    (async () => {
      const user = await this.userRepository.findOne({ where: { id: userId }, select: ['id', 'state'] });
      if (!user || user.state) return;
      const state = await this.mapboxService.reverseGeocodeState(latitude, longitude);
      if (state) {
        await this.userRepository.update({ id: userId }, { state });
      }
    })().catch(() => {/* non-critical — retried on next presence ping */});
  }

  /**
   * Driver-facing live heatmap — aggregates every currently-live customer
   * presence into coarse ~1.1km locality cells (2-decimal grid). Privacy by
   * design: a customer's exact position is NEVER exposed — only the snapped
   * cell centre and an anonymous per-cell count are returned, so a driver
   * learns "customers are active around this locality", never where anyone
   * precisely is. The rider app names these areas (reverse-geocode) and shows
   * a direction to travel, rather than plotting individuals.
   */
  async getLiveHeatmap() {
    const cached = await this.redisService.get<any>(LIVE_HEATMAP_CACHE_KEY);
    if (cached) return cached;

    const keys = await this.redisService.scanKeys(`${PRESENCE_KEY_PREFIX}*`);
    const values = await this.redisService.mget<{ latitude: number; longitude: number }>(keys);

    // Snap to a ~1.1km grid (2 decimal places). The reported coordinate is the
    // grid cell centre, not the customer's real position.
    const grid = new Map<string, number>();
    for (const v of values) {
      if (!v) continue;
      const lat = Math.round(v.latitude * 100) / 100;
      const lng = Math.round(v.longitude * 100) / 100;
      const cellKey = `${lat},${lng}`;
      grid.set(cellKey, (grid.get(cellKey) || 0) + 1);
    }

    const points = Array.from(grid.entries())
      .map(([cellKey, weight]) => {
        const [lat, lng] = cellKey.split(',').map(Number);
        return { latitude: lat, longitude: lng, weight };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 200);

    const result = { points, generatedAt: new Date().toISOString() };
    await this.redisService.set(LIVE_HEATMAP_CACHE_KEY, result, LIVE_HEATMAP_CACHE_TTL_MS);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wallet
  // ─────────────────────────────────────────────────────────────────────────

  async getWallet(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'wallet_balance'],
    });
    if (!user) throw new NotFoundException('User not found');

    const transactions = await this.walletTxnRepository.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      take: 20,
    });

    return {
      balance: parseFloat(user.wallet_balance as unknown as string),
      transactions,
    };
  }

  async getWalletTransactions(userId: string, page = 1, limit = 20) {
    const [transactions, total] = await this.walletTxnRepository.findAndCount({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { transactions, total, page, limit };
  }

  /**
   * Initiate HDFC wallet top-up — returns encRequest + HDFC payment URL.
   * The frontend opens the Payment screen (WebView); HDFC posts back to
   * /payment/hdfc/response which credits the wallet and emits wallet_topped_up.
   */
  async initiateAddMoney(userId: string, amount: number) {
    if (amount < 10) throw new BadRequestException('Minimum top-up amount is ₹10');
    if (amount > 50000) throw new BadRequestException('Maximum top-up amount is ₹50,000');

    const orderId = this.hdfcService.generateOrderId();
    const req = this.hdfcService.buildRequest({
      orderId,
      amount,
      merchantRef: `WALLET:${userId}`,
    });

    return { ...req, orderId, amount };
  }

  /**
   * Internal — deduct wallet balance during booking payment
   */
  async deductWallet(
    userId: string,
    amount: number,
    description: string,
    referenceId?: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('User not found');

      const currentBalance = parseFloat(
        user.wallet_balance as unknown as string,
      );
      if (currentBalance < amount) {
        throw new BadRequestException('Insufficient wallet balance');
      }

      const newBalance = currentBalance - amount;
      await manager.update(User, userId, { wallet_balance: newBalance });

      const txn = manager.create(WalletTransaction, {
        user_id: userId,
        type: WalletTxnType.DEBIT,
        amount,
        balance_after: newBalance,
        description,
        source: WalletTxnSource.BOOKING_PAYMENT,
        reference_id: referenceId ?? null,
      });
      await manager.save(txn);

      this.transactionLog.record({
        userId,
        category: 'wallet_payment',
        direction: 'debit',
        amount,
        gateway: 'wallet',
        gatewayRef: referenceId,
        bookingId: referenceId,
        balanceAfter: newBalance,
        description,
      }).catch(() => {});

      return { balance: newBalance, transaction: txn };
    });
  }

  /**
   * Internal — credit wallet (refund / cashback)
   */
  async creditWallet(
    userId: string,
    amount: number,
    description: string,
    source: WalletTxnSource = WalletTxnSource.REFUND,
    referenceId?: string,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('User not found');

      const currentBalance = parseFloat(
        user.wallet_balance as unknown as string,
      );
      const newBalance = currentBalance + amount;

      await manager.update(User, userId, { wallet_balance: newBalance });

      const txn = manager.create(WalletTransaction, {
        user_id: userId,
        type: WalletTxnType.CREDIT,
        amount,
        balance_after: newBalance,
        description,
        source,
        reference_id: referenceId ?? null,
      });
      await manager.save(txn);

      this.transactionLog.record({
        userId,
        category: source === WalletTxnSource.REFUND ? 'wallet_refund' : 'wallet_credit',
        direction: 'credit',
        amount,
        gateway: 'wallet',
        gatewayRef: referenceId,
        bookingId: referenceId,
        balanceAfter: newBalance,
        description,
      }).catch(() => {});

      return { balance: newBalance, transaction: txn };
    });
  }
}
