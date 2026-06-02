import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '../../services/redis.service';
import { FcmService } from '../../services/fcm.service';
import { v4 as uuidv4 } from 'uuid';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { User, UserRole } from '../auth/entities/user.entity';
import { BookingGateway } from '../booking/booking.gateway';
import { SendNotificationDto, BroadcastNotificationDto } from './dto/notification.dto';

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
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private bookingGateway!: BookingGateway;

  constructor(
    private cacheManager: RedisService,
    private fcmService: FcmService,
    private moduleRef: ModuleRef,
    @InjectRepository(Booking) private bookingRepository: Repository<Booking>,
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(User) private userRepository: Repository<User>,
  ) {}

  onModuleInit() {
    this.bookingGateway = this.moduleRef.get(BookingGateway, { strict: false });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FCM Token Registration
  // ─────────────────────────────────────────────────────────────────────────

  async registerFcmToken(userId: string, token: string): Promise<void> {
    await this.userRepository.update(userId, { fcm_token: token });
    this.logger.log(`FCM token registered for user ${userId}`);
  }

  async clearFcmToken(userId: string): Promise<void> {
    await this.userRepository.update(userId, { fcm_token: null });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core push / fetch / clear (driver notifications)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Store a notification in Redis, emit it via WebSocket, and send FCM push.
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

    // 1. Persist in Redis
    const key = this.key(userId);
    const existing = (await this.cacheManager.get<DriverNotification[]>(key)) ?? [];
    const updated = [notif, ...existing].slice(0, MAX_NOTIFICATIONS);
    await this.cacheManager.set(key, updated, NOTIFICATION_TTL_MS);

    // 2. Real-time via WebSocket (app is open)
    this.bookingGateway.notifyUser(userId, 'new_notification', notif);

    // 3. FCM push (app is in background or closed) — fire-and-forget
    // Use high-priority booking channel for new_booking alerts
    const isNewBooking = (data as any)?.type === 'new_booking';
    this.sendFcmToUser(
      userId,
      title,
      message,
      { type, notificationId: notif.id, ...(data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : {}) },
      isNewBooking,
    ).catch(() => {});

    this.logger.log(`Notification pushed to ${userId}: ${title}`);
    return notif;
  }

  /**
   * Batch push to many drivers in a single DB round-trip + one FCM multicast call.
   * Used by broadcastBookingToNearby to avoid N separate DB queries per driver.
   */
  async pushToMany(
    userIds: string[],
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>,
    isNewBooking = false,
  ): Promise<void> {
    if (userIds.length === 0) return;

    const now = Date.now();

    // 1. Store individual notification + WebSocket for each driver (Redis + in-memory)
    for (const userId of userIds) {
      const notif: DriverNotification = {
        id: uuidv4(), type, title, message, data, createdAt: now, read: false,
      };
      const key = this.key(userId);
      const existing = (await this.cacheManager.get<DriverNotification[]>(key)) ?? [];
      await this.cacheManager.set(key, [notif, ...existing].slice(0, MAX_NOTIFICATIONS), NOTIFICATION_TTL_MS);
      this.bookingGateway.notifyUser(userId, 'new_notification', notif);
    }

    // 2. Batch fetch FCM tokens — one DB query for all drivers
    const users = await this.userRepository.find({
      where: { id: In(userIds) },
      select: ['id', 'fcm_token'],
    });
    const tokens = users.map(u => u.fcm_token).filter(Boolean) as string[];
    if (tokens.length === 0) return;

    const dataStr = data
      ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
      : undefined;

    // 3. One batch FCM multicast — uses booking_alert channel when isNewBooking
    const { success, failure } = await this.fcmService.sendToTokens(
      tokens, title, message, dataStr, isNewBooking,
    );
    this.logger.log(
      `[pushToMany] ${userIds.length} drivers — FCM: ${success} ok, ${failure} failed`,
    );
  }

  async getForUser(userId: string): Promise<DriverNotification[]> {
    return (
      (await this.cacheManager.get<DriverNotification[]>(this.key(userId))) ?? []
    );
  }

  async clearForUser(userId: string): Promise<void> {
    await this.cacheManager.del(this.key(userId));
  }

  async markAllRead(userId: string): Promise<void> {
    const notifs = await this.getForUser(userId);
    const updated = notifs.map((n) => ({ ...n, read: true }));
    await this.cacheManager.set(this.key(userId), updated, NOTIFICATION_TTL_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Customer notifications (same structure, different Redis key)
  // ─────────────────────────────────────────────────────────────────────────

  async pushToCustomer(
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

    const key = this.customerKey(userId);
    const existing = (await this.cacheManager.get<DriverNotification[]>(key)) ?? [];
    const updated = [notif, ...existing].slice(0, MAX_NOTIFICATIONS);
    await this.cacheManager.set(key, updated, NOTIFICATION_TTL_MS);

    // WebSocket delivery
    this.bookingGateway.notifyUser(userId, 'new_notification', notif);

    // FCM push — data-only so setBackgroundMessageHandler fires on all OEM devices
    const fcmData: Record<string, string> = { type, notificationId: notif.id };
    if (data) {
      for (const [k, v] of Object.entries(data)) fcmData[k] = String(v);
    }
    this.sendDataOnlyFcmToUser(userId, title, message, fcmData).catch(() => {});

    return notif;
  }

  async getForCustomer(userId: string): Promise<DriverNotification[]> {
    return (
      (await this.cacheManager.get<DriverNotification[]>(this.customerKey(userId))) ?? []
    );
  }

  async clearForCustomer(userId: string): Promise<void> {
    await this.cacheManager.del(this.customerKey(userId));
  }

  async markAllReadForCustomer(userId: string): Promise<void> {
    const notifs = await this.getForCustomer(userId);
    const updated = notifs.map((n) => ({ ...n, read: true }));
    await this.cacheManager.set(
      this.customerKey(userId),
      updated,
      NOTIFICATION_TTL_MS,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Admin broadcast
  // ─────────────────────────────────────────────────────────────────────────

  async broadcast(dto: BroadcastNotificationDto): Promise<{
    target: string;
    fcm: { success: number; failure: number };
    inApp: number;
  }> {
    const { target, user_id, title, body, data } = dto;
    const fcmData = data
      ? Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)]),
        )
      : undefined;

    // --- Specific user ---
    if (target === 'user' && user_id) {
      const user = await this.userRepository.findOne({ where: { id: user_id } });
      if (user?.fcm_token) {
        const ok = await this.fcmService.sendToToken(
          user.fcm_token,
          title,
          body,
          fcmData,
        );
        if (!ok) await this.clearFcmToken(user_id);
      }
      // Also push to in-app inbox
      const type: NotificationType = 'general';
      if (user?.role === UserRole.CUSTOMER) {
        await this.pushToCustomer(user_id, type, title, body, data);
      } else {
        await this.push(user_id, type, title, body, data);
      }
      return { target, fcm: { success: user?.fcm_token ? 1 : 0, failure: 0 }, inApp: 1 };
    }

    // --- Bulk targeting ---
    let roleFilter: UserRole[] = [];
    if (target === 'all') roleFilter = [UserRole.DRIVER, UserRole.CUSTOMER];
    else if (target === 'drivers') roleFilter = [UserRole.DRIVER];
    else if (target === 'customers') roleFilter = [UserRole.CUSTOMER];

    const users = await this.userRepository.find({
      where: { role: In(roleFilter), is_active: true },
      select: ['id', 'role', 'fcm_token'],
    });

    const tokens = users
      .filter((u) => u.fcm_token)
      .map((u) => u.fcm_token as string);

    const fcmResult =
      tokens.length > 0
        ? await this.fcmService.sendToTokens(tokens, title, body, fcmData)
        : { success: 0, failure: 0 };

    // Push to in-app inboxes in background
    const type: NotificationType = 'general';
    const inAppPromises = users.map((u) => {
      if (u.role === UserRole.CUSTOMER) {
        return this.pushToCustomer(u.id, type, title, body, data).catch(() => {});
      }
      return this.push(u.id, type, title, body, data).catch(() => {});
    });
    await Promise.allSettled(inAppPromises);

    this.logger.log(
      `Broadcast "${title}" to ${target} — FCM: ${fcmResult.success} ok / ${fcmResult.failure} failed — in-app: ${users.length}`,
    );

    return { target, fcm: fcmResult, inApp: users.length };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Domain helpers
  // ─────────────────────────────────────────────────────────────────────────

  async notifyDriverApproved(userId: string) {
    return this.push(
      userId,
      'approval',
      '🎉 Account Approved!',
      'Your rider account has been verified. You can now go online and accept bookings.',
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
      'Payment Received',
      `₹${Math.round(amount)} has been paid for Trip #${bookingId.slice(-6).toUpperCase()}.`,
      { bookingId, amount },
    );
  }

  async notifyCustomerBookingUpdate(
    userId: string,
    title: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    return this.pushToCustomer(userId, 'general', title, message, data);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Weekly earnings cron — every Monday
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
      .addSelect(
        'COALESCE(SUM(b.driver_earnings), SUM(b.estimated_fare), 0)',
        'total_earnings',
      )
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
  // Admin Notifications (shared inbox)
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
      const existing =
        (await this.safeGet<AdminNotification[]>(this.adminKey())) ?? [];
      const updated = [notif, ...existing].slice(0, MAX_NOTIFICATIONS);
      await this.safeSet(this.adminKey(), updated);
    } catch (err) {
      this.logger.warn(
        `[Admin] Failed to persist notification: ${(err as Error).message}`,
      );
    }

    this.logger.log(`[Admin] Notification pushed: ${title}`);
    return notif;
  }

  async getAdminNotifications(): Promise<AdminNotification[]> {
    try {
      return (await this.safeGet<AdminNotification[]>(this.adminKey())) ?? [];
    } catch {
      return [];
    }
  }

  async markAdminNotificationsRead(): Promise<void> {
    try {
      const notifs = await this.getAdminNotifications();
      const updated = notifs.map((n) => ({ ...n, read: true }));
      await this.safeSet(this.adminKey(), updated);
    } catch {
      /* non-critical */
    }
  }

  async clearAdminNotifications(): Promise<void> {
    try {
      await this.cacheManager.del(this.adminKey());
    } catch {
      /* non-critical */
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fraud / Block helpers
  // ─────────────────────────────────────────────────────────────────────────

  async notifyCustomerBlocked(
    userId: string,
    reason: string,
    blockedUntil: Date,
  ): Promise<void> {
    await this.pushToCustomer(
      userId,
      'general',
      'Account Temporarily Suspended',
      `Your account has been suspended until ${blockedUntil.toLocaleDateString()}. Reason: ${reason}. You may submit an appeal from the app.`,
    );
  }

  async notifyCustomerUnblocked(userId: string): Promise<void> {
    await this.pushToCustomer(
      userId,
      'general',
      'Account Reactivated',
      'Your account has been reactivated. You can now book rides.',
    );
  }

  async notifyAdminFraudFlag(
    customerId: string,
    customerName: string,
    reportType: string,
    severity: string,
  ): Promise<void> {
    await this.pushAdmin(
      'general',
      `Fraud Alert: ${severity.toUpperCase()} severity`,
      `Customer ${customerName} flagged for ${reportType.replace(/_/g, ' ')}`,
      { customerId, reportType, severity } as Record<string, unknown>,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Legacy compat (sendPushNotification used by existing controller)
  // ─────────────────────────────────────────────────────────────────────────

  async sendPushNotification(dto: SendNotificationDto) {
    const { user_id, title, body, data } = dto;
    await this.push(user_id, 'general', title, body, data as Record<string, unknown>);
    return { message: 'Notification sent', user_id, title, body };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async sendFcmToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    isNewBooking = false,
  ): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'fcm_token'],
    });
    if (!user?.fcm_token) return;

    const ok = await this.fcmService.sendToToken(user.fcm_token, title, body, data, isNewBooking);
    if (!ok) {
      // Stale token — clear it
      await this.userRepository.update(userId, { fcm_token: null });
    }
  }

  private async sendDataOnlyFcmToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'fcm_token'],
    });
    if (!user?.fcm_token) return;
    const ok = await this.fcmService.sendDataOnlyToToken(user.fcm_token, title, body, data);
    if (!ok) await this.userRepository.update(userId, { fcm_token: null });
  }

  private async safeGet<T>(key: string): Promise<T | undefined> {
    return (await this.cacheManager.get<T>(key)) ?? undefined;
  }

  private async safeSet(key: string, value: unknown): Promise<void> {
    await this.cacheManager.set(key, value, NOTIFICATION_TTL_MS);
  }

  private key(userId: string) {
    return `driver_notifications:${userId}`;
  }

  private customerKey(userId: string) {
    return `customer_notifications:${userId}`;
  }

  private adminKey() {
    return 'admin_notifications';
  }
}
