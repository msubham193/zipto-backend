import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Booking, BookingStatus, BookingType } from './entities/booking.entity';
import { PricingRule } from './entities/pricing-rule.entity';
import { Payment, PaymentMethod, PaymentStatus } from '../payment/entities/payment.entity';
import {
  EstimateFareDto,
  CreateBookingDto,
  CancelBookingDto,
  CompleteTripDto,
} from './dto/booking.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { MapboxService } from '../../services/mapbox.service';
import { SmsService } from '../../services/sms.service';
import { CoinService } from '../coin/coin.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { BookingGateway } from './booking.gateway';
import { RedisService } from '../../services/redis.service';
import {
  DEFAULT_PRICING_CITY,
  getDefaultPricingRules,
  getVehicleTypeSortOrder,
  LEGACY_VEHICLE_TYPES,
  PUBLIC_VEHICLE_TYPES,
} from './constants/default-pricing-rules';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);
  private pricingRulesInitialized = false;
  private pricingRulesSyncPromise?: Promise<void>;

  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(PricingRule)
    private pricingRuleRepository: Repository<PricingRule>,
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
    private mapboxService: MapboxService,
    private smsService: SmsService,
    private coinService: CoinService,
    @InjectQueue('booking_assignment') private bookingQueue: Queue,
    private bookingGateway: BookingGateway,
    private cacheManager: RedisService,
  ) {}

  private async ensureDefaultPricingRules() {
    if (this.pricingRulesInitialized) {
      return;
    }

    if (!this.pricingRulesSyncPromise) {
      this.pricingRulesSyncPromise = this.syncDefaultPricingRules();
    }

    await this.pricingRulesSyncPromise;
    this.pricingRulesInitialized = true;
  }

  private async syncDefaultPricingRules() {
    for (const rule of getDefaultPricingRules()) {
      const existing = await this.pricingRuleRepository.findOne({
        where: { vehicle_type: rule.vehicle_type, city: rule.city },
      });

      if (existing) {
        Object.assign(existing, rule, { is_active: true });
        await this.pricingRuleRepository.save(existing);
        continue;
      }

      const pricingRule = this.pricingRuleRepository.create(rule);
      await this.pricingRuleRepository.save(pricingRule);
    }

    await this.pricingRuleRepository
      .createQueryBuilder()
      .update(PricingRule)
      .set({ is_active: false })
      .where('city = :city', { city: DEFAULT_PRICING_CITY })
      .andWhere('vehicle_type IN (:...legacyTypes)', { legacyTypes: LEGACY_VEHICLE_TYPES })
      .execute();
  }

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
    await this.ensureDefaultPricingRules();

    const {
      pickup_location,
      drop_location,
      vehicle_type,
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
      where: { vehicle_type, city: DEFAULT_PRICING_CITY, is_active: true },
    });

    if (!pricingRule) {
      throw new NotFoundException(`Pricing rule not found for vehicle type: ${vehicle_type}`);
    }

    // --- Calculate fare breakdown ---
    const baseFare = Number(pricingRule.base_fare);
    const perKmRate = Number(pricingRule.per_km_rate);
    const multiStopFee = Number(pricingRule.multi_stop_fee);
    const nightSurchargePercent = Number(pricingRule.night_surcharge_percent);
    const commissionPercent = Number(pricingRule.commission_percent);

    // 1. Distance charge: Fare = BaseFare + (Distance - BaseKM) × PerKM
    const baseDistanceKm = Number(pricingRule.base_distance_km);
    const chargeableDistance = Math.max(0, distance - baseDistanceKm);
    const distanceCharge = this.round(chargeableDistance * perKmRate);

    // 2. Time cost removed from pricing model
    const timeCharge = 0;

    // 3. Multi-stop charge: fee per extra drop-off
    const multiStopCharge = this.round(extra_stops * multiStopFee);

    // 4. Subtotal before demand adjustment
    let subtotal = baseFare + distanceCharge + multiStopCharge;

    // 6. Demand adjustment (currently applied during night deliveries)
    const isNight = this.isNightTime();
    const demandAdjustmentPercent = isNight ? nightSurchargePercent : 0;
    const demandAdjustment = isNight ? this.round(subtotal * (demandAdjustmentPercent / 100)) : 0;

    // 7. Estimated fare
    let estimatedFare = subtotal + demandAdjustment;

    // 8. Apply any configured surge multiplier
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
        base_distance_km: Number(pricingRule.base_distance_km),
        distance_charge: distanceCharge,
        time_charge: timeCharge,
        multi_stop_charge: multiStopCharge,
        demand_adjustment: demandAdjustment,
        night_surcharge: demandAdjustment,
        waiting_charge: 0, // Calculated at trip completion
        toll_amount: 0, // Added at trip completion
        surge_multiplier: surgeMultiplier,
        subtotal: this.round(subtotal),
        minimum_fare_applied: minimumFare ? estimatedFare === minimumFare : false,
        skido_commission: skidoCommission,
        driver_earnings: driverEarnings,
      },
      pricing_info: {
        minimum_fare: minimumFare,
        free_waiting_minutes: Number(pricingRule.free_waiting_minutes),
        waiting_charge_per_minute: Number(pricingRule.waiting_charge_per_minute),
        multi_stop_fee: multiStopFee,
        demand_adjustment_percent: demandAdjustmentPercent,
        night_surcharge_percent: nightSurchargePercent,
        commission_percent: commissionPercent,
      },
    };
  }

  /**
   * Create booking offer — stores in Redis only. DB record is created only when a driver accepts.
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
      extra_drop_locations = [],
      receiver_name,
      receiver_phone,
      alternative_phone,
    } = createBookingDto;

    // Validate scheduled time
    if (booking_type === BookingType.SCHEDULED) {
      if (!scheduled_time) {
        throw new BadRequestException('Scheduled time is required for scheduled bookings');
      }
      if (new Date(scheduled_time) <= new Date()) {
        throw new BadRequestException('Scheduled time must be in the future');
      }
    }

    const fareEstimate = await this.estimateFare({
      pickup_location,
      drop_location,
      vehicle_type,
      extra_stops: extra_drop_locations.length,
    });

    // Generate OTPs for later (sent via SMS after driver accepts)
    const pickup_otp   = Math.floor(100000 + Math.random() * 900000).toString();
    const delivery_otp = Math.floor(100000 + Math.random() * 900000).toString();

    const offerId = randomUUID();
    const OFFER_TTL_MS = 6 * 60 * 1000; // 6 minutes

    // Store entire offer data in Redis — NO DB write yet
    await this.cacheManager.set(`offer:${offerId}`, {
      customer_id: userId,
      name,
      mobile_number,
      city,
      service_category,
      booking_type,
      vehicle_type,
      pickup_location,
      drop_location,
      pickup_address:    pickup_location.address,
      drop_address:      drop_location.address,
      extra_drop_locations,
      scheduled_time,
      receiver_name,
      receiver_phone,
      alternative_phone,
      distance:         fareEstimate.distance,
      duration:         fareEstimate.duration,
      estimated_fare:   fareEstimate.estimated_fare,
      fare_breakdown:   fareEstimate.breakdown,
      is_night_booking: fareEstimate.is_night_booking,
      pickup_otp,
      delivery_otp,
    }, OFFER_TTL_MS);

    this.logger.log(`Offer created: ${offerId}, type: ${booking_type}, vehicle: ${vehicle_type}`);

    if (booking_type === BookingType.INSTANT) {
      this.bookingGateway.notifyUser(userId, 'searching_for_driver', {
        bookingId: offerId,
        message: 'Finding the nearest driver for you...',
        searchTimeoutSeconds: 60,
      });

      await this.bookingQueue.add('search_timeout', { bookingId: offerId }, { delay: 60000 });

      this.processDriverSearch(offerId, [], vehicle_type, 1).catch(err =>
        this.logger.error(`Driver search failed: ${err.message}`),
      );
    }

    return {
      id:             offerId,
      offer_id:       offerId,
      estimated_fare: fareEstimate.estimated_fare,
      distance:       fareEstimate.distance,
      duration:       fareEstimate.duration,
      status:         'searching',
    };
  }

  /**
   * Get offer/booking status — used by customer to poll while searching for a driver.
   * Returns searching | accepted (with real booking_id) | expired
   */
  async getOfferStatus(offerId: string, userId: string) {
    // Check if offer was accepted → real booking ID stored in Redis
    const realBookingId = await this.cacheManager.get<string>(`offer:accepted:${offerId}`);
    if (realBookingId) {
      return { status: 'accepted', booking_id: realBookingId };
    }

    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (offerData) {
      if (offerData.customer_id !== userId) {
        throw new ForbiddenException('Not authorized');
      }
      return { status: 'searching' };
    }

    return { status: 'expired' };
  }

  /**
   * Cancel an active offer (before any driver accepts).
   */
  async cancelOffer(offerId: string, userId: string) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) {
      return { message: 'Offer not found or already expired' };
    }
    if (offerData.customer_id !== userId) {
      throw new ForbiddenException('Not authorized');
    }
    await this.cleanupOffer(offerId);
    return { message: 'Offer cancelled' };
  }

  private async cleanupOffer(offerId: string) {
    await this.cacheManager.del(`offer:${offerId}`);
    await this.cacheManager.del(`offer:${offerId}:offer`);
    await this.cacheManager.del(`offer:${offerId}:excluded`);
    await this.cacheManager.del(`offer:${offerId}:vehicle_type`);
    await this.cacheManager.del(`offer:${offerId}:broadcast`);
    await this.cacheManager.del(`offer:${offerId}:broadcast_drivers`);
    await this.cacheManager.del(`offer:${offerId}:accepted`);
  }

  /**
   * Process Driver Search — reads offer from Redis (no DB required)
   */
  async processDriverSearch(
    offerId: string,
    excludedDriverIds: string[],
    vehicleType?: string,
    attempt: number = 1,
  ) {
    const MAX_ATTEMPTS = 10;

    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    this.logger.log(`[processDriverSearch] offer=${offerId}, found=${!!offerData}, attempt=${attempt}`);
    if (!offerData) return; // offer accepted or expired

    const resolvedVehicleType = vehicleType || offerData.vehicle_type;
    const { latitude, longitude } = offerData.pickup_location;
    this.logger.log(`[processDriverSearch] pickup=(${latitude},${longitude}), vehicleType: ${resolvedVehicleType}`);

    if (attempt > MAX_ATTEMPTS) {
      await this.broadcastBookingToNearby(offerId, resolvedVehicleType);
      return;
    }

    const nearbyDrivers = await this.findNearbyDrivers(latitude, longitude, 5, resolvedVehicleType);
    this.logger.log(`[processDriverSearch] found ${nearbyDrivers.length} nearby drivers`);

    const eligibleDrivers = nearbyDrivers.filter(
      (driver: any) => !excludedDriverIds.includes(driver.user_id),
    );

    if (eligibleDrivers.length === 0) {
      this.logger.log(`[processDriverSearch] no eligible drivers, broadcasting...`);
      await this.broadcastBookingToNearby(offerId, resolvedVehicleType);
      return;
    }

    const nearestDriver = eligibleDrivers[0];
    this.logger.log(`[processDriverSearch] sending offer to driver ${nearestDriver.user_id}`);
    const newExcluded = [...excludedDriverIds, nearestDriver.user_id];

    await this.cacheManager.set(`offer:${offerId}:offer`,        nearestDriver.user_id, 60000);
    await this.cacheManager.set(`offer:${offerId}:excluded`,     newExcluded,           60000);
    await this.cacheManager.set(`offer:${offerId}:vehicle_type`, resolvedVehicleType,   60000);

    this.bookingGateway.emitBookingOffer(nearestDriver.user_id, {
      bookingId:   offerId,
      pickup:      offerData.pickup_address,
      drop:        offerData.drop_address,
      fare:        offerData.estimated_fare,
      distance:    offerData.distance,
      vehicleType: resolvedVehicleType,
      timeLeft:    15,
    });
    this.logger.log(`[processDriverSearch] offer emitted to driver ${nearestDriver.user_id}`);

    await this.bookingQueue.add(
      'offer_timeout',
      {
        bookingId:        offerId,
        driverId:         nearestDriver.user_id,
        excludedDriverIds: newExcluded,
        vehicleType:      resolvedVehicleType,
        attempt:          attempt + 1,
      },
      { delay: 15000 },
    );
  }

  /**
   * Handle Offer Timeout (Job Processor) — reads from Redis
   */
  async handleOfferTimeout(
    offerId: string,
    driverId: string,
    excludedDriverIds: string[],
    vehicleType?: string,
    attempt: number = 1,
  ) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) return; // offer accepted or expired

    const currentOfferDriver = await this.cacheManager.get(`offer:${offerId}:offer`);
    if (currentOfferDriver === driverId) {
      await this.cacheManager.del(`offer:${offerId}:offer`);
      await this.cacheManager.del(`offer:${offerId}:excluded`);
      await this.cacheManager.del(`offer:${offerId}:vehicle_type`);

      this.bookingGateway.notifyUser(driverId, 'offer_expired', { bookingId: offerId });

      await this.bookingQueue.add('search_driver', {
        bookingId: offerId,
        excludedDriverIds,
        vehicleType,
        attempt,
      });
    }
  }

  /**
   * Broadcast a booking offer to ALL nearby online drivers when sequential search exhausted.
   * Still no DB record — just Redis + WebSocket.
   */
  private async broadcastBookingToNearby(offerId: string, vehicleType?: string) {
    const BROADCAST_TTL_MS = 5 * 60 * 1000;

    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) return; // offer accepted or expired

    const { latitude, longitude } = offerData.pickup_location;
    const nearbyDrivers = await this.findNearbyDrivers(latitude, longitude, 10, vehicleType);

    if (nearbyDrivers.length === 0) {
      // No drivers to broadcast to — leave offer in Redis and let the
      // search_timeout job (60s) handle cleanup and customer notification.
      this.logger.log(`[broadcastBookingToNearby] No nearby drivers for offer ${offerId}, awaiting search_timeout`);
      return;
    }

    const driverIds = nearbyDrivers.map((d: any) => d.user_id);

    await this.cacheManager.set(`offer:${offerId}:broadcast`,         true,      BROADCAST_TTL_MS);
    await this.cacheManager.set(`offer:${offerId}:broadcast_drivers`, driverIds, BROADCAST_TTL_MS);

    const payload = {
      bookingId: offerId,
      pickup:    offerData.pickup_address,
      drop:      offerData.drop_address,
      fare:      offerData.estimated_fare,
      distance:  offerData.distance,
      vehicleType,
    };

    for (const driverId of driverIds) {
      this.bookingGateway.notifyUser(driverId, 'booking_available', payload);

      // Track per-driver so getAvailableBookings() can return them
      const existing = (await this.cacheManager.get<string[]>(`driver:broadcasts:${driverId}`)) || [];
      if (!existing.includes(offerId)) {
        await this.cacheManager.set(`driver:broadcasts:${driverId}`, [...existing, offerId], BROADCAST_TTL_MS);
      }
    }

    this.logger.log(`Broadcast offer ${offerId} to ${driverIds.length} nearby drivers`);

    await this.bookingQueue.add('broadcast_timeout', { bookingId: offerId }, { delay: BROADCAST_TTL_MS });
  }

  /**
   * Hard 60-second search timeout — offer expires, no DB record to delete.
   */
  async handleSearchTimeout(offerId: string) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) return; // offer accepted or already cleaned up

    this.logger.log(`[SearchTimeout] 60s expired for offer ${offerId}`);

    this.bookingGateway.notifyUser(offerData.customer_id, 'search_timeout', {
      bookingId: offerId,
      message: 'No drivers found within 60 seconds. Please try again.',
    });

    await this.cleanupOffer(offerId);
  }

  /**
   * Broadcast TTL expired — nobody accepted, clean up Redis only.
   */
  async handleBroadcastTimeout(offerId: string) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) return; // offer accepted or already cleaned up

    this.bookingGateway.notifyUser(offerData.customer_id, 'no_drivers_found', {
      bookingId: offerId,
      message: 'No drivers accepted your booking. Please try again.',
    });

    await this.cleanupOffer(offerId);
  }

  /**
   * Get available broadcast offers for a driver (notification screen).
   * Reads from Redis — no DB query needed since bookings aren't in DB yet.
   */
  async getAvailableBookings(driverUserId: string) {
    const broadcastOfferIds =
      (await this.cacheManager.get<string[]>(`driver:broadcasts:${driverUserId}`)) || [];

    const results: any[] = [];
    for (const offerId of broadcastOfferIds) {
      const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
      if (!offerData) continue;
      const isBroadcast = await this.cacheManager.get(`offer:${offerId}:broadcast`);
      if (!isBroadcast) continue;

      results.push({
        id:              offerId,
        offer_id:        offerId,
        pickup_address:  offerData.pickup_address,
        drop_address:    offerData.drop_address,
        estimated_fare:  offerData.estimated_fare,
        distance:        offerData.distance,
        vehicle_type:    offerData.vehicle_type,
        city:            offerData.city,
        service_category: offerData.service_category,
      });
    }

    return results;
  }

  /**
   * Helper to find nearby drivers filtered by vehicle type
   */
  private async findNearbyDrivers(
    lat: number,
    lng: number,
    radiusKm: number,
    vehicleType?: string,
  ) {
    const params: any[] = [lng, lat, radiusKm * 1000];
    let vehicleFilter = '';

    if (vehicleType) {
      params.push(vehicleType);
      vehicleFilter = `AND v.vehicle_type = $4`;
    }

    return this.bookingRepository.manager.query(
      `
      SELECT dp.user_id,
             ST_Distance(
               dp.current_location,
               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
             ) AS distance
      FROM driver_profiles dp
      JOIN vehicles v ON v.id = dp.vehicle_id
        AND v.verification_status = 'approved'
        ${vehicleFilter}
      WHERE dp.availability_status = 'online'
      AND ST_DWithin(
        dp.current_location,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
      ORDER BY distance ASC
      LIMIT 10
      `,
      params,
    );
  }

  /**
   * Get booking by ID — includes driver profile stats (rating, total trips).
   * Also handles offer IDs (before driver accepts) by checking Redis.
   */
  async getById(bookingId: string, userId: string): Promise<any> {
    // Check if this is an offer still in Redis (searching state)
    const offerData = await this.cacheManager.get<any>(`offer:${bookingId}`);
    if (offerData) {
      if (offerData.customer_id !== userId) {
        throw new ForbiddenException('You do not have access to this booking');
      }
      return {
        id:              bookingId,
        status:          'searching',
        pickup_address:  offerData.pickup_address,
        drop_address:    offerData.drop_address,
        estimated_fare:  offerData.estimated_fare,
        distance:        offerData.distance,
        vehicle_type:    offerData.vehicle_type,
        customer_id:     userId,
      };
    }

    // Check if offer was accepted — redirect to the real booking
    const realBookingId = await this.cacheManager.get<string>(`offer:accepted:${bookingId}`);
    if (realBookingId) {
      return this.getById(realBookingId, userId);
    }

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

    // Attach driver profile stats if driver is assigned
    let driverStats: { average_rating: number | null; total_trips: number } | null = null;
    if (booking.driver_id) {
      const [profile] = await this.bookingRepository.manager.query(
        `SELECT average_rating, total_trips FROM driver_profiles WHERE user_id = $1 LIMIT 1`,
        [booking.driver_id],
      );
      if (profile) {
        driverStats = {
          average_rating: profile.average_rating ? parseFloat(profile.average_rating) : null,
          total_trips: parseInt(profile.total_trips, 10) || 0,
        };
      }
    }

    return {
      ...booking,
      driver_stats: driverStats,
      pickup_otp: booking.pickup_otp,
      delivery_otp: booking.delivery_otp,
    };
  }

  /**
   * Cancel booking or offer
   */
  async cancel(bookingId: string, userId: string, cancelDto: CancelBookingDto) {
    // If this is a Redis offer (not yet in DB), cancel the offer
    const offerData = await this.cacheManager.get<any>(`offer:${bookingId}`);
    if (offerData) {
      if (offerData.customer_id !== userId) throw new ForbiddenException('Not authorized');
      await this.cleanupOffer(bookingId);
      return { message: 'Booking offer cancelled' };
    }

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
   * Get driver's active booking — includes payment status, receiver info, and delivery OTP
   */
  async getDriverActiveBooking(userId: string) {
    const booking = await this.bookingRepository.findOne({
      where: [
        { driver_id: userId, status: BookingStatus.ONGOING },
        { driver_id: userId, status: BookingStatus.ACCEPTED },
        { driver_id: userId, status: BookingStatus.DRIVER_ASSIGNED },
      ],
      relations: ['customer', 'vehicle', 'payments'],
      order: { booking_time: 'DESC' },
    });

    if (!booking) return null;

    const isAlreadyPaid = booking.payments?.some(p => p.payment_status === 'completed') ?? false;

    return {
      ...booking,
      is_already_paid: isAlreadyPaid,
      pickup_otp: booking.pickup_otp,
      pickup_otp_verified: booking.pickup_otp_verified,
      delivery_otp: booking.delivery_otp,
      receiver_name: booking.receiver_name,
      receiver_phone: booking.receiver_phone,
      alternative_phone: booking.alternative_phone,
    };
  }

  /**
   * Accept booking (driver) — reads offer from Redis, creates DB record for the first time.
   */
  async acceptBooking(offerId: string, driverId: string, vehicleId: string) {
    // Get offer from Redis
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) {
      // Might be a real DB booking (e.g., scheduled) — fall back to DB check
      let booking: Booking | null = null;
      try {
        booking = await this.bookingRepository.findOne({ where: { id: offerId } });
      } catch {}
      if (!booking) throw new NotFoundException('Booking offer not found or already accepted');
      if (booking.status !== BookingStatus.PENDING) {
        throw new BadRequestException(`Booking is no longer available (status: ${booking.status})`);
      }
      // Existing DB booking — handle via old path
      booking.status = BookingStatus.ACCEPTED;
      booking.driver_id = driverId;
      booking.vehicle_id = vehicleId;
      booking.acceptance_time = new Date();
      const saved = await this.bookingRepository.save(booking);
      this.bookingGateway.notifyUser(booking.customer_id, 'booking_accepted', {
        bookingId: booking.id, offerId, driverId,
      });
      return saved;
    }

    // Race-condition guard: mark as being accepted
    const alreadyAccepting = await this.cacheManager.get(`offer:${offerId}:accepting`);
    if (alreadyAccepting) {
      throw new BadRequestException('Booking is being accepted by another driver');
    }
    await this.cacheManager.set(`offer:${offerId}:accepting`, driverId, 10000); // 10s lock

    // Block driver from accepting if they already have an active order
    const existingActive = await this.bookingRepository.findOne({
      where: [
        { driver_id: driverId, status: BookingStatus.ACCEPTED },
        { driver_id: driverId, status: BookingStatus.DRIVER_ASSIGNED },
        { driver_id: driverId, status: BookingStatus.ONGOING },
      ],
    });
    if (existingActive) {
      await this.cacheManager.del(`offer:${offerId}:accepting`);
      throw new BadRequestException(
        'You already have an active order. Complete it before accepting a new one.',
      );
    }

    const isBroadcast = await this.cacheManager.get<boolean>(`offer:${offerId}:broadcast`);
    if (!isBroadcast) {
      const offeredDriverId = await this.cacheManager.get(`offer:${offerId}:offer`);
      if (offeredDriverId && offeredDriverId !== driverId) {
        await this.cacheManager.del(`offer:${offerId}:accepting`);
        throw new BadRequestException('Offer expired or assigned to another driver');
      }
    }

    // ── Create the booking in DB for the first time ──────────────────────────
    try {
      const booking = this.bookingRepository.create({
        customer_id:     offerData.customer_id,
        name:            offerData.name,
        mobile_number:   offerData.mobile_number,
        city:            offerData.city,
        service_category: offerData.service_category,
        booking_type:    offerData.booking_type,
        vehicle_type:    offerData.vehicle_type,
        pickup_address:  offerData.pickup_address,
        drop_address:    offerData.drop_address,
        distance:        offerData.distance,
        duration:        offerData.duration,
        estimated_fare:  offerData.estimated_fare,
        fare_breakdown:  offerData.fare_breakdown,
        number_of_helpers: 0,
        extra_stops_count: (offerData.extra_drop_locations || []).length,
        is_night_booking: offerData.is_night_booking,
        status:          BookingStatus.ACCEPTED,
        scheduled_time:  offerData.scheduled_time ? new Date(offerData.scheduled_time) : undefined,
        receiver_name:   offerData.receiver_name,
        receiver_phone:  offerData.receiver_phone,
        alternative_phone: offerData.alternative_phone,
        pickup_otp:      offerData.pickup_otp,
        pickup_otp_verified: false,
        delivery_otp:    offerData.delivery_otp,
        otp_verified:    false,
        driver_id:       driverId,
        vehicle_id:      vehicleId,
        acceptance_time: new Date(),
      });

      await this.bookingRepository
        .createQueryBuilder()
        .insert()
        .into(Booking)
        .values({
          ...booking,
          pickup_location: () =>
            `ST_SetSRID(ST_MakePoint(${offerData.pickup_location.longitude}, ${offerData.pickup_location.latitude}), 4326)`,
          drop_location: () =>
            `ST_SetSRID(ST_MakePoint(${offerData.drop_location.longitude}, ${offerData.drop_location.latitude}), 4326)`,
        })
        .execute();

      const createdBooking = await this.bookingRepository.findOne({
        where: { customer_id: offerData.customer_id, driver_id: driverId },
        order: { created_at: 'DESC' },
        relations: ['customer'],
      });

      if (!createdBooking) throw new Error('Failed to retrieve created booking');

      // Send OTP SMS now that booking is confirmed
      const smsPhone = offerData.mobile_number;
      const smsBody =
        `Your Zipto booking is confirmed!\n` +
        `Pickup OTP: *${offerData.pickup_otp}* — Share with driver when they arrive.\n` +
        `Delivery OTP: *${offerData.delivery_otp}* — Share with driver ONLY when package is delivered.`;
      this.smsService.sendSms(smsPhone, smsBody).catch(err =>
        this.logger.warn(`Failed to send OTP SMS: ${err?.message}`),
      );

      // Store accepted mapping so customer can resolve offer_id → booking_id
      await this.cacheManager.set(`offer:accepted:${offerId}`, createdBooking.id, 10 * 60 * 1000);

      // Notify customer with real booking ID
      this.bookingGateway.notifyUser(offerData.customer_id, 'booking_accepted', {
        bookingId: createdBooking.id,
        offerId,
        driverId,
      });

      // Notify other broadcast drivers that booking is taken
      if (isBroadcast) {
        const broadcastDrivers =
          (await this.cacheManager.get<string[]>(`offer:${offerId}:broadcast_drivers`)) || [];
        for (const dId of broadcastDrivers) {
          if (dId !== driverId) {
            this.bookingGateway.notifyUser(dId, 'booking_taken', { bookingId: offerId });
          }
        }
      }

      // Clean up Redis (but keep offer:accepted mapping for customer polling)
      await this.cacheManager.del(`offer:${offerId}`);
      await this.cacheManager.del(`offer:${offerId}:offer`);
      await this.cacheManager.del(`offer:${offerId}:excluded`);
      await this.cacheManager.del(`offer:${offerId}:vehicle_type`);
      await this.cacheManager.del(`offer:${offerId}:broadcast`);
      await this.cacheManager.del(`offer:${offerId}:broadcast_drivers`);
      await this.cacheManager.del(`offer:${offerId}:accepting`);

      return createdBooking;
    } catch (dbError: any) {
      await this.cacheManager.del(`offer:${offerId}:accepting`);
      this.logger.error(`acceptBooking DB error: ${dbError?.message}`);
      throw new BadRequestException('Failed to confirm booking. Please try again.');
    }
  }

  /**
   * Reject booking (driver) — reads from Redis
   */
  async rejectBooking(offerId: string, driverId: string) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) {
      return { message: 'Booking offer no longer available' };
    }

    const offeredDriverId = await this.cacheManager.get(`offer:${offerId}:offer`);
    if (offeredDriverId !== driverId) {
      return { message: 'Offer not assigned to you' };
    }

    const excludedDriverIds =
      (await this.cacheManager.get<string[]>(`offer:${offerId}:excluded`)) || [driverId];
    const vehicleType =
      (await this.cacheManager.get<string>(`offer:${offerId}:vehicle_type`)) ||
      offerData.vehicle_type;

    await this.cacheManager.del(`offer:${offerId}:offer`);
    await this.cacheManager.del(`offer:${offerId}:excluded`);
    await this.cacheManager.del(`offer:${offerId}:vehicle_type`);

    await this.bookingQueue.add('search_driver', {
      bookingId: offerId,
      excludedDriverIds,
      vehicleType,
      attempt: excludedDriverIds.length + 1,
    });

    return { message: 'Booking rejected' };
  }

  /**
   * Start trip — driver must provide pickup OTP received from customer
   */
  async startTrip(bookingId: string, driverId: string, pickupOtp: string) {
    // Resolve offerId → real bookingId (driver may still hold the offer UUID)
    let resolvedId = bookingId;
    let booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
    });

    if (!booking) {
      const realId = await this.cacheManager.get<string>(`offer:accepted:${bookingId}`);
      if (realId) {
        resolvedId = realId;
        booking = await this.bookingRepository.findOne({
          where: { id: realId, driver_id: driverId },
        });
      }
    }

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    const allowedStatuses = [BookingStatus.ACCEPTED, BookingStatus.DRIVER_ASSIGNED];
    if (!allowedStatuses.includes(booking.status)) {
      throw new BadRequestException(`Cannot start trip with status: ${booking.status}`);
    }

    const otpInput = (pickupOtp || '').trim();
    const storedOtp = (booking.pickup_otp || '').trim();

    this.logger.log(
      `[startTrip] booking=${bookingId} storedOTP="${storedOtp}" receivedOTP="${otpInput}"`,
    );

    if (!otpInput || otpInput.length < 4) {
      throw new BadRequestException('Pickup OTP is required to start the trip');
    }

    if (storedOtp && storedOtp !== otpInput) {
      throw new BadRequestException(
        `Invalid pickup OTP. Expected: ${storedOtp} | Got: ${otpInput}`,
      );
    }

    booking.status = BookingStatus.ONGOING;
    booking.start_time = new Date();
    booking.pickup_otp_verified = true;

    return this.bookingRepository.save(booking);
  }

  /**
   * Complete trip — Calculates final fare with waiting charges, toll, and Skido commission
   */
  async completeTrip(bookingId: string, driverId: string, completeTripDto?: CompleteTripDto) {
    await this.ensureDefaultPricingRules();

    // Resolve offerId → real bookingId
    let booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
      relations: ['vehicle'],
    });

    if (!booking) {
      const realId = await this.cacheManager.get<string>(`offer:accepted:${bookingId}`);
      if (realId) {
        booking = await this.bookingRepository.findOne({
          where: { id: realId, driver_id: driverId },
          relations: ['vehicle'],
        });
      }
    }

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== BookingStatus.ONGOING) {
      throw new BadRequestException(`Cannot complete trip with status: ${booking.status}`);
    }

    // Verify delivery OTP
    const deliveryOtp = completeTripDto?.delivery_otp;
    if (!deliveryOtp) {
      throw new BadRequestException('Delivery OTP is required to complete the trip');
    }
    if (booking.delivery_otp && booking.delivery_otp !== deliveryOtp) {
      throw new BadRequestException('Invalid delivery OTP. Please ask the sender for the correct OTP.');
    }

    // Get pricing rule for waiting charge calculation
    const pricingRule = booking.vehicle?.vehicle_type
      ? await this.pricingRuleRepository.findOne({
          where: {
            vehicle_type: booking.vehicle.vehicle_type,
            city: booking.city || DEFAULT_PRICING_CITY,
            is_active: true,
          },
        })
      : null;

    // Extract completion data
    const hasToll = completeTripDto?.has_toll || false;
    const tollAmount = hasToll ? completeTripDto?.toll_amount || 0 : 0;
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

    // Calculate platform commission and driver earnings
    const commissionPercent = pricingRule ? Number(pricingRule.commission_percent) : 25;
    const skidoCommission = this.round(finalFare * (commissionPercent / 100));
    const driverEarnings = this.round(finalFare - skidoCommission);

    // Update fare breakdown
    const fareBreakdown = booking.fare_breakdown || ({} as any);
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
    booking.otp_verified = true;

    const savedBooking = await this.bookingRepository.save(booking);

    // Auto-record cash payment if driver chose cash at delivery
    const paymentMethod = completeTripDto?.payment_method;
    const alreadyPaid = await this.paymentRepository.findOne({
      where: { booking_id: bookingId, payment_status: PaymentStatus.COMPLETED },
    });
    if (!alreadyPaid && paymentMethod === 'cash') {
      const cashPayment = this.paymentRepository.create({
        booking_id: bookingId,
        amount: finalFare,
        driver_earnings: driverEarnings,
        payment_method: PaymentMethod.CASH,
        payment_status: PaymentStatus.COMPLETED,
      });
      await this.paymentRepository.save(cashPayment);
    }

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
      .where('booking.customer_id = :userId', { userId })
      // Exclude system auto-cancelled (no driver found) bookings
      .andWhere(
        "(booking.cancellation_reason NOT ILIKE '%no driver%' OR booking.cancellation_reason IS NULL)",
      );

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

  async getPublicPricingRules() {
    await this.ensureDefaultPricingRules();

    const rules = await this.pricingRuleRepository.find({
      where: {
        city: DEFAULT_PRICING_CITY,
        is_active: true,
        vehicle_type: In([...PUBLIC_VEHICLE_TYPES]),
      },
    });

    return rules.sort(
      (left, right) =>
        getVehicleTypeSortOrder(left.vehicle_type) - getVehicleTypeSortOrder(right.vehicle_type),
    );
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
