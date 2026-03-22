import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum BlockStatus {
  ACTIVE = 'active',
  LIFTED = 'lifted',
  EXPIRED = 'expired',
}

export enum UnblockRequestStatus {
  NONE = 'none',
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('user_blocks')
export class UserBlock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  customer_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ type: 'uuid', nullable: true })
  blocked_by: string;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'int' })
  duration_days: number;

  @Column({ type: 'timestamp' })
  @Index()
  blocked_until: Date;

  @Column({ type: 'enum', enum: BlockStatus, default: BlockStatus.ACTIVE })
  status: BlockStatus;

  @Column({ type: 'uuid', nullable: true })
  lifted_by: string;

  @Column({ type: 'timestamp', nullable: true })
  lifted_at: Date;

  @Column({ type: 'text', nullable: true })
  unblock_request_reason: string;

  @Column({ type: 'timestamp', nullable: true })
  unblock_request_at: Date;

  @Column({ type: 'enum', enum: UnblockRequestStatus, default: UnblockRequestStatus.NONE })
  unblock_request_status: UnblockRequestStatus;

  @Column({ type: 'text', nullable: true })
  admin_notes: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
