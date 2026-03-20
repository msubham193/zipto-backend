import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { BookingService } from './booking.service';

@Processor('booking_assignment')
export class BookingProcessor {
  private readonly logger = new Logger(BookingProcessor.name);

  constructor(private readonly bookingService: BookingService) {}

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
    } catch (error) {
      this.logger.error(
        `Error processing search_driver for booking ${bookingId}: ${error.message}`,
      );
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
    } catch (error) {
      this.logger.error(
        `Error processing offer_timeout for booking ${bookingId}: ${error.message}`,
      );
    }
  }

  @Process('broadcast_timeout')
  async handleBroadcastTimeout(job: Job<{ bookingId: string }>) {
    const { bookingId } = job.data;
    this.logger.debug(`Processing broadcast_timeout for booking ${bookingId}`);
    try {
      await this.bookingService.handleBroadcastTimeout(bookingId);
    } catch (error) {
      this.logger.error(
        `Error processing broadcast_timeout for booking ${bookingId}: ${error.message}`,
      );
    }
  }

  @Process('search_timeout')
  async handleSearchTimeout(job: Job<{ bookingId: string }>) {
    const { bookingId } = job.data;
    this.logger.log(`Processing search_timeout (60s) for booking ${bookingId}`);
    try {
      await this.bookingService.handleSearchTimeout(bookingId);
    } catch (error) {
      this.logger.error(
        `Error processing search_timeout for booking ${bookingId}: ${error.message}`,
      );
    }
  }
}
