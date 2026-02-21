import {
  Inject,
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
import { EstimateFareDto, CreateBookingDto, CancelBookingDto, CompleteTripDto } from './dto/booking.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { MapboxService } from '../../services/mapbox.service';
import { CoinService } from '../coin/coin.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { BookingGateway } from './booking.gateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';


@Injectable()
export class BookingService {
  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(PricingRule)
    private pricingRuleRepository: Repository<PricingRule>,
    private mapboxService: MapboxService,
    private coinService: CoinService,
    @InjectQueue('booking_assignment') private bookingQueue: Queue,
    private bookingGateway: BookingGateway,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  /**
   * Check if a booking time falls in night hours (11PM - 6AM)
   */
  private isNightTime(date: Date = new Date()): boolean {
    const hours = date.getHours();
    return hours >= 23 || hours < 6;
  }

  /**
   * Round to 2 decimal places
   */
  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * Estimate fare for a trip
   */
  async estimateFare(estimateFareDto: EstimateFareDto) {
    const {
      pickup_location,
      drop_location,
      vehicle_type,
      number_of_helpers = 0,
      extra_stops = 0,
    } = estimateFareDto;

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

    // --- Calculate fare breakdown ---
    const baseFare = Number(pricingRule.base_fare);
    const baseDistanceKm = Number(pricingRule.base_distance_km);
    const perKmRate = Number(pricingRule.per_km_rate);
    const perMinuteRate = pricingRule.per_minute_rate ? Number(pricingRule.per_minute_rate) : 0;
    const helperChargePerPerson = Number(pricingRule.helper_charge_per_person);
    const multiStopFee = Number(pricingRule.multi_stop_fee);
    const nightSurchargePercent = Number(pricingRule.night_surcharge_percent);
    const commissionPercent = Number(pricingRule.commission_percent);

    // 1. Distance charge: only for KMs beyond base distance
    const extraDistance = Math.max(0, distance - baseDistanceKm);
    const distanceCharge = this.round(extraDistance * perKmRate);

    // 2. Time charge: per minute for total trip duration
    const timeCharge = this.round(duration * perMinuteRate);

    // 3. Helper charge: ₹300 per helper
    const helperCharge = this.round(number_of_helpers * helperChargePerPerson);

    // 4. Multi-stop charge: fee per extra drop-off
    const multiStopCharge = this.round(extra_stops * multiStopFee);

    // 5. Subtotal before night surcharge
    let subtotal = baseFare + distanceCharge + timeCharge + helperCharge + multiStopCharge;

    // 6. Night surcharge (11PM - 6AM)
    const isNight = this.isNightTime();
    const nightSurcharge = isNight
      ? this.round(subtotal * (nightSurchargePercent / 100))
      : 0;

    // 7. Estimated fare
    let estimatedFare = subtotal + nightSurcharge;

    // 8. Apply surge multiplier
    const surgeMultiplier = Number(pricingRule.surge_multiplier);
    if (surgeMultiplier && surgeMultiplier > 1) {
      estimatedFare = this.round(estimatedFare * surgeMultiplier);
    }

    // 9. Apply minimum fare floor
    const minimumFare = pricingRule.minimum_fare ? Number(pricingRule.minimum_fare) : null;
    if (minimumFare && estimatedFare < minimumFare) {
      estimatedFare = minimumFare;
    }

    estimatedFare = this.round(estimatedFare);

    // 10. Calculate commission split (for display purposes)
    const skidoCommission = this.round(estimatedFare * (commissionPercent / 100));
    const driverEarnings = this.round(estimatedFare - skidoCommission);

    return {
      distance: this.round(distance),
      duration,
      estimated_fare: estimatedFare,
      is_night_booking: isNight,
      breakdown: {
        base_fare: baseFare,
        base_distance_km: baseDistanceKm,
        distance_charge: distanceCharge,
        time_charge: timeCharge,
        helper_charge: helperCharge,
        multi_stop_charge: multiStopCharge,
        night_surcharge: nightSurcharge,
        waiting_charge: 0, // Calculated at trip completion
        toll_amount: 0, // Added at trip completion
        surge_multiplier: surgeMultiplier,
        subtotal: this.round(subtotal),
        skido_commission: skidoCommission,
        driver_earnings: driverEarnings,
      },
      pricing_info: {
        free_waiting_minutes: Number(pricingRule.free_waiting_minutes),
        waiting_charge_per_minute: Number(pricingRule.waiting_charge_per_minute),
        helper_charge_per_person: helperChargePerPerson,
        multi_stop_fee: multiStopFee,
        night_surcharge_percent: nightSurchargePercent,
        commission_percent: commissionPercent,
      },
    };
  }

  /**
   * Create new booking
   */
  async create(userId: string, createBookingDto: CreateBookingDto) {
    const {
      name,
      mobile_number,
      city,
      service_category,
      pickup_location,
      drop_location,
      vehicle_type,
      booking_type,
      scheduled_time,
      number_of_helpers = 0,
      extra_drop_locations = [],
    } = createBookingDto;

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

    // Get fare estimation with helpers and extra stops
    const fareEstimate = await this.estimateFare({
      pickup_location,
      drop_location,
      vehicle_type,
      number_of_helpers,
      extra_stops: extra_drop_locations.length,
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
      fare_breakdown: fareEstimate.breakdown,
      number_of_helpers,
      extra_stops_count: extra_drop_locations.length,
      is_night_booking: fareEstimate.is_night_booking,
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

    // If immediate booking, start searching for drivers
    if (createdBooking && booking_type === BookingType.INSTANT) {
      await this.bookingQueue.add('search_driver', {
        bookingId: createdBooking.id,
        excludedDriverIds: [],
      });
    }

    return createdBooking;
  }

  /**
   * Process Driver Search (Job Processor)
   */
  async processDriverSearch(bookingId: string, excludedDriverIds: string[]) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking || booking.status !== BookingStatus.PENDING) return;

    const pickup = booking.pickup_location as any;
    const nearbyDrivers = await this.findNearbyDrivers(
      pickup.coordinates[1],
      pickup.coordinates[0],
      5,
    );

    const eligibleDrivers = nearbyDrivers.filter(
      (driver: any) => !excludedDriverIds.includes(driver.user_id),
    );

    if (eligibleDrivers.length === 0) {
      this.bookingGateway.notifyUser(booking.customer_id, 'no_drivers_found', { bookingId });
      return;
    }

    const nearestDriver = eligibleDrivers[0];

    // Set offer in Redis (TTL 7 seconds + buffer)
    await this.cacheManager.set(`booking:${bookingId}:offer`, nearestDriver.user_id, 10000);

    // Send offer to driver
    this.bookingGateway.emitBookingOffer(nearestDriver.user_id, {
      bookingId: booking.id,
      pickup: booking.pickup_address,
      drop: booking.drop_address,
      fare: booking.estimated_fare,
      distance: booking.distance,
      timeLeft: 7,
    });

    // Schedule timeout job
    await this.bookingQueue.add(
      'offer_timeout',
      {
        bookingId,
        driverId: nearestDriver.user_id,
        excludedDriverIds: [...excludedDriverIds, nearestDriver.user_id],
      },
      { delay: 7000 },
    );
  }

  /**
   * Handle Offer Timeout (Job Processor)
   */
  async handleOfferTimeout(bookingId: string, driverId: string, excludedDriverIds: string[]) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking || booking.status !== BookingStatus.PENDING) return;

    const currentOfferDriver = await this.cacheManager.get(`booking:${bookingId}:offer`);

    if (currentOfferDriver === driverId) {
      await this.cacheManager.del(`booking:${bookingId}:offer`);
      await this.bookingQueue.add('search_driver', {
        bookingId,
        excludedDriverIds,
      });
    }
  }

  /**
   * Helper to find nearby drivers
   */
  private async findNearbyDrivers(lat: number, lng: number, radiusKm: number) {
    return this.bookingRepository.manager.query(
      `
      SELECT user_id, 
             ST_Distance(
               location, 
               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
             ) as distance
      FROM driver_profiles
      WHERE availability_status = 'online'
      AND ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
      ORDER BY distance ASC
      LIMIT 10
      `,
      [lng, lat, radiusKm * 1000],
    );
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
    const bookings = await this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.status = :status', { status: BookingStatus.PENDING })
      .andWhere(
        `ST_DWithin(
          booking.pickup_location,
          ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography,
          :radius
        )`,
        { latitude, longitude, radius: radius * 1000 },
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

    const offeredDriverId = await this.cacheManager.get(`booking:${bookingId}:offer`);
    if (offeredDriverId !== driverId) {
      throw new BadRequestException('Booking offer expired or not assigned to you');
    }

    booking.status = BookingStatus.ACCEPTED;
    booking.driver_id = driverId;
    booking.vehicle_id = vehicleId;
    booking.acceptance_time = new Date();

    const savedBooking = await this.bookingRepository.save(booking);

    await this.cacheManager.del(`booking:${bookingId}:offer`);

    this.bookingGateway.notifyUser(booking.customer_id, 'booking_accepted', {
      bookingId: booking.id,
      driverId,
    });

    return savedBooking;
  }

  /**
   * Reject booking (driver)
   */
  async rejectBooking(bookingId: string, driverId: string, reason: string) {
    const offeredDriverId = await this.cacheManager.get(`booking:${bookingId}:offer`);

    if (offeredDriverId === driverId) {
      await this.cacheManager.del(`booking:${bookingId}:offer`);
    }

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
   * Complete trip — Calculates final fare with waiting charges, toll, and Skido commission
   */
  async completeTrip(bookingId: string, driverId: string, completeTripDto?: CompleteTripDto) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== BookingStatus.ONGOING) {
      throw new BadRequestException(`Cannot complete trip with status: ${booking.status}`);
    }

    // Get pricing rule for waiting charge calculation
    const pricingRule = await this.pricingRuleRepository.findOne({
      where: { is_active: true },
    });

    // Extract completion data
    const hasToll = completeTripDto?.has_toll || false;
    const tollAmount = hasToll ? (completeTripDto?.toll_amount || 0) : 0;
    const waitingTimeMinutes = completeTripDto?.waiting_time_minutes || 0;

    // Calculate waiting charge
    let waitingCharge = 0;
    if (pricingRule && waitingTimeMinutes > 0) {
      const freeWaitingMinutes = Number(pricingRule.free_waiting_minutes);
      const waitingChargePerMinute = Number(pricingRule.waiting_charge_per_minute);
      const chargeableMinutes = Math.max(0, waitingTimeMinutes - freeWaitingMinutes);
      waitingCharge = this.round(chargeableMinutes * waitingChargePerMinute);
    }

    // Calculate final fare: estimated + waiting + toll
    const estimatedFare = Number(booking.estimated_fare);
    const finalFare = this.round(estimatedFare + waitingCharge + tollAmount);

    // Calculate Skido commission and driver earnings
    const commissionPercent = pricingRule ? Number(pricingRule.commission_percent) : 30;
    const skidoCommission = this.round(finalFare * (commissionPercent / 100));
    const driverEarnings = this.round(finalFare - skidoCommission);

    // Update fare breakdown
    const fareBreakdown = booking.fare_breakdown || {} as any;
    fareBreakdown.waiting_charge = waitingCharge;
    fareBreakdown.toll_amount = tollAmount;
    fareBreakdown.skido_commission = skidoCommission;
    fareBreakdown.driver_earnings = driverEarnings;

    // Update booking
    booking.status = BookingStatus.COMPLETED;
    booking.completion_time = new Date();
    booking.final_fare = finalFare;
    booking.fare_breakdown = fareBreakdown;
    booking.has_toll = hasToll;
    booking.toll_amount = tollAmount;
    booking.waiting_time_minutes = waitingTimeMinutes;
    booking.skido_commission = skidoCommission;
    booking.driver_earnings = driverEarnings;

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
      fare_summary: {
        estimated_fare: estimatedFare,
        waiting_charge: waitingCharge,
        toll_amount: tollAmount,
        final_fare: finalFare,
        skido_commission: skidoCommission,
        driver_earnings: driverEarnings,
      },
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

    // Calculate total earnings (driver's share only)
    const completedBookings = await this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.driver_id = :userId', { userId })
      .andWhere('booking.status = :status', { status: BookingStatus.COMPLETED })
      .select('SUM(booking.driver_earnings)', 'total_earnings')
      .addSelect('SUM(booking.final_fare)', 'total_fare')
      .addSelect('SUM(booking.skido_commission)', 'total_commission')
      .getRawOne();

    return {
      bookings,
      total_earnings: completedBookings?.total_earnings || 0,
      total_fare: completedBookings?.total_fare || 0,
      total_commission: completedBookings?.total_commission || 0,
      ...getPaginationMeta(total, page, limit),
    };
  }

  /**
   * Get all pricing rules (for admin)
   */
  async getAllPricingRules() {
    return this.pricingRuleRepository.find({
      order: { vehicle_type: 'ASC' },
    });
  }

  /**
   * Create pricing rule (for admin)
   */
  async createPricingRule(data: Partial<PricingRule>) {
    const existing = await this.pricingRuleRepository.findOne({
      where: { vehicle_type: data.vehicle_type, city: data.city || 'Bhubaneswar', is_active: true },
    });

    if (existing) {
      throw new BadRequestException(
        `Active pricing rule already exists for ${data.vehicle_type} in ${data.city || 'Bhubaneswar'}`,
      );
    }

    const pricingRule = this.pricingRuleRepository.create(data);
    return this.pricingRuleRepository.save(pricingRule);
  }

  /**
   * Update pricing rule (for admin)
   */
  async updatePricingRule(id: string, data: Partial<PricingRule>) {
    const pricingRule = await this.pricingRuleRepository.findOne({ where: { id } });

    if (!pricingRule) {
      throw new NotFoundException('Pricing rule not found');
    }

    Object.assign(pricingRule, data);
    return this.pricingRuleRepository.save(pricingRule);
  }

  /**
   * Delete pricing rule (for admin)
   */
  async deletePricingRule(id: string) {
    const pricingRule = await this.pricingRuleRepository.findOne({ where: { id } });

    if (!pricingRule) {
      throw new NotFoundException('Pricing rule not found');
    }

    await this.pricingRuleRepository.remove(pricingRule);
    return { message: 'Pricing rule deleted successfully' };
  }
}
