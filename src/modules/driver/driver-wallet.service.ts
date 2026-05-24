import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  DriverWalletTransaction,
  DriverWalletTxnType,
} from './entities/driver-wallet-transaction.entity';
import { NotificationService } from '../notification/notification.service';

/** Wallet balance below this triggers a low-balance push notification */
const LOW_BALANCE_THRESHOLD = 100;

/** Wallet balance below this blocks the driver from accepting new bookings */
export const WALLET_SUSPENSION_THRESHOLD = -300;

@Injectable()
export class DriverWalletService {
  private readonly logger = new Logger(DriverWalletService.name);

  constructor(
    @InjectRepository(DriverWalletTransaction)
    private txnRepository: Repository<DriverWalletTransaction>,
    private dataSource: DataSource,
    private notificationService: NotificationService,
  ) {}

  /**
   * Credit driver's share after an ONLINE/QR payment.
   * The customer already paid Zipto via Razorpay; we transfer the driver's cut
   * into their virtual wallet so they can withdraw it later.
   */
  async creditTripEarnings(
    driverUserId: string,
    amount: number,
    bookingId: string,
  ): Promise<number> {
    // Idempotency guard — prevents double-credit if completeTrip is retried
    const existing = await this.txnRepository.findOne({
      where: {
        driver_user_id: driverUserId,
        booking_id: bookingId,
        type: DriverWalletTxnType.TRIP_EARNINGS_CREDIT,
      },
    });
    if (existing) {
      this.logger.warn(`[DriverWallet] Duplicate creditTripEarnings blocked for booking=${bookingId}`);
      return await this.getWalletBalance(driverUserId);
    }
    return this.adjustWallet(
      driverUserId,
      amount,
      DriverWalletTxnType.TRIP_EARNINGS_CREDIT,
      `Trip earnings for booking #${bookingId.slice(-6).toUpperCase()}`,
      bookingId,
    );
  }

  /**
   * Deduct Zipto's commission + shield from driver's wallet after a CASH trip.
   *
   * The driver physically received the full fare from the customer.
   * Zipto's cut (commission + ₹1 shield) is recovered by debiting the driver's
   * virtual wallet — exactly how Rapido/Ola/Uber handle cash rides.
   */
  async deductCashCommission(
    driverUserId: string,
    skidoCommission: number,
    shieldAmount: number,
    bookingId: string,
  ): Promise<number> {
    // Idempotency guard
    const existing = await this.txnRepository.findOne({
      where: {
        driver_user_id: driverUserId,
        booking_id: bookingId,
        type: DriverWalletTxnType.CASH_COMMISSION_DEDUCTION,
      },
    });
    if (existing) {
      this.logger.warn(`[DriverWallet] Duplicate deductCashCommission blocked for booking=${bookingId}`);
      return await this.getWalletBalance(driverUserId);
    }
    const total = Math.round(skidoCommission + shieldAmount);
    const balanceAfter = await this.adjustWallet(
      driverUserId,
      -total,
      DriverWalletTxnType.CASH_COMMISSION_DEDUCTION,
      `Cash commission ₹${skidoCommission} + shield ₹${shieldAmount} for booking #${bookingId.slice(-6).toUpperCase()}`,
      bookingId,
    );

    this.logger.log(
      `[DriverWallet] Cash deduction ₹${total} from driver=${driverUserId}, ` +
        `booking=${bookingId}, balance_after=${balanceAfter}`,
    );

    // Fire-and-forget low-balance alert
    this.checkAndNotifyLowBalance(driverUserId, balanceAfter).catch(() => {});

    return balanceAfter;
  }

  /**
   * Top up driver wallet via Razorpay.  Call this from the payment webhook
   * after confirming the topup payment is captured.
   */
  async topUp(
    driverUserId: string,
    amount: number,
    referenceId: string,
  ): Promise<number> {
    if (amount <= 0) throw new BadRequestException('Top-up amount must be > 0');
    const balanceAfter = await this.adjustWallet(
      driverUserId,
      amount,
      DriverWalletTxnType.TOPUP,
      `Wallet top-up ₹${amount}`,
      null,
      referenceId,
    );
    this.logger.log(
      `[DriverWallet] Top-up ₹${amount} for driver=${driverUserId}, balance_after=${balanceAfter}`,
    );
    return balanceAfter;
  }

