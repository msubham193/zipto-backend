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
import { Booking } from '../../booking/entities/booking.entity';

export enum PaymentMethod {
  CASH = 'cash',
  UPI = 'upi',
  CARD = 'card',
  WALLET = 'wallet',
}

export enum PaymentStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  booking_id: string;

  @ManyToOne(() => Booking)
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
  })
  payment_method: PaymentMethod;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  @Index()
  payment_status: PaymentStatus;

  @Column({ type: 'varchar', length: 100, nullable: true })
  @Index()
  transaction_id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  razorpay_order_id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  razorpay_payment_id: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  razorpay_signature: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
