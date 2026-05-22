import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';

import { User } from '../../auth/entities/user.entity';
import { Vehicle, VehicleType } from '../../vehicle/entities/vehicle.entity';
import { Payment } from '../../payment/entities/payment.entity';

export enum ServiceCategory {
  SEND_PACKAGES = 'send_packages',
  TRANSPORT_GOODS = 'transport_goods',
  FOOD_DELIVERY = 'food_delivery',
  MEDICINE = 'medicine',
}

export enum BookingType {
  INSTANT = 'instant',
  SCHEDULED = 'scheduled',
}

export enum BookingStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DRIVER_ASSIGNED = 'driver_assigned',
  ONGOING = 'ongoing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum PaidBy {
  SENDER = 'sender',
  RECEIVER = 'receiver',
}

@Entity('bookings')
@Index('idx_booking_driver_status', ['driver_id', 'status'])
@Index('idx_booking_customer_status', ['customer_id', 'status'])
@Index('idx_booking_status_created', ['status', 'booking_time'])
@Index('idx_booking_ongoing_flagged', ['status', 'is_flagged'])
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  customer_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  driver_id: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'driver_id' })
  driver: User;

  @Column({ type: 'uuid', nullable: true })
  original_driver_id: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'original_driver_id' })
  original_driver: User;

  @Column({ type: 'integer', default: 0 })
  handoff_count: number;

  @Column({ type: 'uuid', nullable: true })
  vehicle_id: string;

  @ManyToOne(() => Vehicle)
  @JoinColumn({ name: 'vehicle_id' })
  vehicle: Vehicle;

  @Column({ type: 'enum', enum: VehicleType, nullable: true })
  vehicle_type: VehicleType; // Required vehicle type chosen by customer

  @Column({ type: 'varchar', length: 100, default: '' })
  name: string;

  @Column({ type: 'varchar', length: 15, default: '' })
  mobile_number: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  receiver_name: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  receiver_phone: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  alternative_phone: string;

  @Column({
    type: 'enum',
    enum: PaidBy,
    default: PaidBy.SENDER,
  })
  paid_by: PaidBy;

  @Column({ type: 'varchar', length: 6, nullable: true })
  pickup_otp: string;

  @Column({ type: 'boolean', default: false })
  pickup_otp_verified: boolean;

  @Column({ type: 'varchar', length: 6, nullable: true })
  delivery_otp: string;

  @Column({ type: 'boolean', default: false })
  otp_verified: boolean;

  @Column({ type: 'varchar', length: 100, default: '' })
  city: string;

  @Column({
    type: 'enum',
    enum: ServiceCategory,
    default: ServiceCategory.SEND_PACKAGES,
  })
  service_category: ServiceCategory;

  @Column({
    type: 'enum',
    enum: BookingType,
    default: BookingType.INSTANT,
  })
  booking_type: BookingType;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  @Index({ spatial: true })
  pickup_location: string;

  @Column({ type: 'text' })
  pickup_address: string;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  @Index({ spatial: true })
  drop_location: string;

  @Column({ type: 'text' })
  drop_address: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  distance: number; // in km

  @Column({ type: 'integer', nullable: true })
  duration: number; // in minutes

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  estimated_fare: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  final_fare: number;

  // --- Zipto Coins Discount ---
  @Column({ type: 'integer', default: 0 })
  coins_redeemed: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  coin_discount: number;

  // --- Fare Breakdown & Additional Charges ---

  @Column({ type: 'jsonb', nullable: true })
  fare_breakdown: {
    base_fare: number;
    base_distance_km: number;
    distance_charge: number;
    time_charge: number;
    helper_charge: number;
    multi_stop_charge: number;
    demand_adjustment: number;
    night_surcharge: number;
    waiting_charge: number;
    toll_amount: number;
    surge_multiplier: number;
    subtotal: number;
    minimum_fare_applied: boolean;
    skido_commission: number;
    platform_fee: number;
    shield_fee: number;
    driver_earnings: number;
  };

  @Column({ type: 'integer', default: 0 })
  number_of_helpers: number;

  @Column({ type: 'integer', default: 0 })
  extra_stops_count: number;

  @Column({ type: 'boolean', default: false })
  is_night_booking: boolean;

  @Column({ type: 'integer', default: 0 })
  waiting_time_minutes: number; // Actual waiting time recorded by driver

  @Column({ type: 'boolean', default: false })
  has_toll: boolean;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  toll_amount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  skido_commission: number; // Platform commission from the final fare

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  driver_earnings: number; // Driver's share after platform commission

  // --- Status & Timing ---

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING,
  })
  @Index()
  status: BookingStatus;

  @Column({ type: 'timestamp', nullable: true })
  scheduled_time: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  @Index()
  booking_time: Date;

  @Column({ type: 'timestamp', nullable: true })
  acceptance_time: Date;

  @Column({ type: 'timestamp', nullable: true })
  start_time: Date;

  @Column({ type: 'timestamp', nullable: true })
  completion_time: Date;

  @Column({ type: 'text', nullable: true })
  cancellation_reason: string;

  // ─── Fraud / abandonment tracking ────────────────────────────────────────────

  @Column({ type: 'timestamp', nullable: true })
  pickup_verified_at: Date;

  @Column({ type: 'boolean', default: false })
  @Index()
  is_flagged: boolean;

  @Column({ type: 'varchar', length: 50, nullable: true })
  flag_reason: string;

  @Column({ type: 'timestamp', nullable: true })
  flagged_at: Date;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => Payment, (payment) => payment.booking)
  payments: Payment[];
}
