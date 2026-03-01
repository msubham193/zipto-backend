import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { VehicleType } from '../../vehicle/entities/vehicle.entity';

@Entity('pricing_rules')
export class PricingRule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: VehicleType,
  })
  @Index()
  vehicle_type: VehicleType;

  // --- Core Fare ---

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  base_fare: number; // Fixed charge for first base_distance_km

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 2.0 })
  base_distance_km: number; // KMs included in base fare

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  per_km_rate: number; // Rate per KM beyond base distance

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  per_minute_rate: number; // Trip duration charge per minute

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  minimum_fare: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 1.0 })
  surge_multiplier: number;

  // --- Waiting Time ---

  @Column({ type: 'integer', default: 70 })
  free_waiting_minutes: number; // Free waiting time before charges

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 2.0 })
  waiting_charge_per_minute: number; // Per-minute charge after free time

  // --- Additional Charges ---

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 15.0 })
  night_surcharge_percent: number; // % increase for 11PM-6AM

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 30.0 })
  multi_stop_fee: number; // Fee per extra drop-off

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 300.0 })
  helper_charge_per_person: number; // Loading/unloading per helper

  // --- Commission ---

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 30.0 })
  commission_percent: number; // Skido's commission from driver earnings

  // --- Metadata ---

  @Column({ type: 'varchar', length: 50, default: 'Bhubaneswar' })
  @Index()
  city: string;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
