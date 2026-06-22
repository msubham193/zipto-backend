import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { BankAccount } from './bank-account.entity';

export enum VerificationStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum AvailabilityStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  BUSY = 'busy',
}

@Entity('driver_profiles')
export class DriverProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  user_id: string;

  @OneToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 50, nullable: true })
  license_number: string;

  @Column({ type: 'date', nullable: true })
  license_expiry: Date;

  @Column({ type: 'varchar', nullable: true })
  aadhar_front_image: string;

  @Column({ type: 'varchar', nullable: true })
  aadhar_back_image: string;

  @Column({ type: 'varchar', nullable: true })
  driving_license_image: string;

  @Column({ type: 'varchar', nullable: true })
  vehicle_rc_image: string;

  @Column({ type: 'varchar', nullable: true })
  profile_image: string;

  @Column({ type: 'uuid', nullable: true })
  vehicle_id: string;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  @Index()
  verification_status: VerificationStatus;

  // Why the admin rejected KYC (shown to the rider + on the KYC page). Cleared on approval.
  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({
    type: 'enum',
    enum: AvailabilityStatus,
    default: AvailabilityStatus.OFFLINE,
  })
  @Index()
  availability_status: AvailabilityStatus;

  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  @Index({ spatial: true })
  current_location: string; // Will store as GeoJSON Point

  // Timestamp of the last GPS ping. Dispatch only matches drivers whose location
  // is fresh, so a driver who logged out / killed the app / drove away (and
  // stopped pinging) is never offered a booking on a stale location.
  @Column({ type: 'timestamp', nullable: true })
  @Index()
  last_location_at: Date | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  wallet_balance: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  average_rating: number;

  @Column({ type: 'varchar', nullable: true })
  address: string;

  @Column({ type: 'integer', default: 0 })
  total_trips: number;

  @Column({ type: 'boolean', default: false })
  wallet_frozen: boolean;

  @Column({ type: 'varchar', nullable: true })
  wallet_freeze_reason: string;

  @OneToMany(() => BankAccount, (ba) => ba.driver_profile)
  bank_accounts: BankAccount[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
