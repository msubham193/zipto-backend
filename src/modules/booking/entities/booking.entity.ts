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
import { User } from '../../auth/entities/user.entity';
import { Vehicle } from '../../vehicle/entities/vehicle.entity';

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

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  customer_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  driver_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'driver_id' })
  driver: User;

  @Column({ type: 'uuid', nullable: true })
  vehicle_id: string;

  @ManyToOne(() => Vehicle)
  @JoinColumn({ name: 'vehicle_id' })
  vehicle: Vehicle;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 15 })
  mobile_number: string;

  @Column({ type: 'varchar', length: 100 })
  city: string;

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
  distance: number;  // in km

  @Column({ type: 'integer', nullable: true })
  duration: number;  // in minutes

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  estimated_fare: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  final_fare: number;

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

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
