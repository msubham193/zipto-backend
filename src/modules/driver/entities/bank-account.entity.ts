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
import { DriverProfile } from './driver-profile.entity';

export enum AccountType {
  SAVINGS = 'savings',
  CURRENT = 'current',
}

@Entity('driver_bank_accounts')
export class BankAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  driver_profile_id: string;

  @ManyToOne(() => DriverProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'driver_profile_id' })
  driver_profile: DriverProfile;

  @Column({ type: 'varchar', length: 200 })
  account_holder_name: string;

  @Column({ type: 'varchar', length: 100 })
  bank_name: string;

  @Column({ type: 'varchar', length: 30 })
  account_number: string;

  @Column({ type: 'varchar', length: 11 })
  ifsc_code: string;

  @Column({ type: 'varchar', length: 200 })
  branch: string;

  @Column({ type: 'enum', enum: AccountType, default: AccountType.SAVINGS })
  account_type: AccountType;

  @Column({ type: 'boolean', default: false })
  is_primary: boolean;

  @Column({ type: 'boolean', default: false })
  is_verified: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
