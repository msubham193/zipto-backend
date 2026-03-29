import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum WalletTxnType {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

export enum WalletTxnSource {
  RAZORPAY = 'razorpay',
  BOOKING_PAYMENT = 'booking_payment',
  REFUND = 'refund',
  CASHBACK = 'cashback',
  ADMIN = 'admin',
}

@Entity('wallet_transactions')
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: WalletTxnType })
  type: WalletTxnType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  balance_after: number;

  @Column({ type: 'varchar', length: 255 })
  description: string;

  @Column({ type: 'enum', enum: WalletTxnSource, default: WalletTxnSource.ADMIN })
  source: WalletTxnSource;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reference_id: string | null;

  @CreateDateColumn()
  created_at: Date;
}
