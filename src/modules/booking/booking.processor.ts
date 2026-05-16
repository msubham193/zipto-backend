import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { BookingService } from './booking.service';
import { RedisService } from '../../services/redis.service';

@Processor('booking_assignment')
export class BookingProcessor {
  private readonly logger = new Logger(BookingProcessor.name);

  constructor(
    private readonly bookingService: BookingService,
    private readonly cacheManager: RedisService,
  ) {}

  @Process('search_driver')
  async handleSearchDriver(
    job: Job<{
      bookingId: string;
      excludedDriverIds: string[];
      vehicleType?: string;
      attempt?: number;
    }>,
  ) {
    const { bookingId, excludedDriverIds, vehicleType, attempt } = job.data;
    this.logger.log(`Processing search_driver for booking ${bookingId}, attempt ${attempt}`);
    try {
      await this.bookingService.processDriverSearch(
        bookingId,
        excludedDriverIds || [],
        vehicleType,
        attempt || 1,
      );
    } catch (error: any) {
      this.logger.error(`Error processing search_driver for booking ${bookingId}: ${error?.message}`);
    }
  }

  @Process('offer_timeout')
  async handleOfferTimeout(
    job: Job<{
      bookingId: string;
      driverId: string;
      excludedDriverIds: string[];
      vehicleType?: string;
      attempt?: number;
    }>,
  ) {
    const { bookingId, driverId, excludedDriverIds, vehicleType, attempt } = job.data;
    this.logger.debug(`Processing offer_timeout for booking ${bookingId}, driver ${driverId}`);
    try {
      await this.bookingService.handleOfferTimeout(
        bookingId,
        driverId,
        excludedDriverIds || [],
        vehicleType,
        attempt || 1,
      );
    } catch (error: any) {
      this.logger.error(`Error processing offer_timeout for booking ${bookingId}: ${error?.message}`);
    }
  }

  @Process('broadcast_timeout')
  async handleBroadcastTimeout(job: Job<{ bookingId: string }>) {
    const { bookingId } = job.data;
    this.logger.debug(`Processing broadcast_timeout for booking ${bookingId}`);
    try {
      await this.bookingService.handleBroadcastTimeout(bookingId);
    } catch (error: any) {
      this.logger.error(`Error processing broadcast_timeout for booking ${bookingId}: ${error?.message}`);
    }
  }

  @Process('search_timeout')
  async handleSearchTimeout(job: Job<{ bookingId: string }>) {
    const { bookingId } = job.data;
    this.logger.log(`Processing search_timeout (60s) for booking ${bookingId}`);
    try {
      await this.bookingService.handleSearchTimeout(bookingId);
    } catch (error: any) {
      this.logger.error(`Error processing search_timeout for booking ${bookingId}: ${error?.message}`);
    }
  }

  @Process('handoff_expiry')
  async handleHandoffExpiry(
    job: Job<{ bookingId: string; originalDriverId: string }>,
  ) {
    const { bookingId, originalDriverId } = job.data;
    this.logger.log(`Processing handoff_expiry for booking ${bookingId}`);
    try {
      await this.bookingService.expireHandoff(bookingId, originalDriverId);
    } catch (error: any) {
      this.logger.error(`Error processing handoff_expiry for booking ${bookingId}: ${error?.message}`);
    }
  }

  @Process('delivery_sla_breach')
  async handleDeliverySLABreach(job: Job<{ bookingId: string; driverId: string }>) {
    const { bookingId, driverId } = job.data;
    this.logger.warn(`Processing delivery_sla_breach for booking ${bookingId}`);
    try {
      await this.bookingService.flagBookingAbandoned(bookingId, driverId, 'sla_deadline');
    } catch (error: any) {
      this.logger.error(`Error processing delivery_sla_breach for booking ${bookingId}: ${error?.message}`);
    }
  }

  @Process('driver_ghost_check')
  async handleDriverGhostCheck(job: Job<{ bookingId: string; driverId: string }>) {
    const { bookingId, driverId } = job.data;
    this.logger.warn(`Processing driver_ghost_check for booking ${bookingId}`);
    try {
      // If the driver reconnected within the grace window, a cancel marker was set.
      // Respect it — do not flag a reconnected driver.
      const cancelled = await this.cacheManager.get(`driver:ghost_check_cancel:${bookingId}`);
      if (cancelled) {
        this.logger.log(`[GhostCheck] Cancelled for booking=${bookingId} — driver reconnected`);
        await this.cacheManager.del(`driver:ghost_check_cancel:${bookingId}`);
        return;
      }
      await this.bookingService.flagBookingAbandoned(bookingId, driverId, 'socket_disconnect');
    } catch (error: any) {
      this.logger.error(`Error processing driver_ghost_check for booking ${bookingId}: ${error?.message}`);
    }
  }
}