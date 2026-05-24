import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum CouponType {
  FLAT       = 'flat',        // fixed ₹ off
  PERCENTAGE = 'percentage',  // % off (capped by max_discount)
  FREE_DELIVERY = 'free_delivery', // makes final fare ₹0
}

@Entity('coupons')
export class Coupon {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  @Index()
  code: string; // e.g. "FIRST50", "FLAT30", case-insensitive on lookup

  @Column({ type: 'varchar', length: 100 })
  title: string; // "Get ₹50 off your first ride"

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'enum', enum: CouponType, default: CouponType.FLAT })
  type: CouponType;

  // For flat: ₹ off. For percentage: e.g. 20 = 20%. For free_delivery: ignored.
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  value: number;

  // Max discount cap for percentage coupons (null = no cap)
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  max_discount: number;

  // Minimum booking fare required to use this coupon
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  min_order_value: number;

  // Total uses across all users (null = unlimited)
  @Column({ type: 'integer', nullable: true })
  max_uses_total: number;

  // Uses per individual user
  @Column({ type: 'integer', default: 1 })
  max_uses_per_user: number;

  // Running counter — incremented atomically when coupon is used
  @Column({ type: 'integer', default: 0 })
  used_count: number;

  @Column({ type: 'timestamp' })
  valid_from: Date;

  // null = never expires
  @Column({ type: 'timestamp', nullable: true })
  valid_until: Date;

  // null = all vehicle types
  @Column({ type: 'jsonb', nullable: true })
  applicable_vehicle_types: string[];

  @Column({ type: 'boolean', default: false })
  is_first_ride_only: boolean; // only usable by customers with 0 prior completed bookings

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
