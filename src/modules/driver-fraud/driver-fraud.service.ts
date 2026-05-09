import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import {
  DriverFraudIncident,
  DriverFraudDetectedBy,
  DriverFraudStatus,
  DriverFraudType,
} from './entities/driver-fraud-incident.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { User } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { NotificationService } from '../notification/notification.service';

type DetectedBy = 'socket_disconnect' | 'sla_deadline' | 'gps_cron';

const DETECTED_BY_MAP: Record<DetectedBy, DriverFraudDetectedBy> = {
  socket_disconnect: DriverFraudDetectedBy.SOCKET_DISCONNECT,
  sla_deadline:     DriverFraudDetectedBy.SLA_DEADLINE,
  gps_cron:         DriverFraudDetectedBy.GPS_CRON,
};

const TYPE_MAP: Record<DetectedBy, DriverFraudType> = {
  socket_disconnect: DriverFraudType.DELIVERY_ABANDONED,
  sla_deadline:     DriverFraudType.SLA_BREACH,
  gps_cron:         DriverFraudType.GPS_GHOST,
};

@Injectable()
export class DriverFraudService implements OnModuleInit {
  private readonly logger = new Logger(DriverFraudService.name);
  private notificationService: NotificationService;

  constructor(
    @InjectRepository(DriverFraudIncident)
    private incidentRepository: Repository<DriverFraudIncident>,
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    private moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    this.notificationService = this.moduleRef.get(NotificationService, { strict: false });
  }

  /**
   * Called by any of the 3 guards when abandonment is suspected.
   * Idempotent — will not create a duplicate incident for the same booking.
   */
  async createIncidentAndFreezeWallet(
    bookingId: string,
    driverId: string,
    detectedBy: DetectedBy,
  ): Promise<DriverFraudIncident | null> {
    // Idempotency: skip if an unresolved incident already exists for this booking
    const existing = await this.incidentRepository.findOne({
      where: { booking_id: bookingId, status: DriverFraudStatus.SUSPECTED },
    });
    if (existing) {
      this.logger.debug(
        `[DriverFraud] Incident already exists for booking=${bookingId}, skipping`,
      );
      return null;
    }

    // Freeze driver wallet
    await this.driverProfileRepository.update(
      { user_id: driverId },
      { wallet_frozen: true, wallet_freeze_reason: `Suspected abandonment: ${detectedBy}` },
    );

    const incident = this.incidentRepository.create({
      booking_id: bookingId,
      driver_id: driverId,
      type: TYPE_MAP[detectedBy],
      detected_by: DETECTED_BY_MAP[detectedBy],
      status: DriverFraudStatus.SUSPECTED,
    });
    const saved = await this.incidentRepository.save(incident);

    this.logger.warn(
      `[DriverFraud] Incident created: id=${saved.id} booking=${bookingId} driver=${driverId} by=${detectedBy}`,
    );

    // Push FCM notification to driver (informational — they may have genuine connectivity issues)
    if (this.notificationService) {
      this.notificationService
        .push(driverId, 'general', 'Active Delivery Alert',
          'You have an active delivery that has not been completed. Please reconnect immediately.',
          { type: 'delivery_investigation', bookingId })
        .catch(() => {});
    }

    return saved;
  }

  /**
   * Admin confirms fraud: ban driver, cancel booking, record resolution.
   */
  async confirmFraud(incidentId: string, adminId: string, notes?: string) {
    const incident = await this.incidentRepository.findOne({
      where: { id: incidentId },
    });
    if (!incident) throw new NotFoundException('Incident not found');
    if (incident.status !== DriverFraudStatus.SUSPECTED) {
      throw new BadRequestException(`Incident is already ${incident.status}`);
    }

    // Ban driver account
    await this.userRepository.update(incident.driver_id, { is_active: false });

    // Cancel the booking (set to cancelled)
    await this.bookingRepository.update(
      { id: incident.booking_id },
      { status: BookingStatus.CANCELLED, cancellation_reason: 'Driver abandoned delivery — confirmed fraud' },
    );

    // Resolve incident
    incident.status = DriverFraudStatus.CONFIRMED;
    if (notes !== undefined) incident.admin_notes = notes;
    incident.resolved_by = adminId;
    incident.resolved_at = new Date();
    await this.incidentRepository.save(incident);

    this.logger.warn(
      `[DriverFraud] Fraud CONFIRMED: incident=${incidentId} driver=${incident.driver_id} by admin=${adminId}`,
    );

    return { message: 'Fraud confirmed. Driver banned and booking cancelled.', incident };
  }

  /**
   * Admin clears a false-positive incident: unfreeze wallet, unflag booking.
   */
  async clearIncident(incidentId: string, adminId: string, notes?: string) {
    const incident = await this.incidentRepository.findOne({
      where: { id: incidentId },
    });
    if (!incident) throw new NotFoundException('Incident not found');
    if (incident.status !== DriverFraudStatus.SUSPECTED) {
      throw new BadRequestException(`Incident is already ${incident.status}`);
    }

    // Unfreeze driver wallet
    await this.driverProfileRepository
      .createQueryBuilder()
      .update()
      .set({ wallet_frozen: false, wallet_freeze_reason: () => 'NULL' })
      .where('user_id = :uid', { uid: incident.driver_id })
      .execute();

    // Unflag booking
    await this.bookingRepository
      .createQueryBuilder()
      .update()
      .set({ is_flagged: false, flag_reason: () => 'NULL', flagged_at: () => 'NULL' })
      .where('id = :id', { id: incident.booking_id })
      .execute();

    // Resolve incident
    incident.status = DriverFraudStatus.CLEARED;
    if (notes !== undefined) incident.admin_notes = notes;
    incident.resolved_by = adminId;
    incident.resolved_at = new Date();
    await this.incidentRepository.save(incident);

    this.logger.log(
      `[DriverFraud] Incident CLEARED (false positive): incident=${incidentId} driver=${incident.driver_id} by admin=${adminId}`,
    );

    // Notify driver wallet is unfrozen
    if (this.notificationService) {
      this.notificationService
        .push(incident.driver_id, 'general', 'Account Cleared',
          'Your account investigation has been resolved. Your wallet has been unfrozen.',
          { type: 'account_cleared', bookingId: incident.booking_id })
        .catch(() => {});
    }

    return { message: 'Incident cleared. Driver wallet unfrozen and booking unflagged.', incident };
  }

