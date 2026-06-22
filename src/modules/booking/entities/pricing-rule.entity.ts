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
  base_fare: number; // Fixed starting charge for the trip

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  base_distance_km: number; // Retained for compatibility; public pricing uses full-distance per-km

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  per_km_rate: number; // Rate per KM for the full trip distance

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  per_minute_rate: number; // Legacy field; time cost is not part of the active pricing formula

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  minimum_fare: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 1.0 })
  surge_multiplier: number;

  // --- Waiting Time ---

  @Column({ type: 'integer', default: 70 })
  free_waiting_minutes: number; // Free waiting time before charges

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 2.0 })
  waiting_charge_per_minute: number; // Per-minute charge after free time

  // --- Description ---

  @Column({ type: 'varchar', length: 255, nullable: true })
  best_for: string;

  // --- Additional Charges ---

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 15.0 })
  night_surcharge_percent: number; // % increase for 11PM-6AM

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 30.0 })
  multi_stop_fee: number; // Fee per extra drop-off

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 200.0 })
  helper_charge_per_person: number; // Loading/unloading per helper

  // --- Capacity (kg) — supports decimals, e.g. 0.1 ---

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  capacity_min: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  capacity_max: number | null;

  // --- Commission ---

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 25.0 })
  commission_percent: number; // Platform commission from driver earnings

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
