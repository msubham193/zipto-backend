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
import { User } from '../../auth/entities/user.entity';
import { Booking } from '../../booking/entities/booking.entity';

export enum DriverFraudType {
  DELIVERY_ABANDONED = 'delivery_abandoned',
  SLA_BREACH = 'sla_breach',
  GPS_GHOST = 'gps_ghost',
}

export enum DriverFraudStatus {
  SUSPECTED = 'suspected',
  CONFIRMED = 'confirmed',
  CLEARED = 'cleared',
}

export enum DriverFraudDetectedBy {
  SOCKET_DISCONNECT = 'socket_disconnect',
  SLA_DEADLINE = 'sla_deadline',
  GPS_CRON = 'gps_cron',
}

@Entity('driver_fraud_incidents')
export class DriverFraudIncident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  booking_id: string;

  @ManyToOne(() => Booking, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  @Column({ type: 'uuid' })
  @Index()
  driver_id: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'driver_id' })
  driver: User;

  @Column({ type: 'enum', enum: DriverFraudType })
  type: DriverFraudType;

  @Column({
    type: 'enum',
    enum: DriverFraudStatus,
    default: DriverFraudStatus.SUSPECTED,
  })
  @Index()
  status: DriverFraudStatus;

  @Column({ type: 'enum', enum: DriverFraudDetectedBy })
  detected_by: DriverFraudDetectedBy;

  @Column({ type: 'text', nullable: true })
  admin_notes: string;

  @Column({ type: 'uuid', nullable: true })
  resolved_by: string;

  @Column({ type: 'timestamp', nullable: true })
  resolved_at: Date;

  @CreateDateColumn()
  detected_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}