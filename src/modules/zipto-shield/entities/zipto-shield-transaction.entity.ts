import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum ShieldTransactionType {
  CONTRIBUTION = 'contribution',
  WITHDRAWAL   = 'withdrawal',
}

@Entity('zipto_shield_transactions')
export class ZiptoShieldTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: ShieldTransactionType })
  @Index()
  type: ShieldTransactionType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  balance_after: number;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  booking_id: string;

  @Column({ type: 'uuid', nullable: true })
  withdrawn_by: string;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @CreateDateColumn()
  @Index()
  created_at: Date;
}