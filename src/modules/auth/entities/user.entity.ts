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

  // Root super-admin. Only this account may create/manage other admins.
  // Seeded for the configured SUPER_ADMIN_EMAIL on boot.
  @Column({ type: 'boolean', default: false })
  is_super_admin: boolean;

  // Forces a password reset on next login (set for freshly-invited admins who
  // received a temporary password). Cleared once they set their own password.
  @Column({ type: 'boolean', default: false })
  must_change_password: boolean;

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

  // Indian state, derived by reverse-geocoding the user's location (driver's
  // live GPS / customer's booking pickup) and populated once. Null until we
  // have a location to derive it from. Used for the admin state-wise views.
  @Column({ type: 'varchar', length: 60, nullable: true })
  @Index()
  state: string | null;

  @Column({ type: 'text', nullable: true })
  @Exclude()
  refresh_token: string | null;

  // Single active session for drivers: rotated on every login and embedded in
  // the JWT as `sid`. A token whose sid ≠ this is rejected, so logging in on a
  // new device instantly signs the previous device out. Null until first login
  // after this was introduced (so existing sessions aren't force-killed).
  @Column({ type: 'varchar', length: 64, nullable: true })
  @Exclude()
  active_session_id: string | null;

  @Column({ type: 'text', nullable: true })
  fcm_token: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
