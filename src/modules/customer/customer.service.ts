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
