import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Exclude } from 'class-transformer';

export enum UserRole {
  CUSTOMER = 'customer',
  DRIVER = 'driver',
  ADMIN = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 15, unique: true, nullable: true })
  @Index()
  phone: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name: string;

  @Column({ type: 'varchar', length: 100, unique: true, nullable: true })
  @Index()
  email: string;

  @Column({
    type: 'enum',
    enum: UserRole,
  })
  @Index()
  role: UserRole;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Exclude()
  password_hash: string;

  @Column({ type: 'boolean', default: false })
  is_verified: boolean;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  // Self-service account deletion (soft delete + PII scrub). The row is kept so
  // bookings/payments/ledger references stay valid for accounting & legal, but
  // PII is anonymized and the account can no longer log in.
  @Column({ type: 'boolean', default: false })
  @Index()
  is_deleted: boolean;

  @Column({ type: 'timestamp', nullable: true })
  deleted_at: Date | null;

  @Column({ type: 'boolean', default: false })
  is_profile_complete: boolean;

  @Column({ type: 'integer', default: 0 })
  coins: number;

  /** This user's own shareable referral code (generated lazily on first use). */
  @Column({ type: 'varchar', length: 12, unique: true, nullable: true })
  @Index()
  referral_code: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  wallet_balance: number;

  @Column({ type: 'varchar', length: 10, default: 'en' })
  language_preference: string;

  @Column({ type: 'text', nullable: true })
  @Exclude()
  refresh_token: string;

  @Column({ type: 'text', nullable: true })
  fcm_token: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
