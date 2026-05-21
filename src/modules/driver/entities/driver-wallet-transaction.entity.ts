import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum DriverWalletTxnType {
  TRIP_EARNINGS_CREDIT = 'trip_earnings_credit',  // online/QR trip — driver's share credited
  CASH_COMMISSION_DEDUCTION = 'cash_commission_deduction',  // cash trip — commission+shield debited
  TOPUP = 'topup',                  // driver tops up via Razorpay
  WITHDRAWAL = 'withdrawal',        // approved payout to driver bank
  ADMIN_CREDIT = 'admin_credit',
  ADMIN_DEBIT = 'admin_debit',
}

@Entity('driver_wallet_transactions')
export class DriverWalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  driver_user_id: string;

  @Column({ type: 'enum', enum: DriverWalletTxnType })
  type: DriverWalletTxnType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  /** Wallet balance after this transaction (for statement view) */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  balance_after: number;

  @Column({ type: 'varchar', length: 300 })
  description: string;

  /** booking_id for trip-related transactions */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  booking_id: string | null;

  /** Razorpay order/payment id for topups */
  @Column({ type: 'varchar', length: 100, nullable: true })
  reference_id: string | null;

  @CreateDateColumn()
  created_at: Date;
}
