import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { DriverProfile } from './driver-profile.entity';
import { BankAccount } from './bank-account.entity';

export enum WithdrawalStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
}

@Entity('driver_withdrawal_requests')
export class WithdrawalRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  driver_profile_id: string;

  @ManyToOne(() => DriverProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driver_profile_id' })
  driver_profile: DriverProfile;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'enum', enum: WithdrawalStatus, default: WithdrawalStatus.PENDING })
  status: WithdrawalStatus;

  @Column({ type: 'uuid', nullable: true })
  bank_account_id: string;

  @ManyToOne(() => BankAccount, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'bank_account_id' })
  bank_account: BankAccount;

  @Column({ type: 'text', nullable: true })
  remarks: string;

  /** UTR / NEFT / IMPS reference recorded by admin after manual bank transfer */
  @Column({ type: 'varchar', length: 100, nullable: true })
  payout_reference: string | null;

  /** Razorpay payout ID — set when automated payout is initiated via RazorpayX */
  @Column({ type: 'varchar', length: 100, nullable: true })
  payout_id: string | null;

  /** Failure reason from Razorpay if payout failed or was reversed */
  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
