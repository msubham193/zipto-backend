import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * One row per booking search attempt (matched or not) — the `bookings` table
 * only ever gets a row once a driver accepts, so it can't tell you where
 * demand exists but no driver was found. This table captures every attempt
 * at the moment the offer is created, purely to power the rider-facing
 * demand heatmap (see BookingService.getDemandHeatmap). Not used for any
 * booking business logic.
 */
@Entity('booking_demand_logs')
@Index('idx_demand_log_created', ['created_at'])
export class BookingDemandLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  offer_id: string;

  @Column({ type: 'decimal', precision: 9, scale: 6 })
  latitude: number;

  @Column({ type: 'decimal', precision: 9, scale: 6 })
  longitude: number;

  @Column({ type: 'varchar', length: 30, nullable: true })
  vehicle_type: string | null;

  /** Estimated fare at request time — lets the hotspot heatmap estimate
   *  earnings/hour for an area without a separate query against `bookings`
   *  (which would miss unmatched requests entirely). */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  estimated_fare: number | null;

  /** Flipped to true (fire-and-forget) once a driver accepts this offer. */
  @Column({ type: 'boolean', default: false })
  matched: boolean;

  @CreateDateColumn()
  created_at: Date;
}