  // ─── Intelligent Fraud Detection ─────────────────────────────────────────────

  /**
   * Aggregate overview stats for the admin intelligence dashboard.
   */
  async getIntelligenceOverview() {
    const [totalSuspected, totalConfirmed, totalCleared, flaggedActive, recentIncidents] =
      await Promise.all([
        this.incidentRepository.count({ where: { status: DriverFraudStatus.SUSPECTED } }),
        this.incidentRepository.count({ where: { status: DriverFraudStatus.CONFIRMED } }),
        this.incidentRepository.count({ where: { status: DriverFraudStatus.CLEARED } }),
        this.bookingRepository.count({
          where: { status: BookingStatus.ONGOING, is_flagged: true },
        }),
        this.incidentRepository.find({
          where: { status: DriverFraudStatus.SUSPECTED },
          order: { detected_at: 'DESC' },
          take: 5,
          relations: ['driver', 'booking'],
        }),
      ]);

    return {
      total_suspected: totalSuspected,
      total_confirmed: totalConfirmed,
      total_cleared: totalCleared,
      flagged_active_deliveries: flaggedActive,
      recent_incidents: recentIncidents,
    };
  }

  /**
   * Risk-scored list of drivers who have at least one fraud incident.
   * Score 0–100: higher = more dangerous.
   */
  async getDriverRiskScores(limit = 20) {
    const rows: Array<Record<string, any>> = await this.incidentRepository.manager.query(
      `SELECT
          dp.user_id                                                        AS driver_id,
          u.name                                                            AS driver_name,
          u.phone                                                           AS driver_phone,
          dp.total_trips,
          dp.wallet_frozen,
          dp.average_rating,
          COUNT(CASE WHEN dfi.status = 'confirmed'         THEN 1 END)::int AS confirmed_count,
          COUNT(CASE WHEN dfi.status = 'suspected'         THEN 1 END)::int AS suspected_count,
          COUNT(CASE WHEN dfi.detected_by = 'gps_cron'    THEN 1 END)::int AS gps_ghost_count,
          COUNT(CASE WHEN dfi.detected_by = 'sla_deadline' THEN 1 END)::int AS sla_breach_count,
          COUNT(CASE WHEN dfi.detected_by = 'socket_disconnect' THEN 1 END)::int AS disconnect_count
        FROM driver_profiles dp
        JOIN users u ON u.id = dp.user_id
        LEFT JOIN driver_fraud_incidents dfi ON dfi.driver_id = dp.user_id
        GROUP BY dp.user_id, u.name, u.phone, dp.total_trips, dp.wallet_frozen, dp.average_rating
        HAVING COUNT(dfi.id) > 0
        LIMIT $1`,
      [limit],
    );

    const scored = rows.map((row) => {
      const raw =
        row.confirmed_count * 30 +
        row.suspected_count * 15 +
        row.gps_ghost_count * 20 +
        row.sla_breach_count * 20 +
        (row.wallet_frozen ? 20 : 0) -
        Math.min(30, Math.floor((row.total_trips || 0) / 10) * 5);

      return {
        driver_id: row.driver_id,
        driver_name: row.driver_name,
        driver_phone: row.driver_phone,
        total_trips: row.total_trips,
        wallet_frozen: row.wallet_frozen,
        average_rating: row.average_rating ? parseFloat(row.average_rating) : null,
        risk_score: Math.max(0, Math.min(100, raw)),
        breakdown: {
          confirmed_incidents: row.confirmed_count,
          suspected_incidents: row.suspected_count,
          gps_ghost_events: row.gps_ghost_count,
          sla_breaches: row.sla_breach_count,
          disconnect_events: row.disconnect_count,
        },
      };
    });

    return scored.sort((a, b) => b.risk_score - a.risk_score);
  }

  /**
   * Active deliveries that have been flagged by any guard but not yet resolved.
   */
  async getFlaggedActiveBookings() {
    return this.bookingRepository.find({
      where: { status: BookingStatus.ONGOING, is_flagged: true },
      relations: ['driver', 'customer'],
      order: { flagged_at: 'DESC' },
      take: 50,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * List driver fraud incidents for admin.
   */
  async listIncidents(filters: {
    status?: DriverFraudStatus;
    driver_id?: string;
    limit?: number;
    offset?: number;
  }) {
    const { status, driver_id, limit = 20, offset = 0 } = filters;

    const qb = this.incidentRepository
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.driver', 'driver')
      .leftJoinAndSelect('i.booking', 'booking')
      .orderBy('i.detected_at', 'DESC')
      .take(limit)
      .skip(offset);

    if (status) qb.andWhere('i.status = :status', { status });
    if (driver_id) qb.andWhere('i.driver_id = :driver_id', { driver_id });

    const [items, total] = await qb.getManyAndCount();
    return { items, total, limit, offset };
  }

  /**
   * Get a single incident.
   */
  async getIncident(incidentId: string) {
    const incident = await this.incidentRepository.findOne({
      where: { id: incidentId },
      relations: ['driver', 'booking'],
    });
    if (!incident) throw new NotFoundException('Incident not found');
    return incident;
  }
}