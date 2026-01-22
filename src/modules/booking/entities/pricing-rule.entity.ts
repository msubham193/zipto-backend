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

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  base_fare: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  per_km_rate: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  per_minute_rate: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  minimum_fare: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 1.0 })
  surge_multiplier: number;

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
