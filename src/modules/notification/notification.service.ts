import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { v4 as uuidv4 } from 'uuid';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { BookingGateway } from '../booking/booking.gateway';
import { SendNotificationDto } from './dto/notification.dto';

export type NotificationType =
  | 'approval'
  | 'rejection'
  | 'payment'
  | 'weekly_earnings'
  | 'general';

export type AdminNotificationType =
  | 'driver_registered'
  | 'kyc_submitted'
  | 'vehicle_submitted'
  | 'booking_created'
  | 'booking_completed'
  | 'general';

export interface AdminNotification {
  id: string;
  type: AdminNotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: number;
  read: boolean;
}

export interface DriverNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: number;
  read: boolean;
}

const MAX_NOTIFICATIONS = 50;
const NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private bookingGateway: BookingGateway,
    @InjectRepository(Booking) private bookingRepository: Repository<Booking>,
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Core push / fetch / clear
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Store a notification in Redis and emit it via WebSocket in real-time.
   */
  async push(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<DriverNotification> {
    const notif: DriverNotification = {
      id: uuidv4(),
      type,
      title,
      message,
      data,
      createdAt: Date.now(),
      read: false,
    };

    const key = this.key(userId);
    const existing = await this.cacheManager.get<DriverNotification[]>(key) ?? [];
    const updated = [notif, ...existing].slice(0, MAX_NOTIFICATIONS);
    await this.cacheManager.set(key, updated, NOTIFICATION_TTL_MS);

    // Real-time delivery via existing booking namespace WS
    this.bookingGateway.notifyUser(userId, 'new_notification', notif);

    this.logger.log(`Notification pushed to ${userId}: ${title}`);
    return notif;
  }

  async getForUser(userId: string): Promise<DriverNotification[]> {
    return (await this.cacheManager.get<DriverNotification[]>(this.key(userId))) ?? [];
  }

  async clearForUser(userId: string): Promise<void> {
    await this.cacheManager.del(this.key(userId));
  }

  async markAllRead(userId: string): Promise<void> {
    const notifs = await this.getForUser(userId);
    const updated = notifs.map(n => ({ ...n, read: true }));
    await this.cacheManager.set(this.key(userId), updated, NOTIFICATION_TTL_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Domain helpers (called by AdminService, PaymentService, etc.)
  // ─────────────────────────────────────────────────────────────────────────

  async notifyDriverApproved(userId: string) {
    return this.push(
      userId,
      'approval',
      '🎉 Account Approved!',
      'Your driver account has been verified. You can now go online and accept bookings.',
    );
  }

  async notifyDriverRejected(userId: string) {
    return this.push(
      userId,
      'rejection',
      'Verification Update',
      'Your verification could not be approved. Please re-submit your documents or contact support.',
    );
  }

  async notifyPaymentReceived(userId: string, amount: number, bookingId: string) {
    return this.push(
      userId,
      'payment',
      '💸 Payment Received',
      `₹${amount} has been credited to your account for trip #${bookingId.slice(-6).toUpperCase()}.`,
      { bookingId, amount },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Weekly earnings cron — runs every Monday at 8:00 AM
  // ─────────────────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_WEEK)
  async sendWeeklyEarningsSummaries() {
    this.logger.log('Running weekly earnings cron...');

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const results: Array<{
      driver_id: string;
      total_trips: string;
      total_earnings: string;
    }> = await this.bookingRepository
      .createQueryBuilder('b')
      .select('b.driver_id', 'driver_id')
      .addSelect('COUNT(*)', 'total_trips')
      .addSelect('COALESCE(SUM(b.driver_earnings), SUM(b.estimated_fare), 0)', 'total_earnings')
      .where('b.status = :status', { status: BookingStatus.COMPLETED })
      .andWhere('b.driver_id IS NOT NULL')
      .andWhere('b.created_at >= :from', { from: oneWeekAgo })
      .groupBy('b.driver_id')
      .getRawMany();

    for (const row of results) {
      const trips = parseInt(row.total_trips, 10);
      const earnings = parseFloat(row.total_earnings);
      await this.push(
        row.driver_id,
        'weekly_earnings',
        '📊 Weekly Summary',
        `This week: ${trips} trip${trips !== 1 ? 's' : ''} · ₹${earnings.toFixed(0)} earned. Keep it up!`,
        { trips, earnings },
      );
    }

    this.logger.log(`Weekly summaries sent to ${results.length} drivers.`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Legacy FCM mock (kept for backward compat)
  // ─────────────────────────────────────────────────────────────────────────

  async sendPushNotification(dto: SendNotificationDto) {
    const { user_id, title, body, data } = dto;
    await this.push(user_id, 'general', title, body, data as Record<string, unknown>);
    return { message: 'Notification sent', user_id, title, body };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Admin Notifications (shared inbox for all admins)
  // ─────────────────────────────────────────────────────────────────────────

  async pushAdmin(
    type: AdminNotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<AdminNotification> {
    const notif: AdminNotification = {
      id: uuidv4(),
      type,
      title,
      message,
      data,
      createdAt: Date.now(),
      read: false,
    };

    try {
      const existing = await this.safeGet<AdminNotification[]>(this.adminKey()) ?? [];
      const updated = [notif, ...existing].slice(0, MAX_NOTIFICATIONS);
      await this.safeSet(this.adminKey(), updated);
    } catch (err) {
      this.logger.warn(`[Admin] Failed to persist notification: ${(err as Error).message}`);
    }

    this.logger.log(`[Admin] Notification pushed: ${title}`);
    return notif;
  }

  async getAdminNotifications(): Promise<AdminNotification[]> {
    try {
      return await this.safeGet<AdminNotification[]>(this.adminKey()) ?? [];
    } catch {
      return [];
    }
  }

  async markAdminNotificationsRead(): Promise<void> {
    try {
      const notifs = await this.getAdminNotifications();
      const updated = notifs.map(n => ({ ...n, read: true }));
      await this.safeSet(this.adminKey(), updated);
    } catch {/* non-critical */}
  }

  async clearAdminNotifications(): Promise<void> {
    try {
      await this.cacheManager.del(this.adminKey());
    } catch {/* non-critical */}
  }

  private async safeGet<T>(key: string): Promise<T | undefined> {
    const raw = await (this.cacheManager as any).get(key);
    return raw as T | undefined;
  }

  private async safeSet(key: string, value: unknown): Promise<void> {
    await (this.cacheManager as any).set(key, value, NOTIFICATION_TTL_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────
  private key(userId: string) {
    return `driver_notifications:${userId}`;
  }

  private adminKey() {
    return 'admin_notifications';
  }
}
