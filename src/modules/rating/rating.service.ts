import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating } from './entities/rating.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { SubmitRatingDto } from './dto/rating.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';

@Injectable()
export class RatingService {
  constructor(
    @InjectRepository(Rating)
    private ratingRepository: Repository<Rating>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
  ) {}

  /**
   * Submit rating for a completed booking
   */
  async submitRating(userId: string, submitRatingDto: SubmitRatingDto) {
    const { booking_id, rating, comment } = submitRatingDto;

    // Verify booking exists and is completed
    const booking = await this.bookingRepository.findOne({
      where: { id: booking_id },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customer_id !== userId) {
      throw new BadRequestException('You can only rate your own bookings');
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException('Can only rate completed bookings');
    }

    // Check if rating already exists
    const existingRating = await this.ratingRepository.findOne({
      where: { booking_id },
    });

    if (existingRating) {
      throw new BadRequestException('You have already rated this booking');
    }

    // Create rating
    const newRating = this.ratingRepository.create({
      booking_id,
      customer_id: userId,
      driver_id: booking.driver_id,
      rating,
      comment,
    });

    await this.ratingRepository.save(newRating);

    // Update driver's average rating
    await this.updateDriverAverageRating(booking.driver_id!);

    return newRating;
  }

  /**
   * Get rating for a specific booking
   */
  async getRatingByBooking(bookingId: string, userId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customer_id !== userId && booking.driver_id !== userId) {
      throw new BadRequestException('You do not have access to this rating');
    }

    const rating = await this.ratingRepository.findOne({
      where: { booking_id: bookingId },
      relations: ['customer'],
    });

    return rating || null;
  }

  /**
   * Get all ratings for a driver
   */
  async getDriverRatings(driverId: string, page: number = 1, limit: number = 10) {
    const [ratings, total] = await this.ratingRepository.findAndCount({
      where: { driver_id: driverId },
      relations: ['customer', 'booking'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Calculate statistics
    const stats = await this.ratingRepository
      .createQueryBuilder('rating')
      .select('AVG(rating)', 'average')
      .addSelect('COUNT(*)', 'total')
      .where('rating.driver_id = :driverId', { driverId })
      .getRawOne();

    return {
      ratings,
      statistics: {
        average_rating: stats.average ? parseFloat(stats.average).toFixed(2) : 0,
        total_ratings: parseInt(stats.total) || 0,
      },
      ...getPaginationMeta(total, page, limit),
    };
  }

  /**
   * Update driver's average rating
   */
  private async updateDriverAverageRating(driverId: string) {
    const result = await this.ratingRepository
      .createQueryBuilder('rating')
      .select('AVG(rating)', 'average')
      .addSelect('COUNT(*)', 'total')
      .where('rating.driver_id = :driverId', { driverId })
      .getRawOne();

    const averageRating = result.average ? parseFloat(result.average) : 0;
    const totalTrips = parseInt(result.total) || 0;

    // Update driver profile
    const driverProfile = await this.driverProfileRepository.findOne({
      where: { user_id: driverId },
    });

    if (driverProfile) {
      driverProfile.average_rating = Math.round(averageRating * 100) / 100;
      driverProfile.total_trips = totalTrips;
      await this.driverProfileRepository.save(driverProfile);
    }
  }
}
