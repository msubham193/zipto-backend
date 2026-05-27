import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Booking, BookingStatus } from './entities/booking.entity';
import { RedisService } from '../../services/redis.service';

/** How long we wait after a socket disconnect before treating the driver as AWOL. */
const DISCONNECT_GRACE_MS = 15 * 60 * 1000; // 15 minutes

/** How long a pending offer survives waiting for driver to reconnect. */
const PENDING_OFFER_TTL_MS = 30_000; // 30 seconds

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
    @InjectQueue('booking_assignment') private bookingQueue: Queue,
    private cacheManager: RedisService,
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
      // Driver socket is disconnected — persist offer in Redis so it survives reconnect
      // and server restarts. TTL matches the offer timeout window.
      this.logger.log(`[Gateway] Driver ${driverId} offline — queuing offer in Redis`);
      await this.cacheManager.set(`offer:pending:${driverId}`, bookingData, PENDING_OFFER_TTL_MS);
    }
  }

  notifyUser(userId: string, event: string, data: any) {
    this.server.to(`user_${userId}`).emit(event, data);
  }
}
