import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Coupon } from './coupon.entity';
import { User } from '../../auth/entities/user.entity';

@Entity('coupon_usages')
@Index('idx_coupon_usage_user_coupon', ['user_id', 'coupon_id'])
export class CouponUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  coupon_id: string;

  @ManyToOne(() => Coupon, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coupon_id' })
  coupon: Coupon;

  @Column({ type: 'uuid' })
  @Index()
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Set when the booking is confirmed (driver accepts)
  @Column({ type: 'uuid', nullable: true })
  booking_id: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  discount_applied: number; // actual ₹ saved

  @CreateDateColumn()
  used_at: Date;
}