  async adminCredit(
    driverUserId: string,
    amount: number,
    note: string,
  ): Promise<number> {
    return this.adjustWallet(
      driverUserId,
      amount,
      DriverWalletTxnType.ADMIN_CREDIT,
      note,
    );
  }

  async adminDebit(
    driverUserId: string,
    amount: number,
    note: string,
  ): Promise<number> {
    return this.adjustWallet(
      driverUserId,
      -amount,
      DriverWalletTxnType.ADMIN_DEBIT,
      note,
    );
  }

  async getWalletBalance(driverUserId: string): Promise<number> {
    const row = await this.dataSource.query<{ wallet_balance: string }[]>(
      `SELECT wallet_balance FROM driver_profiles WHERE user_id = $1`,
      [driverUserId],
    );
    return row.length ? Number(row[0].wallet_balance) : 0;
  }

  async getTransactions(
    driverUserId: string,
    page = 1,
    limit = 30,
  ): Promise<{ items: DriverWalletTransaction[]; total: number; balance: number }> {
    const [items, total] = await this.txnRepository.findAndCount({
      where: { driver_user_id: driverUserId },
      order: { created_at: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    const balance = await this.getWalletBalance(driverUserId);
    return { items, total, balance };
  }

  /**
   * Returns true if the driver's wallet is too negative to accept rides.
   */
  async isWalletSuspended(driverUserId: string): Promise<boolean> {
    const balance = await this.getWalletBalance(driverUserId);
    return balance < WALLET_SUSPENSION_THRESHOLD;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Atomic wallet adjustment: updates driver_profiles.wallet_balance and inserts
   * a transaction record inside a single DB transaction.
   *
   * @param delta positive = credit, negative = debit
   * @returns the new wallet balance
   */
  private async adjustWallet(
    driverUserId: string,
    delta: number,
    type: DriverWalletTxnType,
    description: string,
    bookingId?: string | null,
    referenceId?: string | null,
  ): Promise<number> {
    let newBalance = 0;

    await this.dataSource.transaction(async (manager) => {
      // Lock the row so concurrent trips don't race
      const rows = await manager.query<{ wallet_balance: string }[]>(
        `SELECT wallet_balance FROM driver_profiles WHERE user_id = $1 FOR UPDATE`,
        [driverUserId],
      );
      const current = rows.length ? Number(rows[0].wallet_balance) : 0;
      newBalance = Math.round((current + delta) * 100) / 100;

      await manager.query(
        `UPDATE driver_profiles SET wallet_balance = $1 WHERE user_id = $2`,
        [newBalance, driverUserId],
      );

      const txn = manager.getRepository(DriverWalletTransaction).create({
        driver_user_id: driverUserId,
        type,
        amount: Math.abs(delta),
        balance_after: newBalance,
        description,
        booking_id: bookingId ?? null,
        reference_id: referenceId ?? null,
      });
      await manager.getRepository(DriverWalletTransaction).save(txn);
    });

    return newBalance;
  }

  private async checkAndNotifyLowBalance(
    driverUserId: string,
    balance: number,
  ): Promise<void> {
    if (balance < WALLET_SUSPENSION_THRESHOLD) {
      await this.notificationService.sendPushNotification({
        user_id: driverUserId,
        title: 'Account Suspended',
        body: `Your Zipto wallet is at ₹${balance.toFixed(0)}. Top up now to continue accepting rides.`,
        data: { type: 'wallet_suspended', balance: String(balance) },
      });
    } else if (balance < LOW_BALANCE_THRESHOLD) {
      await this.notificationService.sendPushNotification({
        user_id: driverUserId,
        title: 'Low Wallet Balance',
        body: `Your Zipto wallet is at ₹${balance.toFixed(0)}. Top up to avoid interruptions.`,
        data: { type: 'wallet_low', balance: String(balance) },
      });
    }
  }
}
