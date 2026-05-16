import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

@Entity('zipto_shield_ledger')
export class ZiptoShieldLedger {
  @PrimaryColumn({ type: 'varchar', length: 20, default: 'zipto-shield' })
  id: string;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  balance: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  total_contributed: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  total_withdrawn: number;

  @UpdateDateColumn()
  updated_at: Date;
}