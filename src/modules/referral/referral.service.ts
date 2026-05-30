import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Referral, ReferralStatus } from './entities/referral.entity';
import { User } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { CoinService } from '../coin/coin.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { getPaginationMeta } from '../../common/utils/helpers.util';

// Unambiguous alphabet (no 0/O/1/I) for human-friendly, shareable codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    @InjectRepository(Referral)
    private readonly referralRepo: Repository<Referral>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    private readonly coinService: CoinService,
    private readonly settingsService: SystemSettingsService,
  ) {}

  // ─── Code generation ─────────────────────────────────────────────────────────

  private randomCode(): string {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return code;
  }

  /** Ensure the user has a unique referral code, generating one if missing. */
  private async ensureCode(user: User): Promise<string> {
    if (user.referral_code) return user.referral_code;

    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = this.randomCode();
      const clash = await this.userRepo.count({ where: { referral_code: candidate } });
      if (clash === 0) {
        await this.userRepo.update({ id: user.id }, { referral_code: candidate });
        user.referral_code = candidate;
        return candidate;
      }
    }
    throw new BadRequestException('Could not generate a referral code, please retry');
  }

  // ─── Customer: my code + stats ─────────────────────────────────────────────────

  async getMyReferralInfo(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const code = await this.ensureCode(user);
    const settings = await this.settingsService.getReferralSettings();

    const referrals = await this.referralRepo.find({
      where: { referrer_id: userId },
    });
    const rewarded = referrals.filter((r) => r.status === ReferralStatus.REWARDED);
    const coinsEarned = rewarded.reduce((s, r) => s + r.referrer_coins, 0);

    return {
      code,
      enabled: settings.enabled,
      referee_coins: settings.referee_coins,
      referrer_coins: settings.referrer_coins,
      share_message:
        `Join Zipto with my referral code ${code} for fast, affordable delivery. ` +
        `Complete your first order and we both earn Zipto coins!`,
      stats: {
        total_referred: referrals.length,
        total_rewarded: rewarded.length,
        total_pending: referrals.filter((r) => r.status === ReferralStatus.PENDING).length,
        coins_earned: coinsEarned,
      },
    };
  }

  // ─── Customer: apply a code ────────────────────────────────────────────────────

  /**
   * Apply a referrer's code to the current (new) user. Creates a PENDING
   * referral that pays out once the referee completes their first ride.
   * Safe to call from signup (best-effort) or from the in-app refer screen.
   */
  async applyCode(refereeId: string, rawCode: string) {
    const settings = await this.settingsService.getReferralSettings();
    if (!settings.enabled) {
      throw new BadRequestException('The referral program is currently unavailable');
    }

    const code = (rawCode || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('Referral code is required');

    // One referral per referee.
    const existing = await this.referralRepo.findOne({ where: { referee_id: refereeId } });
    if (existing) {
      throw new ConflictException('You have already used a referral code');
    }

    // Only new users (no completed rides yet) can be referred.
    const completedRides = await this.bookingRepo.count({
      where: { customer_id: refereeId, status: BookingStatus.COMPLETED },
    });
    if (completedRides > 0) {
      throw new BadRequestException(
        'Referral codes can only be applied before your first completed order',
      );
    }

    const referrer = await this.userRepo.findOne({ where: { referral_code: code } });
    if (!referrer) throw new BadRequestException('Invalid referral code');
    if (referrer.id === refereeId) {
      throw new BadRequestException('You cannot use your own referral code');
    }

    const referral = this.referralRepo.create({
      referrer_id: referrer.id,
      referee_id: refereeId,
      code,
      status: ReferralStatus.PENDING,
      // Snapshot the reward amounts at apply-time so later admin changes are fair.
      referee_coins: settings.referee_coins,
      referrer_coins: settings.referrer_coins,
    });
    await this.referralRepo.save(referral);

    this.logger.log(
      `Referral created: referrer=${referrer.id} referee=${refereeId} code=${code}`,
    );

    return {
      success: true,
      message: `Code applied! You'll earn ${settings.referee_coins} coins after your first order.`,
      referee_coins: settings.referee_coins,
    };
  }

  /** Best-effort variant for signup — never throws, returns whether it applied. */
  async applyCodeSafe(refereeId: string, rawCode?: string): Promise<boolean> {
    if (!rawCode) return false;
    try {
      await this.applyCode(refereeId, rawCode);
      return true;
    } catch (err: any) {
      this.logger.warn(`Referral apply skipped for ${refereeId}: ${err?.message}`);
      return false;
    }
  }

  // ─── Reward trigger ─────────────────────────────────────────────────────────────

  /**
   * Called when a customer completes a ride. If they were referred and the
   * referral is still pending, credit both parties exactly once.
   * Idempotent via an atomic status claim; safe to call on every completion.
   */
  async onFirstCompletedRide(refereeId: string, bookingId: string): Promise<void> {
    const referral = await this.referralRepo.findOne({
      where: { referee_id: refereeId, status: ReferralStatus.PENDING },
    });
    if (!referral) return;

    const settings = await this.settingsService.getReferralSettings();
    if (!settings.enabled) return;

    // Atomic claim: only the transition pending → rewarded that affects a row wins.
    const claim = await this.referralRepo.update(
      { id: referral.id, status: ReferralStatus.PENDING },
      {
        status: ReferralStatus.REWARDED,
        rewarded_at: new Date(),
        qualifying_booking_id: bookingId,
      },
    );
    if (claim.affected !== 1) return; // already processed by a concurrent call

    try {
      await this.coinService.creditCoins(
        referral.referee_id,
        referral.referee_coins,
        'Referral bonus — joined Zipto with a friend’s code',
        bookingId,
      );
      await this.coinService.creditCoins(
        referral.referrer_id,
        referral.referrer_coins,
        'Referral bonus — your friend completed their first order',
        bookingId,
      );
      this.logger.log(
        `Referral rewarded: referrer=${referral.referrer_id} (+${referral.referrer_coins}) ` +
          `referee=${referral.referee_id} (+${referral.referee_coins}) booking=${bookingId}`,
      );
    } catch (err: any) {
      // Crediting failed after claim — revert so it can be retried on a later ride.
      this.logger.error(`Referral credit failed, reverting claim: ${err?.message}`);
      await this.referralRepo.update(
        { id: referral.id },
        { status: ReferralStatus.PENDING, rewarded_at: null, qualifying_booking_id: null },
      );
    }
  }

  // ─── Customer: my referrals list ────────────────────────────────────────────────

  async getMyReferrals(userId: string) {
    const rows = await this.referralRepo
      .createQueryBuilder('r')
      .leftJoin('users', 'referee', 'referee.id = r.referee_id')
      .where('r.referrer_id = :userId', { userId })
      .orderBy('r.created_at', 'DESC')
      .select([
        'r.id AS id',
        'r.status AS status',
        'r.referrer_coins AS coins',
        'r.created_at AS created_at',
        'r.rewarded_at AS rewarded_at',
        'referee.name AS referee_name',
        'referee.phone AS referee_phone',
      ])
      .getRawMany();

    const masked = rows.map((r) => ({
      id: r.id,
      status: r.status,
      coins: Number(r.coins) || 0,
      referee_name: r.referee_name || 'New user',
      referee_phone: maskPhone(r.referee_phone),
      created_at: r.created_at,
      rewarded_at: r.rewarded_at,
    }));

    const coinsEarned = masked
      .filter((r) => r.status === ReferralStatus.REWARDED)
      .reduce((s, r) => s + r.coins, 0);

    return {
      referrals: masked,
      summary: {
        total: masked.length,
        rewarded: masked.filter((r) => r.status === ReferralStatus.REWARDED).length,
        pending: masked.filter((r) => r.status === ReferralStatus.PENDING).length,
        coins_earned: coinsEarned,
      },
    };
  }

  // ─── Admin: list + stats ─────────────────────────────────────────────────────────

  async adminList(params: { status?: string; page?: number; limit?: number; search?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));

    const qb = this.referralRepo
      .createQueryBuilder('r')
      .leftJoin('users', 'referrer', 'referrer.id = r.referrer_id')
      .leftJoin('users', 'referee', 'referee.id = r.referee_id')
      .select([
        'r.id AS id',
        'r.code AS code',
        'r.status AS status',
        'r.referee_coins AS referee_coins',
        'r.referrer_coins AS referrer_coins',
        'r.qualifying_booking_id AS qualifying_booking_id',
        'r.rewarded_at AS rewarded_at',
        'r.created_at AS created_at',
        'referrer.id AS referrer_id',
        'referrer.name AS referrer_name',
        'referrer.phone AS referrer_phone',
        'referrer.email AS referrer_email',
        'referee.id AS referee_id',
        'referee.name AS referee_name',
        'referee.phone AS referee_phone',
        'referee.email AS referee_email',
      ])
      .orderBy('r.created_at', 'DESC');

    if (params.status && params.status !== 'all') {
      qb.andWhere('r.status = :status', { status: params.status });
    }
    if (params.search) {
      qb.andWhere(
        '(referrer.name ILIKE :s OR referrer.phone ILIKE :s OR referee.name ILIKE :s OR referee.phone ILIKE :s OR r.code ILIKE :s)',
        { s: `%${params.search}%` },
      );
    }

    const countQb = qb.clone();
    const total = await countQb.getCount();

    const rows = await qb.offset((page - 1) * limit).limit(limit).getRawMany();

    return {
      referrals: rows.map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        referee_coins: Number(r.referee_coins) || 0,
        referrer_coins: Number(r.referrer_coins) || 0,
        qualifying_booking_id: r.qualifying_booking_id,
        rewarded_at: r.rewarded_at,
        created_at: r.created_at,
        referrer: {
          id: r.referrer_id,
          name: r.referrer_name,
          phone: r.referrer_phone,
          email: r.referrer_email,
        },
        referee: {
          id: r.referee_id,
          name: r.referee_name,
          phone: r.referee_phone,
          email: r.referee_email,
        },
      })),
      ...getPaginationMeta(total, page, limit),
    };
  }

  async adminStats() {
    const [total, pending, rewarded] = await Promise.all([
      this.referralRepo.count(),
      this.referralRepo.count({ where: { status: ReferralStatus.PENDING } }),
      this.referralRepo.count({ where: { status: ReferralStatus.REWARDED } }),
    ]);

    const coinsRow = await this.referralRepo
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.referee_coins + r.referrer_coins), 0)', 'coins')
      .where('r.status = :status', { status: ReferralStatus.REWARDED })
      .getRawOne<{ coins: string }>();

    return {
      total_referrals: total,
      pending,
      rewarded,
      total_coins_distributed: Number(coinsRow?.coins) || 0,
    };
  }
}

/** Mask a phone number for customer-facing display: +9198****1234 */
function maskPhone(phone?: string | null): string {
  if (!phone) return '';
  if (phone.length <= 4) return phone;
  const last4 = phone.slice(-4);
  const head = phone.slice(0, Math.max(0, phone.length - 8));
  return `${head}****${last4}`;
}
