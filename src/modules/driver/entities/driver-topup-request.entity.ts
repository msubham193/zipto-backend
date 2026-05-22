import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

export enum TopupRequestStatus {
  PENDING  = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('driver_topup_requests')
export class DriverTopupRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  driver_user_id: string;

  @Column({ type: 'uuid' })
  @Index()
  driver_profile_id: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 50, unique: true })
  utr_number: string;

  @Column({ type: 'enum', enum: TopupRequestStatus, default: TopupRequestStatus.PENDING })
  @Index()
  status: TopupRequestStatus;

  @Column({ type: 'text', nullable: true })
  remarks: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
