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
import { DriverProfile, VerificationStatus } from '../../driver/entities/driver-profile.entity';

export enum VehicleType {
  BIKE = 'bike',
  SCOOTY = 'scooty',
  AUTO = 'auto',
  PICKUP = 'pickup',
  MINI_TRUCK = 'mini_truck',
  // Legacy options kept for backward compatibility if any exist in DB
  THREE_WHEELER = 'three_wheeler',
  TATA_ACE = 'tata_ace',
  PICKUP_8FT = 'pickup_8ft',
  TATA_407 = 'tata_407',
}

@Entity('vehicles')
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  driver_id: string;

  @ManyToOne(() => DriverProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driver_id' })
  driver: DriverProfile;

  @Column({
    type: 'enum',
    enum: VehicleType,
  })
  vehicle_type: VehicleType;

  @Column({ type: 'varchar', length: 20, unique: true })
  @Index()
  registration_number: string;

  @Column({ type: 'integer', nullable: true, default: 0 })
  capacity: number; // in kg (deprecated — kept for DB compatibility)

  @Column({ type: 'varchar', length: 100, nullable: true })
  vehicle_model: string;

  @Column({ type: 'text', nullable: true })
  insurance_details: string;

  @Column({ type: 'text', nullable: true })
  rc_document_url: string;

  @Column({ type: 'text', nullable: true })
  insurance_document_url: string;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  @Index()
  verification_status: VerificationStatus;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
