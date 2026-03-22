import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { Booking } from '../../booking/entities/booking.entity';

export enum ReportType {
  DRIVER_REPORT = 'driver_report',
  AUTO_CANCELLATION_RATE = 'auto_cancellation_rate',
  AUTO_RAPID_BOOKING = 'auto_rapid_booking',
  AUTO_POST_ACCEPT_CANCEL = 'auto_post_accept_cancel',
}

export enum ReportSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

@Entity('customer_reports')
export class CustomerReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  customer_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: User;

  @Column({ type: 'uuid', nullable: true })
  reported_by: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reported_by' })
  reporter: User;

  @Column({ type: 'uuid', nullable: true })
  booking_id: string;

  @ManyToOne(() => Booking, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  @Column({ type: 'enum', enum: ReportType })
  report_type: ReportType;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'enum', enum: ReportSeverity, default: ReportSeverity.MEDIUM })
  severity: ReportSeverity;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'boolean', default: false })
  is_resolved: boolean;

  @Column({ type: 'uuid', nullable: true })
  resolved_by: string;

  @Column({ type: 'timestamp', nullable: true })
  resolved_at: Date;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
