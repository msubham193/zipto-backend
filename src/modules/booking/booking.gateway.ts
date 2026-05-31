import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Booking, BookingStatus } from './entities/booking.entity';
import { User } from '../auth/entities/user.entity';
import { RedisService } from '../../services/redis.service';
import { FcmService } from '../../services/fcm.service';

/** How long we wait after a socket disconnect before treating the driver as AWOL. */
const DISCONNECT_GRACE_MS = 15 * 60 * 1000; // 15 minutes

/** How long a pending offer survives waiting for driver to reconnect. */
const PENDING_OFFER_TTL_MS = 30_000; // 30 seconds

/** Cache of booking → { driverId, customerId } so location pings avoid a DB hit. */
const PARTICIPANTS_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Last-known driver location cache, read by the REST fallback. */
const DRIVER_LOC_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Min interval between accepted location pings per booking (anti-flood). */
const LOC_MIN_INTERVAL_MS = 1500;

interface BookingParticipants {
  driverId: string;
  customerId: string;
  status: string;
}

interface DriverLocationPayload {
  bookingId?: string;
  latitude?: number;
  longitude?: number;
  heading?: number;
  speed?: number;
}

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: 'booking',
})
export class BookingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(BookingGateway.name);

  constructor(
    private jwtService: JwtService,
    @InjectRepository(Booking) private bookingRepository: Repository<Booking>,
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectQueue('booking_assignment') private bookingQueue: Queue,
    private cacheManager: RedisService,
    private fcmService: FcmService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.headers.authorization;
      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token.replace('Bearer ', ''));
      client.data.user = payload;

      await client.join(`user_${payload.sub}`);
      this.logger.log(`Client connected: ${client.id}, User: ${payload.sub}`);

      // Guard A (reconnect): driver came back within the grace window — cancel the ghost check
      const graceKey = `driver:disconnect_grace:${payload.sub}`;
      const gracePending = await this.cacheManager.get<string>(graceKey);
      if (gracePending) {
        await this.cacheManager.del(graceKey);
        // Set a cancel marker so the Bull job knows the driver reconnected.
        // TTL = 25 min (grace 15 + 10 buffer) to outlive the job's delay.
        await this.cacheManager.set(
          `driver:ghost_check_cancel:${gracePending}`,
          '1',
          25 * 60 * 1000,
        );
        this.logger.log(`[Gateway] Driver ${payload.sub} reconnected within grace — ghost check cancelled for booking ${gracePending}`);
      }

      // Deliver any offer that was queued while the driver was briefly disconnected
      const pendingOffer = await this.cacheManager.get<any>(`offer:pending:${payload.sub}`);
      if (pendingOffer) {
        this.logger.log(`[Gateway] Delivering pending offer to reconnected driver ${payload.sub}`);
        client.emit('booking_offer', pendingOffer);
        await this.cacheManager.del(`offer:pending:${payload.sub}`);
      }
    } catch (error: any) {
      this.logger.error(`Connection error: ${error?.message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const userId: string | undefined = client.data?.user?.sub;
    this.logger.log(`Client disconnected: ${client.id}${userId ? ` (user: ${userId})` : ''}`);

    if (!userId) return;

    // Guard A: check if this driver has an ongoing booking
    try {
      const activeBooking = await this.bookingRepository.findOne({
        where: { driver_id: userId, status: BookingStatus.ONGOING, is_flagged: false },
        select: ['id'],
      });

      if (!activeBooking) return;

      // Set a grace key in Redis — cleared if driver reconnects in time
      await this.cacheManager.set(
        `driver:disconnect_grace:${userId}`,
        activeBooking.id,
        DISCONNECT_GRACE_MS,
      );

      // Schedule a Bull job to fire after the grace window
      await this.bookingQueue.add(
        'driver_ghost_check',
        { bookingId: activeBooking.id, driverId: userId },
        { delay: DISCONNECT_GRACE_MS },
      );

      this.logger.warn(
        `[Gateway] Driver ${userId} disconnected mid-delivery (booking=${activeBooking.id}) — ghost check in 15 min`,
      );
    } catch (err: any) {
      this.logger.error(`[Gateway] Error scheduling ghost check: ${err?.message}`);
    }
  }

  async emitBookingOffer(driverId: string, bookingData: any) {
    const room = `user_${driverId}`;
    const sockets = await this.server.in(room).fetchSockets();
    this.logger.log(`[Gateway] emitBookingOffer to room=${room}, sockets=${sockets.length}`);

    if (sockets.length > 0) {
      this.server.to(room).emit('booking_offer', bookingData);
    } else {
      // Driver socket is disconnected — persist offer in Redis so it survives
      // reconnect and server restarts. TTL matches the offer timeout window.
      this.logger.log(`[Gateway] Driver ${driverId} offline — queuing offer in Redis`);
      await this.cacheManager.set(`offer:pending:${driverId}`, bookingData, PENDING_OFFER_TTL_MS);
    }

    // ALWAYS fire a high-priority push as well. A backgrounded-but-online app
    // keeps its socket connected, so the socket emit above is delivered to JS
    // that can't surface a system notification while backgrounded/killed. The
    // FCM notification is what reliably rings the driver. In the foreground the
    // app ignores this push (the live socket already shows the offer + sound),
    // so there's no double alert.
    try {
      const driver = await this.userRepository.findOne({
        where: { id: driverId },
        select: ['id', 'fcm_token'],
      });
      if (driver?.fcm_token) {
        const fare = Math.round(Number(bookingData?.fare) || 0);
        await this.fcmService.sendToToken(
          driver.fcm_token,
          'New booking request 🛵',
          fare > 0
            ? `₹${fare} • ${bookingData?.pickup ?? 'Pickup nearby'} — tap to accept`
            : 'You have a new ride request — tap to accept',
          {
            type: 'new_booking',
            bookingId: String(bookingData?.bookingId ?? ''),
          },
          true, // isNewBooking → zipto_new_booking channel (loud sound, heads-up)
        );
      }
    } catch (err: any) {
      this.logger.warn(`[Gateway] FCM offer push failed for ${driverId}: ${err?.message}`);
    }
  }

  notifyUser(userId: string, event: string, data: any) {
    this.server.to(`user_${userId}`).emit(event, data);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Live driver location relay  (rider → backend → customer)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resolve { driverId, customerId, status } for a booking, cached in Redis so
   * the high-frequency location stream costs ~1 Redis read per ping instead of
   * a DB query. Cache is invalidated naturally by TTL and refreshed on miss.
   */
  private async getParticipants(bookingId: string): Promise<BookingParticipants | null> {
    const key = `booking:participants:${bookingId}`;
    const cached = await this.cacheManager.get<BookingParticipants>(key);
    if (cached) return cached;

    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      select: ['id', 'driver_id', 'customer_id', 'status'],
    });
    if (!booking || !booking.driver_id || !booking.customer_id) return null;

    const participants: BookingParticipants = {
      driverId: booking.driver_id,
      customerId: booking.customer_id,
      status: booking.status,
    };
    await this.cacheManager.set(key, participants, PARTICIPANTS_TTL_MS);
    return participants;
  }

  /**
   * Rider app emits this every few seconds while on an active trip.
   * Validates the sender is the assigned driver (anti-spoof), throttles, caches
   * the last known position, and relays it only to that booking's customer.
   */
  @SubscribeMessage('driver_location')
  async handleDriverLocation(
    @MessageBody() payload: DriverLocationPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const driverId: string | undefined = client.data?.user?.sub;
    if (!driverId || !payload) return;

    const { bookingId, latitude, longitude } = payload;
    if (
      !bookingId ||
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      Number.isNaN(latitude) ||
      Number.isNaN(longitude)
    ) {
      return;
    }

    try {
      const participants = await this.getParticipants(bookingId);
      if (!participants) return;

      // Anti-spoof: only the assigned driver may publish this booking's location.
      if (participants.driverId !== driverId) {
        this.logger.warn(`[Gateway] driver_location rejected: ${driverId} is not the driver for booking ${bookingId}`);
        return;
      }

      // Per-booking throttle — drop pings arriving faster than the floor.
      const throttleKey = `driver:loc_throttle:${bookingId}`;
      const fresh = await this.cacheManager.setnx(throttleKey, '1', LOC_MIN_INTERVAL_MS);
      if (!fresh) return;

      const location = {
        bookingId,
        latitude,
        longitude,
        heading: typeof payload.heading === 'number' ? payload.heading : null,
        speed: typeof payload.speed === 'number' ? payload.speed : null,
        ts: Date.now(),
      };

      // Cache last-known for the REST fallback (customer opening fresh / socket gap).
      await this.cacheManager.set(`driver:loc:${bookingId}`, location, DRIVER_LOC_TTL_MS);

      // Relay only to this booking's customer room.
      this.server.to(`user_${participants.customerId}`).emit('driver_location', location);
    } catch (err: any) {
      this.logger.error(`[Gateway] handleDriverLocation error: ${err?.message}`);
    }
  }

  /** Read the last cached driver location (used by the REST fallback). */
  async getLastDriverLocation(bookingId: string) {
    return this.cacheManager.get<{
      bookingId: string;
      latitude: number;
      longitude: number;
      heading: number | null;
      speed: number | null;
      ts: number;
    }>(`driver:loc:${bookingId}`);
  }
}
