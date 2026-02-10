import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, BookingType } from './entities/booking.entity';
import { PricingRule } from './entities/pricing-rule.entity';
import { VehicleType } from '../vehicle/entities/vehicle.entity';
import { EstimateFareDto, CreateBookingDto, CancelBookingDto, UpdateFinalFareDto } from './dto/booking.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { MapboxService } from '../../services/mapbox.service';
import { CoinService } from '../coin/coin.service';

@Injectable()
export class BookingService {
  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(PricingRule)
    private pricingRuleRepository: Repository<PricingRule>,
    private mapboxService: MapboxService,
    private coinService: CoinService,
  ) {}

  /**
   * Estimate fare for a trip
   */
  async estimateFare(estimateFareDto: EstimateFareDto) {
    const { pickup_location, drop_location, vehicle_type } = estimateFareDto;

    // Get distance and duration from Mapbox Directions API
    const routeData = await this.mapboxService.getDistanceMatrix(
      pickup_location.latitude,
      pickup_location.longitude,
      drop_location.latitude,
      drop_location.longitude,
    );

    // Convert meters to km, seconds to minutes
    const distance = routeData.distance / 1000;
    const duration = Math.ceil(routeData.duration / 60);

    // Get pricing rule for vehicle type
    const pricingRule = await this.pricingRuleRepository.findOne({
      where: { vehicle_type, is_active: true },
    });

    if (!pricingRule) {
      throw new NotFoundException(`Pricing rule not found for vehicle type: ${vehicle_type}`);
    }

    // Calculate fare
    const baseFare = Number(pricingRule.base_fare);
    const perKmCharge = Number(pricingRule.per_km_rate) * distance;
    const perMinuteCharge = pricingRule.per_minute_rate
      ? Number(pricingRule.per_minute_rate) * duration
      : 0;
    
    let estimatedFare = baseFare + perKmCharge + perMinuteCharge;

    // Apply surge multiplier
    if (pricingRule.surge_multiplier && pricingRule.surge_multiplier > 1) {
      estimatedFare *= Number(pricingRule.surge_multiplier);
    }

    // Apply minimum fare
    if (pricingRule.minimum_fare && estimatedFare < Number(pricingRule.minimum_fare)) {
      estimatedFare = Number(pricingRule.minimum_fare);
    }

    // Round to 2 decimal places
    estimatedFare = Math.round(estimatedFare * 100) / 100;

    return {
      distance: Math.round(distance * 100) / 100,
      duration,
      estimated_fare: estimatedFare,
      breakdown: {
        base_fare: baseFare,
        distance_charge: Math.round(perKmCharge * 100) / 100,
        time_charge: Math.round(perMinuteCharge * 100) / 100,
        surge_multiplier: Number(pricingRule.surge_multiplier),
        minimum_fare: pricingRule.minimum_fare ? Number(pricingRule.minimum_fare) : null,
      },
    };
  }

  /**
   * Create new booking
   */
  async create(userId: string, createBookingDto: CreateBookingDto) {
    const { name, mobile_number, city, service_category, pickup_location, drop_location, vehicle_type, booking_type, scheduled_time } =
      createBookingDto;

    // Validate scheduled time for scheduled bookings
    if (booking_type === BookingType.SCHEDULED) {
      if (!scheduled_time) {
        throw new BadRequestException('Scheduled time is required for scheduled bookings');
      }

      const scheduledDate = new Date(scheduled_time);
      if (scheduledDate <= new Date()) {
        throw new BadRequestException('Scheduled time must be in the future');
      }
    }

    // Get fare estimation
    const fareEstimate = await this.estimateFare({
      pickup_location,
      drop_location,
      vehicle_type,
    });

    // Create booking
    const booking = this.bookingRepository.create({
      customer_id: userId,
      name,
      mobile_number,
      city,
      service_category,
      booking_type,
      pickup_address: pickup_location.address,
      drop_address: drop_location.address,
      distance: fareEstimate.distance,
      duration: fareEstimate.duration,
      estimated_fare: fareEstimate.estimated_fare,
      status: BookingStatus.PENDING,
      scheduled_time: scheduled_time ? new Date(scheduled_time) : undefined,
    });

    // Set PostGIS Point for pickup location
    await this.bookingRepository
      .createQueryBuilder()
      .insert()
      .into(Booking)
      .values({
        ...booking,
        pickup_location: () =>
          `ST_SetSRID(ST_MakePoint(${pickup_location.longitude}, ${pickup_location.latitude}), 4326)`,
        drop_location: () =>
          `ST_SetSRID(ST_MakePoint(${drop_location.longitude}, ${drop_location.latitude}), 4326)`,
      })
      .execute();

    // Fetch the created booking
    const createdBooking = await this.bookingRepository.findOne({
      where: { customer_id: userId },
      order: { created_at: 'DESC' },
      relations: ['customer'],
    });

    return createdBooking;
  }

  /**
   * Get booking by ID
   */
  async getById(bookingId: string, userId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['customer', 'driver', 'vehicle'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // Check if user has access to this booking
    if (booking.customer_id !== userId && booking.driver_id !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    return booking;
  }

  /**
   * Cancel booking
   */
  async cancel(bookingId: string, userId: string, cancelDto: CancelBookingDto) {
    const booking = await this.getById(bookingId, userId);

    // Only allow cancellation if booking is not ongoing or completed
    if ([BookingStatus.ONGOING, BookingStatus.COMPLETED].includes(booking.status)) {
      throw new BadRequestException(`Cannot cancel booking with status: ${booking.status}`);
    }

    booking.status = BookingStatus.CANCELLED;
    booking.cancellation_reason = cancelDto.reason;

    return this.bookingRepository.save(booking);
  }

  /**
   * Get nearby bookings for driver (within radius)
   */
  async getNearbyBookings(latitude: number, longitude: number, radius: number = 5) {
    // radius in km
    const bookings = await this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.status = :status', { status: BookingStatus.PENDING })
      .andWhere(
        `ST_DWithin(
          booking.pickup_location,
          ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography,
          :radius
        )`,
        { latitude, longitude, radius: radius * 1000 }, // Convert km to meters
      )
      .orderBy('booking.created_at', 'ASC')
      .limit(20)
      .getMany();

    return bookings;
  }

  /**
   * Get driver's active booking
   */
  async getDriverActiveBooking(userId: string) {
    const booking = await this.bookingRepository.findOne({
      where: {
        driver_id: userId,
        status: BookingStatus.ONGOING,
      },
      relations: ['customer', 'vehicle'],
    });

    return booking || null;
  }

  /**
   * Accept booking (driver)
   */
  async acceptBooking(bookingId: string, driverId: string, vehicleId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Booking is no longer available');
    }

    booking.status = BookingStatus.ACCEPTED;
    booking.driver_id = driverId;
    booking.vehicle_id = vehicleId;
    booking.acceptance_time = new Date();

    return this.bookingRepository.save(booking);
  }

  /**
   * Reject booking (driver)
   */
  async rejectBooking(bookingId: string, driverId: string, reason: string) {
    // For now, just return success
    // In real implementation, you might want to log rejections
    return { message: 'Booking rejected' };
  }

  /**
   * Start trip
   */
  async startTrip(bookingId: string, driverId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(`Cannot start trip with status: ${booking.status}`);
    }

    booking.status = BookingStatus.ONGOING;
    booking.start_time = new Date();

    return this.bookingRepository.save(booking);
  }

  /**
   * Complete trip
   */
  async completeTrip(bookingId: string, driverId: string, updateDto?: UpdateFinalFareDto) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== BookingStatus.ONGOING) {
      throw new BadRequestException(`Cannot complete trip with status: ${booking.status}`);
    }

    booking.status = BookingStatus.COMPLETED;
    booking.completion_time = new Date();
    booking.final_fare = updateDto?.final_fare || booking.estimated_fare;

    const savedBooking = await this.bookingRepository.save(booking);

    // Award coins to customer for successful delivery
    const coinReward = await this.coinService.awardCoins(
      booking.customer_id,
      booking.id,
      Number(booking.distance) || 0,
      Number(booking.final_fare),
      booking.service_category,
    );

    return {
      ...savedBooking,
      coins_earned: coinReward.coins,
      coins_multiplier: coinReward.multiplier,
    };
  }

  /**
   * Get booking history for customer
   */
  async getCustomerHistory(userId: string, page: number = 1, limit: number = 10, status?: string) {
    const queryBuilder = this.bookingRepository
      .createQueryBuilder('booking')
      .leftJoinAndSelect('booking.driver', 'driver')
      .leftJoinAndSelect('booking.vehicle', 'vehicle')
      .leftJoinAndSelect('booking.payments', 'payments')
      .where('booking.customer_id = :userId', { userId });

    if (status) {
      queryBuilder.andWhere('booking.status = :status', { status });
    }

    const [bookings, total] = await queryBuilder
      .orderBy('booking.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      bookings,
      ...getPaginationMeta(total, page, limit),
    };
  }

  /**
   * Get booking history for driver
   */
  async getDriverHistory(userId: string, page: number = 1, limit: number = 10) {
    const [bookings, total] = await this.bookingRepository.findAndCount({
      where: { driver_id: userId },
      relations: ['customer', 'vehicle'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // Calculate total earnings
    const completedBookings = await this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.driver_id = :userId', { userId })
      .andWhere('booking.status = :status', { status: BookingStatus.COMPLETED })
      .select('SUM(booking.final_fare)', 'total')
      .getRawOne();

    return {
      bookings,
      total_earnings: completedBookings?.total || 0,
      ...getPaginationMeta(total, page, limit),
    };
  }
}
