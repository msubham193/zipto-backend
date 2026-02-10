import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum CoinTransactionType {
  EARNED = 'earned',
  REDEEMED = 'redeemed',
}

@Entity('coin_transactions')
export class CoinTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  user_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'integer' })
  coins: number;

  @Column({
    type: 'enum',
    enum: CoinTransactionType,
  })
  type: CoinTransactionType;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  booking_id: string;

  @Column({ type: 'varchar', length: 255 })
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  distance_km: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  order_amount: number;

  @Column({ type: 'decimal', precision: 4, scale: 2, default: 1 })
  multiplier: number;

  @CreateDateColumn()
  created_at: Date;
}
