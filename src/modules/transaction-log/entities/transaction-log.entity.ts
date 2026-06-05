import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Unified, append-only ledger of every value movement in Zipto — customer
 * payments, wallet credits/debits, driver top-ups, commissions, earnings,
 * withdrawals/payouts, coins and referral rewards. One row per movement so the
 * whole money flow is auditable from a single place.
 *
 * String columns (not Postgres enums) on purpose — new categories/gateways can
 * be added without a DB enum migration.
 */
@Entity('transaction_logs')
@Index(['user_id', 'created_at'])
@Index(['category', 'created_at'])
export class TransactionLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The user this entry affects (customer or driver). Null for system/admin. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  user_id: string | null;

  /** The other party, when relevant (e.g. driver for a booking payment, referrer for a referral). */
  @Column({ type: 'uuid', nullable: true })
  counterparty_user_id: string | null;

  /**
   * What kind of movement: booking_payment | wallet_topup | wallet_debit |
   * wallet_refund | driver_topup | driver_commission | driver_earnings |
   * withdrawal | payout | coin_earn | coin_redeem | coin_transfer |
   * referral_reward | shield_contribution | shield_withdrawal
   */
  @Column({ type: 'varchar', length: 40 })
  @Index()
  category: string;

  /** 'credit' | 'debit' (from the user's perspective). */
  @Column({ type: 'varchar', length: 10 })
  direction: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  amount: number;

  /** 'INR' | 'COIN' */
  @Column({ type: 'varchar', length: 10, default: 'INR' })
  unit: string;

  /** 'pending' | 'success' | 'failed' */
  @Column({ type: 'varchar', length: 12, default: 'success' })
  @Index()
  status: string;

  /** 'cashfree' | 'razorpayx' | 'hdfc' | 'wallet' | 'internal' */
  @Column({ type: 'varchar', length: 20, nullable: true })
  gateway: string | null;

  /** Gateway reference — order id / payment id / link id / payout id. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  @Index()
  gateway_ref: string | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  booking_id: string | null;

  /** Resulting balance (wallet / coins) after this movement, when known. */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  balance_after: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  /** Free-form extra context (ids, fare breakdown, etc.). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  @Index()
  created_at: Date;
}
