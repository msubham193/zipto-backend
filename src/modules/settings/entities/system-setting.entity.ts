import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Persisted key-value store for operator-configurable settings.
 * Rows are seeded on first boot and can be updated via admin API.
 */
@Entity('system_settings')
export class SystemSetting {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'text' })
  value: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @UpdateDateColumn()
  updated_at: Date;
}
