import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PaymentService } from '../payment/payment.service';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Booking, BookingStatus, BookingType } from './entities/booking.entity';
import { PricingRule } from './entities/pricing-rule.entity';
import { Payment, PaymentMethod, PaymentStatus } from '../payment/entities/payment.entity';
import { User } from '../auth/entities/user.entity';
import {
  EstimateFareDto,
  CreateBookingDto,
  CancelBookingDto,
  CompleteTripDto,
} from './dto/booking.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { MapboxService } from '../../services/mapbox.service';
import { SmsService } from '../../services/sms.service';
import { ExotelService } from '../../services/exotel.service';
import { CoinService } from '../coin/coin.service';
import { ReferralService } from '../referral/referral.service';
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
import { FraudService } from '../fraud/fraud.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import { DriverFraudService } from '../driver-fraud/driver-fraud.service';
import { NotificationService } from '../notification/notification.service';
import { ZiptoShieldService, SHIELD_CONTRIBUTION_PER_BOOKING } from '../zipto-shield/zipto-shield.service';
import { DriverWalletService } from '../driver/driver-wallet.service';
import { CouponService } from '../coupon/coupon.service';
import { EmailService } from '../../services/email.service';
import { S3Service } from '../../services/s3.service';
import { buildInvoiceData, renderInvoiceHtml, buildInvoicePdf, invoiceFileName } from '../../common/utils/invoice.util';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);
  private pricingRulesInitialized = false;
  private pricingRulesSyncPromise?: Promise<void>;

  constructor(
    @Inject(forwardRef(() => PaymentService))
    private paymentService: PaymentService,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(PricingRule)
    private pricingRuleRepository: Repository<PricingRule>,
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private mapboxService: MapboxService,
    private smsService: SmsService,
    private exotelService: ExotelService,
    private coinService: CoinService,
    private referralService: ReferralService,
    @InjectQueue('booking_assignment') private bookingQueue: Queue,
    private bookingGateway: BookingGateway,
    private cacheManager: RedisService,
    private fraudService: FraudService,
    private systemSettings: SystemSettingsService,
    private driverFraudService: DriverFraudService,
    private notificationService: NotificationService,
    private ziptoShieldService: ZiptoShieldService,
    private driverWalletService: DriverWalletService,
    private couponService: CouponService,
    private emailService: EmailService,
    private s3Service: S3Service,
  ) {}

  /**
   * Email the GST/tax invoice to the customer once a delivery is completed.
   * Fire-and-forget — never blocks or fails trip completion. Skips silently if
   * the customer has no email on file.
   */
  private async emailInvoiceOnDelivery(bookingId: string): Promise<void> {
    try {
      const payment = await this.paymentRepository.findOne({
        where: { booking_id: bookingId },
        relations: ['booking', 'booking.customer'],
        order: { created_at: 'DESC' },
      });
      if (!payment || !payment.booking) return;

      const booking = payment.booking;
      const email = booking.customer?.email;
      if (!email) return; // phone-only customer — nothing to email

      const tax = await this.systemSettings.getTaxSettings();
      const invoice = buildInvoiceData(booking, payment, tax);
      const html = renderInvoiceHtml(invoice);
      const subject = `${invoice.is_tax_invoice ? 'Tax Invoice' : 'Invoice'} ${invoice.invoice_number} — Zipto`;

      // Attach the invoice as a PDF so the customer has a filable copy.
      let attachments: Array<{ filename: string; content: Buffer; contentType?: string }> | undefined;
      try {
        const pdf = await buildInvoicePdf(invoice);
        attachments = [{ filename: invoiceFileName(invoice), content: pdf, contentType: 'application/pdf' }];
      } catch (e: any) {
        this.logger.warn(`[Invoice] PDF attach failed for ${bookingId} (sending without): ${e?.message ?? e}`);
      }

      await this.emailService.sendMail(email, subject, html, undefined, attachments);
      this.logger.log(`[Invoice] Emailed ${invoice.invoice_number} to ${email} for booking ${bookingId}`);
    } catch (err: any) {
      this.logger.warn(`[Invoice] Email-on-delivery failed for ${bookingId}: ${err?.message ?? err}`);
    }
  }

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
    return Math.round(value);
  }

  /** Round to 2 decimal places (money values like GST that aren't whole rupees). */
  private round2(value: number): number {
    return Math.round((Number(value) || 0) * 100) / 100;
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

    // Get distance and duration from Google Directions API
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

    // --- Platform fee + GST (admin-configurable) ---
    // GST applies to the TAXABLE VALUE = delivery charge + platform fee — a
    // pass-through tax collected on top. (The Zipto Shield is NOT in the taxable
    // value; it stays a driver-side deduction.) Commission/driver earnings are on
    // the pre-GST delivery charge (GST is remitted to the government).
    const fareSettings = await this.systemSettings.getFareSettings();
    const platformFee = this.round(fareSettings.platform_fee);
    const gstPercent = fareSettings.gst_percent;

    // --- Calculate fare breakdown ---
    const baseFare = Number(pricingRule.base_fare);
    const perKmRate = Number(pricingRule.per_km_rate);
    const multiStopFee = Number(pricingRule.multi_stop_fee);
    const commissionPercent = Number(pricingRule.commission_percent);

    // 1. Distance charge: max(0, distance - baseKM) × perKM
    const baseDistanceKm = Number(pricingRule.base_distance_km);
    const chargeableDistance = Math.max(0, distance - baseDistanceKm);
    const distanceCharge = this.round(chargeableDistance * perKmRate);

    // 2. Multi-stop charge
    const multiStopCharge = this.round(extra_stops * multiStopFee);

    // 3. Delivery charge (driver's service) = (base + distance + multi-stop) × surge.
    //    (Minimum fare removed — the delivery charge is no longer floored.)
    const deliveryBeforeSurge = baseFare + distanceCharge + multiStopCharge;
    const surgeMultiplier = await this.calculateSurgeMultiplier();
    const deliveryCharge = this.round(deliveryBeforeSurge * surgeMultiplier);
    const minimumFareApplied = false;

    // 5. Taxable value = delivery charge + platform fee (both are taxable supply).
    const taxableValue = this.round2(deliveryCharge + platformFee);

    // 6. GST on the taxable value. Intra-state supply → CGST + SGST, each computed
    //    INDEPENDENTLY at gst%/2 to 2 decimals. (Never round the total then halve
    //    it — that skews the split.) GST total is the sum so the invoice foots.
    const halfRate = gstPercent / 2;
    const cgstAmount = this.round2(taxableValue * (halfRate / 100));
    const sgstAmount = this.round2(taxableValue * (halfRate / 100));
    const gstAmount = this.round2(cgstAmount + sgstAmount);

    // 7. Total the customer pays = taxable value + GST (platform fee is already
    //    inside the taxable value, so it is NOT added again).
    const estimatedFare = this.round2(taxableValue + gstAmount);

    // 7. Commission split on the delivery charge (pre-GST, excl. platform fee).
    //    The Zipto Shield fee is also deducted from the driver (funds the shield
    //    pool), so the quoted earning matches what completeTrip actually pays.
    //      riderEarning = delivery − commission − shield
    //      ziptoRevenue = commission + platformFee + shield
    const skidoCommission = this.round2(deliveryCharge * (commissionPercent / 100));
    const driverEarnings = this.round2(
      deliveryCharge - skidoCommission - SHIELD_CONTRIBUTION_PER_BOOKING,
    );

    // 8. Driver availability — parallel check at search radius (does not block fare calc)
    let nearbyDriverCount = 0;
    try {
      const settings = await this.systemSettings.getDispatchSettings();
      const drivers = await this.findNearbyDrivers(
        pickup_location.latitude,
        pickup_location.longitude,
        settings.search_radius_km,
        vehicle_type,
      );
      nearbyDriverCount = drivers.length;
    } catch {
      // availability check is best-effort; never fail the fare response
      nearbyDriverCount = 0;
    }

    return {
      distance: this.round(distance),
      duration,
      estimated_fare: estimatedFare,
      drivers_available: nearbyDriverCount > 0,
      nearby_driver_count: nearbyDriverCount,
      breakdown: {
        base_fare: baseFare,
        base_distance_km: baseDistanceKm,
        distance_charge: distanceCharge,
        time_charge: 0,
        multi_stop_charge: multiStopCharge,
        delivery_charge: deliveryCharge,
        platform_fee: platformFee,
        taxable_value: taxableValue, // delivery + platform (GST base)
        gst_percent: gstPercent,
        gst_amount: gstAmount,
        cgst_amount: cgstAmount,
        sgst_amount: sgstAmount,
        platform_fee_gst: gstAmount, // backward-compat alias (now = GST on taxable value)
        surge_multiplier: surgeMultiplier,
        subtotal: deliveryCharge,
        total_payable: estimatedFare,
        minimum_fare_applied: minimumFareApplied,
        skido_commission: skidoCommission,
        shield_fee: SHIELD_CONTRIBUTION_PER_BOOKING,
        driver_earnings: driverEarnings,
      },
      pricing_info: {
        minimum_fare: null,
        free_waiting_minutes: Number(pricingRule.free_waiting_minutes),
        waiting_charge_per_minute: Number(pricingRule.waiting_charge_per_minute),
        multi_stop_fee: multiStopFee,
        commission_percent: commissionPercent,
      },
    };
  }

  /**
   * Dynamic surge multiplier based on peak hours and live demand.
   * Levels: 1.0 (normal) → 1.2 (light) → 1.3 (medium) → 1.4 (high) → 1.6 (peak)
   */
  private async calculateSurgeMultiplier(): Promise<number> {
    const hour = new Date().getHours(); // 0-23 local server time

    // Peak-hour time surges
    let timeSurge = 1.0;
    if (hour >= 8 && hour < 10) timeSurge = 1.2;   // Morning rush
    if (hour >= 18 && hour < 21) timeSurge = 1.3;  // Evening rush

    // Demand-based surge: count active pending bookings in DB
    let demandSurge = 1.0;
    try {
      const activeCount = await this.bookingRepository.count({
        where: { status: In([BookingStatus.PENDING, BookingStatus.ACCEPTED, BookingStatus.DRIVER_ASSIGNED]) },
      });
      if (activeCount >= 30) demandSurge = 1.6;
      else if (activeCount >= 20) demandSurge = 1.4;
      else if (activeCount >= 12) demandSurge = 1.3;
      else if (activeCount >= 6) demandSurge = 1.2;
    } catch {
      // If query fails, fall back to time-only surge
    }

    // Use the higher of time-based or demand-based surge, cap at 1.6
    return Math.min(1.6, Math.max(timeSurge, demandSurge));
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
      paid_by = 'sender',
      coins_to_redeem = 0,
      coupon_code,
      gstin,
    } = createBookingDto;

    // Diagnostic log — remove after confirming receiver_phone flows correctly
    this.logger.log(`[create] receiver_name="${receiver_name}" receiver_phone="${receiver_phone}" mobile_number="${mobile_number}"`);

    // Validate scheduled time
    if (booking_type === BookingType.SCHEDULED) {
      if (!scheduled_time) {
        throw new BadRequestException('Scheduled time is required for scheduled bookings');
      }
      const scheduledDate = new Date(scheduled_time);
      if (scheduledDate <= new Date()) {
        throw new BadRequestException('Scheduled time must be in the future');
      }
      const maxScheduleDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      if (scheduledDate > maxScheduleDate) {
        throw new BadRequestException('Scheduled time cannot be more than 30 days in the future');
      }
    }

    // Validate coin redemption
    let validatedCoins = 0;
    let coinDiscount = 0;
    if (coins_to_redeem > 0) {
      if (coins_to_redeem < 100) {
        throw new BadRequestException('Minimum 100 coins required to apply discount');
      }
      // Round down to nearest 100
      validatedCoins = Math.floor(coins_to_redeem / 100) * 100;
      // Check user balance
      const user = await this.userRepository.findOne({ where: { id: userId }, select: ['coins'] });
      if (!user || user.coins < validatedCoins) {
        throw new BadRequestException(`Insufficient coins. You have ${user?.coins ?? 0} coins`);
      }
      coinDiscount = Math.round(validatedCoins * CoinService.COINS_TO_RUPEES_RATE);
    }

    const fareEstimate = await this.estimateFare({
      pickup_location,
      drop_location,
      vehicle_type,
      extra_stops: extra_drop_locations.length,
    });

    // Validate coupon (if provided) against the raw fare before coin discount
    let couponDiscount  = 0;
    let appliedCouponId: string | null = null;
    let appliedCouponCode: string | null = null;
    if (coupon_code) {
      const result = await this.couponService._validateInternal(userId, {
        code:         coupon_code,
        order_value:  fareEstimate.estimated_fare,
        vehicle_type,
      });
      couponDiscount    = result.discount_amount;
      appliedCouponId   = result.coupon_id;
      appliedCouponCode = result.code;
    }

    // Generate OTPs for later (sent via SMS after driver accepts)
    const pickup_otp   = Math.floor(100000 + Math.random() * 900000).toString();
    const delivery_otp = Math.floor(100000 + Math.random() * 900000).toString();

    const offerId = randomUUID();
    const OFFER_TTL_MS = 6 * 60 * 1000; // 6 minutes

    // Apply coin + coupon discount to estimated fare (floor at 0). Keep 2-decimal
    // precision — online charges this exact value; cash collects it rounded up.
    const discountedFare = Math.max(
      0,
      this.round2(fareEstimate.estimated_fare - coinDiscount - couponDiscount),
    );

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
      paid_by,
      customer_gstin:   (gstin || '').trim().toUpperCase() || null,
      distance:         fareEstimate.distance,
      duration:         fareEstimate.duration,
      estimated_fare:   discountedFare,
      fare_breakdown:   fareEstimate.breakdown,
      pickup_otp,
      delivery_otp,
      coins_to_redeem:  validatedCoins,
      coin_discount:    coinDiscount,
      coupon_code:      appliedCouponCode,
      coupon_id:        appliedCouponId,
      coupon_discount:  couponDiscount,
    }, OFFER_TTL_MS);

    // Track active offer per customer so the status banner can find it
    await this.cacheManager.set(`customer:active_offer:${userId}`, offerId, OFFER_TTL_MS);

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
   * Returns searching | accepted | timed_out | expired
   */
  async getOfferStatus(offerId: string, userId: string) {
    const realBookingId = await this.cacheManager.get<string>(`offer:accepted:${offerId}`);
    if (realBookingId) {
      return { status: 'accepted', booking_id: realBookingId };
    }

    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (offerData) {
      if (offerData.customer_id !== userId) throw new ForbiddenException('Not authorized');

      if (offerData.timed_out) {
        const retryCount = offerData.retry_count || 0;
        return {
          status: 'timed_out',
          current_fare: offerData.estimated_fare,
          suggested_fare: Math.round(offerData.estimated_fare + 10),
          retry_count: retryCount,
          can_retry: true,
        };
      }

      return { status: 'searching' };
    }

    return { status: 'expired' };
  }

  /**
   * Increase the fare of an active offer mid-search.
   * Updates Redis immediately so the next driver who sees the offer gets the new fare.
   */
  async updateOfferFare(offerId: string, customerId: string, newFare: number) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) throw new NotFoundException('Offer not found or expired');
    if (offerData.customer_id !== customerId) throw new ForbiddenException('Not authorized');
    if (newFare <= offerData.estimated_fare) throw new BadRequestException('New fare must be higher than current fare');

    await this.cacheManager.set(`offer:${offerId}`, {
      ...offerData,
      estimated_fare: newFare,
    }, 100_000); // refresh TTL

    this.logger.log(`[UpdateFare] offer=${offerId} fare ${offerData.estimated_fare} → ${newFare}`);
    return { success: true, new_fare: newFare };
  }

  /**
   * Retry driver search with an increased fare (up to 3 retries).
   */
  async retrySearch(offerId: string, customerId: string, newFare: number) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) throw new NotFoundException('Offer not found or expired');
    if (offerData.customer_id !== customerId) throw new ForbiddenException('Not authorized');

    const retryCount = (offerData.retry_count || 0) + 1;

    const TTL_MS = 160_000; // 60s search + 10s buffer + 90s grace for next timeout

    await this.cacheManager.set(`offer:${offerId}`, {
      ...offerData,
      estimated_fare: newFare,
      retry_count: retryCount,
      timed_out: false,
    }, TTL_MS);

    await this.cacheManager.set(`customer:active_offer:${customerId}`, offerId, TTL_MS);

    // Clear previous search state so all drivers get a fresh chance at the higher fare
    await this.cacheManager.del(`offer:${offerId}:excluded`);
    await this.cacheManager.del(`offer:${offerId}:broadcast`);
    await this.cacheManager.del(`offer:${offerId}:broadcast_drivers`);

    this.bookingGateway.notifyUser(customerId, 'searching_for_driver', {
      bookingId: offerId,
      message: `Searching with increased fare ₹${newFare}...`,
      searchTimeoutSeconds: 60,
      retryCount,
    });

    await this.bookingQueue.add('search_timeout', { bookingId: offerId }, { delay: 60_000 });

    this.processDriverSearch(offerId, [], offerData.vehicle_type, 1).catch(err =>
      this.logger.error(`[RetrySearch] Driver search failed: ${err.message}`),
    );

    return { success: true, new_fare: newFare, retry_count: retryCount };
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
    const settings = await this.systemSettings.getDispatchSettings();
    const MAX_ATTEMPTS = settings.max_search_attempts;

    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    this.logger.log(`[processDriverSearch] offer=${offerId}, found=${!!offerData}, attempt=${attempt}`);
    if (!offerData) return; // offer accepted or expired

    const resolvedVehicleType = vehicleType || offerData.vehicle_type;
    const { latitude, longitude } = offerData.pickup_location;
    this.logger.log(`[processDriverSearch] pickup=(${latitude},${longitude}), vehicleType: ${resolvedVehicleType}, radius: ${settings.search_radius_km}km`);

    if (attempt > MAX_ATTEMPTS) {
      await this.broadcastBookingToNearby(offerId, resolvedVehicleType);
      return;
    }

    const nearbyDrivers = await this.findNearbyDrivers(latitude, longitude, settings.search_radius_km, resolvedVehicleType);
    this.logger.log(`[processDriverSearch] found ${nearbyDrivers.length} nearby drivers within ${settings.search_radius_km}km`);

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
      paid_by:     offerData.paid_by || 'sender',
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
      { delay: settings.offer_timeout_seconds * 1000 },
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

    const settings = await this.systemSettings.getDispatchSettings();
    const { latitude, longitude } = offerData.pickup_location;
    const nearbyDrivers = await this.findNearbyDrivers(latitude, longitude, settings.broadcast_radius_km, vehicleType);

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
      paid_by:   offerData.paid_by || 'sender',
      timeLeft:  60, // broadcast offers give drivers 60s to accept
    };

    // Emit booking_available to all drivers via WebSocket + track per-driver in Redis
    for (const driverId of driverIds) {
      this.bookingGateway.notifyUser(driverId, 'booking_available', payload);
      const existing = (await this.cacheManager.get<string[]>(`driver:broadcasts:${driverId}`)) || [];
      if (!existing.includes(offerId)) {
        await this.cacheManager.set(`driver:broadcasts:${driverId}`, [...existing, offerId], BROADCAST_TTL_MS);
      }
    }

    // Single batch FCM push (1 DB query + 1 Firebase multicast for all drivers)
    this.notificationService.pushToMany(
      driverIds,
      'general',
      '🔔 New Booking Nearby!',
      `${offerData.pickup_address} → ${offerData.drop_address} · ₹${Math.round(offerData.estimated_fare)}`,
      {
        type:       'new_booking',
        bookingId:  offerId,
        fare:       String(Math.round(offerData.estimated_fare)),
        distance:   String(offerData.distance),
        vehicleType: vehicleType ?? '',
      },
      true, // isNewBooking — routes to zipto_new_booking channel
    ).catch(err => this.logger.error(`[broadcast] pushToMany failed: ${err.message}`));

    this.logger.log(`Broadcast offer ${offerId} to ${driverIds.length} nearby drivers`);

    await this.bookingQueue.add('broadcast_timeout', { bookingId: offerId }, { delay: BROADCAST_TTL_MS });
  }

  /**
   * Hard 60-second search timeout.
   * If retries remain, keep the offer alive (90s grace) and let the customer increase the fare.
   * On final timeout, clean up completely.
   */
  async handleSearchTimeout(offerId: string) {
    const offerData = await this.cacheManager.get<any>(`offer:${offerId}`);
    if (!offerData) return; // offer accepted or already cleaned up

    this.logger.log(`[SearchTimeout] 60s expired for offer ${offerId}`);

    const retryCount = offerData.retry_count || 0;

    // Keep offer alive 90s so customer can decide to increase fare or cancel
    await this.cacheManager.set(`offer:${offerId}`, {
      ...offerData,
      timed_out: true,
    }, 90_000);

    this.bookingGateway.notifyUser(offerData.customer_id, 'search_timeout', {
      bookingId: offerId,
      message: 'No drivers found. Increase fare to attract more drivers?',
      current_fare: offerData.estimated_fare,
      suggested_fare: Math.round(offerData.estimated_fare + 10),
      retry_count: retryCount,
      can_retry: true,
    });
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
        paid_by:         offerData.paid_by || 'sender',
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
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      this.logger.warn('[findNearbyDrivers] Invalid coordinates, skipping search');
      return [];
    }

    // Only match drivers whose GPS is fresh. A driver who logged out / closed the
    // app / drove away stops pinging, so their location goes stale — without this
    // a 100 km-away (or logged-out) driver could still be offered a nearby ride.
    const maxAgeMin = Math.max(
      1,
      parseInt(process.env.DISPATCH_LOCATION_MAX_AGE_MINUTES || '5', 10) || 5,
    );

    const params: any[] = [lng, lat, radiusKm * 1000, maxAgeMin];
    let vehicleFilter = '';

    if (vehicleType) {
      params.push(vehicleType);
      vehicleFilter = `AND v.vehicle_type = $5`;
    }

    try {
      const results = await this.bookingRepository.manager.query(
        `
        SELECT dp.user_id,
               ST_Distance(
                 dp.current_location,
                 ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
               ) AS distance
        FROM driver_profiles dp
        JOIN vehicles v ON v.driver_id = dp.id
          AND v.verification_status = 'approved'
          ${vehicleFilter}
        WHERE dp.availability_status = 'online'
          AND dp.current_location IS NOT NULL
          AND dp.last_location_at IS NOT NULL
          AND dp.last_location_at > NOW() - ($4 * INTERVAL '1 minute')
          AND ST_DWithin(
            dp.current_location,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            $3
          )
          -- Exclude drivers who are currently busy with an active booking
          AND NOT EXISTS (
            SELECT 1 FROM bookings b
            WHERE b.driver_id = dp.user_id
              AND b.status IN ('accepted', 'driver_assigned', 'ongoing')
          )
        ORDER BY distance ASC
        LIMIT 10
        `,
        params,
      );
      return results;
    } catch (err) {
      this.logger.error('[findNearbyDrivers] Query failed', err);
      return [];
    }
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
        paid_by:         offerData.paid_by || 'sender',
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
      relations: ['customer', 'driver', 'vehicle', 'payments'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.customer_id !== userId && booking.driver_id !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    // Attach driver profile stats + photo + live location if driver is assigned
    let driverStats: {
      average_rating: number | null;
      total_trips: number;
      profile_image: string | null;
    } | null = null;
    let driverLocation: { latitude: number; longitude: number } | null = null;
    if (booking.driver_id) {
      const [profile] = await this.bookingRepository.manager.query(
        `SELECT average_rating, total_trips, profile_image,
                ST_Y(current_location::geometry) AS lat,
                ST_X(current_location::geometry) AS lng
         FROM driver_profiles WHERE user_id = $1 LIMIT 1`,
        [booking.driver_id],
      );
      if (profile) {
        // R2/S3 keys are private — hand the app a presigned URL it can load.
        const profileImage = await this.s3Service
          .getSignedUrl(profile.profile_image)
          .catch(() => null);
        driverStats = {
          average_rating: profile.average_rating ? parseFloat(profile.average_rating) : null,
          total_trips: parseInt(profile.total_trips, 10) || 0,
          profile_image: profileImage,
        };
        if (profile.lat && profile.lng) {
          driverLocation = {
            latitude: parseFloat(profile.lat),
            longitude: parseFloat(profile.lng),
          };
        }
      }
    }

    const normalizePhone = (phone: string | null | undefined) => {
      if (!phone) return undefined;
      const digits = phone.replace(/\D/g, '');
      return digits.length >= 10 ? digits.slice(-10) : digits || undefined;
    };

    return {
      ...booking,
      driver_stats: driverStats,
      driver_location: driverLocation,
      pickup_otp: booking.pickup_otp,
      pickup_otp_verified: booking.pickup_otp_verified,
      delivery_otp: booking.delivery_otp,
      delivery_otp_verified: booking.otp_verified,
      sender_phone: normalizePhone(booking.mobile_number),
      receiver_phone: normalizePhone(booking.receiver_phone) || normalizePhone(booking.alternative_phone) || undefined,
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

    const saved = await this.bookingRepository.save(booking);

    // Fire-and-forget fraud checks
    this.fraudService.runFraudChecks(booking.customer_id, bookingId).catch(() => {});

    return saved;
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

    // Reconcile a pending delivery-QR (Cashfree payment link) with Cashfree so the
    // rider auto-sees "Paid" within a poll cycle, even if the webhook is delayed.
    // Then re-read payments so the flag + returned list reflect a just-paid order.
    await this.paymentService.verifyPendingLinkForBooking(booking.id).catch(() => {});
    booking.payments = await this.paymentRepository.find({
      where: { booking_id: booking.id },
    });

    const isAlreadyPaid = booking.payments?.some(p => p.payment_status === 'completed') ?? false;

    // Normalize a phone to 10-digit local format for display
    const normalizePhone = (phone: string | null | undefined) => {
      if (!phone) return undefined;
      const digits = phone.replace(/\D/g, '');
      return digits.length >= 10 ? digits.slice(-10) : digits || undefined;
    };

    return {
      ...booking,
      is_already_paid: isAlreadyPaid,
      // Sender details — fall back to customer relation if booking fields are empty
      sender_name: booking.name || booking.customer?.name || undefined,
      sender_phone: normalizePhone(booking.mobile_number) || normalizePhone(booking.customer?.phone),
      // Receiver details — do NOT fall back to sender's phone
      receiver_name: booking.receiver_name || undefined,
      receiver_phone: normalizePhone(booking.receiver_phone) || normalizePhone(booking.alternative_phone) || undefined,
      alternative_phone: normalizePhone(booking.alternative_phone) || undefined,
      // OTPs
      pickup_otp: booking.pickup_otp,
      pickup_otp_verified: booking.pickup_otp_verified,
      delivery_otp: booking.delivery_otp,
      delivery_otp_verified: booking.otp_verified,
    };
  }

  /**
   * Accept booking (driver) — reads offer from Redis, creates DB record for the first time.
   */
  async acceptBooking(offerId: string, driverId: string, vehicleId: string) {
    // Wallet suspension guard: driver must clear dues before accepting rides
    const walletSuspended = await this.driverWalletService.isWalletSuspended(driverId);
    if (walletSuspended) {
      throw new BadRequestException(
        'Your Zipto wallet balance is too low. Please top up to continue accepting rides.',
      );
    }

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

    // Atomic race-condition guard: SET NX returns false if another driver already holds the lock
    const lockAcquired = await this.cacheManager.setnx(`offer:${offerId}:accepting`, driverId, 30000);
    if (!lockAcquired) {
      throw new BadRequestException('Booking is being accepted by another driver');
    }

    // Verify driver is approved before allowing booking acceptance
    const [driverProfile] = await this.bookingRepository.manager.query(
      `SELECT verification_status FROM driver_profiles WHERE user_id = $1 LIMIT 1`,
      [driverId],
    );
    if (!driverProfile || driverProfile.verification_status !== 'approved') {
      await this.cacheManager.del(`offer:${offerId}:accepting`);
      throw new ForbiddenException('Your account is not approved to accept bookings');
    }

    // Verify vehicle belongs to this driver and is approved
    const [vehicle] = await this.bookingRepository.manager.query(
      `SELECT v.id FROM vehicles v
       JOIN driver_profiles dp ON dp.id = v.driver_id
       WHERE v.id = $1 AND dp.user_id = $2 AND v.verification_status = 'approved' LIMIT 1`,
      [vehicleId, driverId],
    );
    if (!vehicle) {
      await this.cacheManager.del(`offer:${offerId}:accepting`);
      throw new ForbiddenException('Vehicle not found, not yours, or not approved');
    }

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
      // Deduct coins if customer opted to redeem them
      const coinsToRedeem: number = offerData.coins_to_redeem || 0;
      const coinDiscount: number  = offerData.coin_discount    || 0;
      if (coinsToRedeem > 0) {
        await this.coinService.redeemCoins(
          offerData.customer_id,
          coinsToRedeem,
          `Redeemed ${coinsToRedeem} coins for ₹${coinDiscount} discount on booking`,
        );
        this.logger.log(`[acceptBooking] Redeemed ${coinsToRedeem} coins (₹${coinDiscount} off) for customer ${offerData.customer_id}`);
      }

      const couponDiscount: number  = offerData.coupon_discount  || 0;
      const couponId: string | null = offerData.coupon_id        || null;
      const couponCode: string | null = offerData.coupon_code    || null;

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
        is_night_booking: this.isNightTime(),
        status:          BookingStatus.ACCEPTED,
        scheduled_time:  offerData.scheduled_time ? new Date(offerData.scheduled_time) : undefined,
        receiver_name:   offerData.receiver_name,
        receiver_phone:  offerData.receiver_phone,
        alternative_phone: offerData.alternative_phone,
        paid_by:         offerData.paid_by || 'sender',
        customer_gstin:  offerData.customer_gstin ?? null,
        pickup_otp:      offerData.pickup_otp,
        pickup_otp_verified: false,
        delivery_otp:    offerData.delivery_otp,
        otp_verified:    false,
        driver_id:       driverId,
        vehicle_id:      vehicleId,
        acceptance_time: new Date(),
        coins_redeemed:  coinsToRedeem,
        coin_discount:   coinDiscount,
        coupon_code:     couponCode,
        coupon_id:       couponId,
        coupon_discount: couponDiscount,
      } as any);

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

      // Record coupon usage if one was applied
      if (couponId && couponDiscount > 0) {
        try {
          await this.couponService.recordUsage(
            couponId,
            offerData.customer_id,
            createdBooking.id,
            couponDiscount,
          );
        } catch (couponErr: any) {
          this.logger.warn(`[acceptBooking] Coupon usage record failed: ${couponErr?.message}`);
          // Non-fatal — booking is already confirmed; coupon limit check already passed at create()
        }
      }

      // Send the DELIVERY OTP to the RECEIVER's phone via the DLT-approved
      // template — they reveal it to the rider only at delivery. The pickup OTP
      // is shown to the sender in-app on the live-tracking screen.
      const deliveryOtpPhone =
        offerData.receiver_phone || offerData.alternative_phone || offerData.mobile_number;
      if (offerData.delivery_otp && deliveryOtpPhone) {
        this.smsService.sendDeliveryOtp(deliveryOtpPhone, offerData.delivery_otp).catch(err =>
          this.logger.warn(`Failed to send delivery OTP SMS: ${err?.message}`),
        );
      }

      // Store accepted mapping so customer can resolve offer_id → booking_id
      await this.cacheManager.set(`offer:accepted:${offerId}`, createdBooking.id, 10 * 60 * 1000);

      // Notify customer with real booking ID
      this.bookingGateway.notifyUser(offerData.customer_id, 'booking_accepted', {
        bookingId: createdBooking.id,
        offerId,
        driverId,
      });

      // FCM push to customer (works even if app is background/closed)
      this.notificationService.pushToCustomer(
        offerData.customer_id,
        'general',
        '🚀 Rider Found!',
        `Your rider is on the way. OTP sent via SMS.`,
        { type: 'booking_accepted', bookingId: createdBooking.id },
      ).catch(() => {});

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

      // Refund coins if they were already deducted before the failure
      const coinsToRefund: number = offerData?.coins_to_redeem || 0;
      if (coinsToRefund > 0) {
        try {
          await this.userRepository.increment({ id: offerData.customer_id }, 'coins', coinsToRefund);
          this.logger.warn(`[acceptBooking] Refunded ${coinsToRefund} coins to customer ${offerData.customer_id} due to booking failure`);
        } catch (refundErr: any) {
          this.logger.error(`[acceptBooking] Failed to refund coins: ${refundErr?.message}`);
        }
      }

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
    let booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
    });

    if (!booking) {
      const realId = await this.cacheManager.get<string>(`offer:accepted:${bookingId}`);
      if (realId) {
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

    this.logger.log(`[startTrip] booking=${bookingId} OTP verification attempt`);

    if (!otpInput || otpInput.length < 4) {
      throw new BadRequestException('Pickup OTP is required to start the trip');
    }

    // Rate-limit OTP attempts: max 5 per booking, 10-minute lockout
    const otpAttemptsKey = `otp:attempts:pickup:${bookingId}`;
    const attempts = await this.cacheManager.get<number>(otpAttemptsKey) ?? 0;
    if (attempts >= 5) {
      throw new BadRequestException('Too many incorrect OTP attempts. Please wait before trying again.');
    }

    if (storedOtp && storedOtp !== otpInput) {
      await this.cacheManager.set(otpAttemptsKey, attempts + 1, 10 * 60 * 1000);
      throw new BadRequestException('Invalid pickup OTP. Please check the OTP with the sender.');
    }

    // Clear attempt counter on success
    await this.cacheManager.del(otpAttemptsKey);

    booking.status = BookingStatus.ONGOING;
    booking.start_time = new Date();
    booking.pickup_otp_verified = true;
    booking.pickup_verified_at = new Date();

    await this.bookingRepository.save(booking);

    // SLA guard: schedule a Bull job that fires if delivery isn't completed within
    // max(4 h, estimated_duration × 3). Processor will call flagBookingAbandoned().
    const estimatedMs = (booking.duration || 60) * 3 * 60 * 1000;
    const slaDelayMs = Math.max(4 * 60 * 60 * 1000, estimatedMs);
    await this.bookingQueue.add(
      'delivery_sla_breach',
      { bookingId: booking.id, driverId: booking.driver_id },
      { delay: slaDelayMs },
    );

    // Send delivery OTP to receiver (or sender if no receiver) now that package is picked up
    if (booking.delivery_otp) {
      const receiverPhone = booking.receiver_phone || booking.mobile_number;
      if (receiverPhone) {
        const smsBody =
          `Zipto Delivery OTP: *${booking.delivery_otp}*\n` +
          `Your package is on the way! Share this OTP with the rider ONLY when the package arrives at your door.`;
        this.smsService.sendSms(receiverPhone, smsBody).catch(err =>
          this.logger.warn(`[startTrip] Failed to send delivery OTP SMS: ${err?.message}`),
        );
      }
    }

    // FCM push to customer — package picked up
    this.notificationService.pushToCustomer(
      booking.customer_id,
      'general',
      '📦 Package Picked Up',
      'Your package has been collected. The rider is on the way!',
      { type: 'trip_started', bookingId: booking.id },
    ).catch(() => {});

    return booking;
  }

  /**
   * Resend delivery OTP SMS to receiver — only allowed if delivery is not yet completed.
   */
  async resendDeliveryOtp(bookingId: string, driverId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.otp_verified) throw new BadRequestException('Delivery OTP has already been verified. Cannot resend.');
    if (!booking.delivery_otp) throw new BadRequestException('No delivery OTP found for this booking.');

    const receiverPhone = booking.receiver_phone || booking.mobile_number;
    if (!receiverPhone) throw new BadRequestException('No receiver phone number available.');

    const smsBody =
      `[Resent] Zipto Delivery OTP: *${booking.delivery_otp}*\n` +
      `Share this OTP with the delivery rider ONLY when the package arrives.`;

    const sent = await this.smsService.sendSms(receiverPhone, smsBody);
    if (!sent) throw new BadRequestException('Failed to send SMS. Please try again.');

    this.logger.log(`[resendDeliveryOtp] Resent to ${receiverPhone} for booking ${bookingId}`);
    return { message: 'OTP resent successfully to receiver.' };
  }

  /**
   * Initiate a masked voice bridge call between rider and a booking contact.
   * Twilio calls the rider's phone (showing the official Zipto number).
   * When the rider picks up, the call is bridged to the customer/receiver.
   * Neither party sees the other's personal number.
   *
   * @param party 'sender' = the customer who booked | 'receiver' = the delivery recipient
   */
  async callContact(bookingId: string, driverId: string, party: 'sender' | 'receiver') {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, driver_id: driverId },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Resolve target phone
    let customerPhone: string | null | undefined;
    if (party === 'sender') {
      customerPhone = booking.mobile_number;
    } else {
      customerPhone = booking.receiver_phone || booking.alternative_phone || booking.mobile_number;
    }
    if (!customerPhone) throw new BadRequestException(`No phone number available for ${party}.`);

    // Get driver's registered phone number
    const driver = await this.userRepository.findOne({
      where: { id: driverId },
      select: ['phone'],
    });
    if (!driver?.phone) throw new BadRequestException('Driver phone number not found.');

    this.logger.log(`[callContact] Bridging driver ${driverId} → ${party} (${customerPhone}) for booking ${bookingId}`);

    const callSid = await this.exotelService.initiateVoiceBridge(driver.phone, customerPhone);
    return {
      message: 'Call initiated. Your phone will ring shortly — pick up to connect.',
      sid: callSid,
    };
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

    // Calculate final fare: estimated + waiting + toll. Keep 2-decimal precision
    // (GST makes fares non-whole). Online charges this exact value; a CASH trip
    // collects it rounded UP to the next whole rupee (see cashCollectAmount).
    const estimatedFare = Number(booking.estimated_fare);
    const finalFare = this.round2(estimatedFare + waitingCharge + tollAmount);
    const cashCollectAmount = Math.ceil(finalFare); // whole rupees collected in cash

    // Driver earnings are on the PRE-GST delivery charge — GST is tax (remitted to
    // the government) and the platform fee is Zipto's revenue, so NEITHER belongs
    // to the driver. The Zipto Shield fee is also deducted from the driver and
    // funds the shield pool. This matches how the fare estimate quotes earnings.
    // Waiting + toll go fully to the driver (their time / a reimbursement).
    //   riderEarning = delivery − commission − shield (+ waiting + toll)
    //   ziptoRevenue = commission + platformFee + shield
    const bd = (booking.fare_breakdown || {}) as any;
    const deliveryCharge = Number(bd.delivery_charge ?? estimatedFare) || 0;
    const commissionPercent = pricingRule ? Number(pricingRule.commission_percent) : 25;
    const SHIELD_FEE = SHIELD_CONTRIBUTION_PER_BOOKING; // ₹ per order → shield pool
    const skidoCommission = this.round2(deliveryCharge * (commissionPercent / 100));
    const driverEarnings = this.round2(
      deliveryCharge - skidoCommission - SHIELD_FEE + waitingCharge + tollAmount,
    );

    // Customer-facing platform fee that was actually charged (config-driven,
    // already baked into estimated_fare); kept on the breakdown for the invoice.
    const fareSettings = await this.systemSettings.getFareSettings();
    const customerPlatformFee = this.round(fareSettings.platform_fee);

    // Update fare breakdown
    const fareBreakdown = booking.fare_breakdown || ({} as any);
    fareBreakdown.waiting_charge = waitingCharge;
    fareBreakdown.toll_amount = tollAmount;
    fareBreakdown.skido_commission = skidoCommission;
    fareBreakdown.platform_fee = customerPlatformFee;
    fareBreakdown.shield_fee = SHIELD_FEE;
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

    // Handle wallet and payment recording based on payment method
    const paymentMethod = completeTripDto?.payment_method;
    const alreadyPaid = await this.paymentRepository.findOne({
      where: { booking_id: bookingId, payment_status: PaymentStatus.COMPLETED },
    });

    if (paymentMethod === 'cash' && !alreadyPaid) {
      // ── CASH TRIP ────────────────────────────────────────────────────────────
      // Driver physically collected the whole-rupee cash. Zipto recovers
      // everything that isn't the driver's earnings (commission + GST + platform
      // fee + the cash round-up) from the driver's wallet, so the driver nets
      // exactly their earnings regardless of cash vs online.
      const cashRecovery = this.round2(cashCollectAmount - driverEarnings);
      await this.driverWalletService.deductCashCommission(
        driverId,
        cashRecovery,
        0,
        bookingId,
      );
      const cashPayment = this.paymentRepository.create({
        booking_id: bookingId,
        // Cash is collected in whole rupees (rounded up) — the rider can't make
        // change for paise. e.g. ₹52.20 fare → collect ₹53.
        amount: cashCollectAmount,
        driver_earnings: driverEarnings,
        payment_method: PaymentMethod.CASH,
        payment_status: PaymentStatus.COMPLETED,
      });
      await this.paymentRepository.save(cashPayment);
    } else if (paymentMethod !== 'cash') {
      // ── ONLINE / QR TRIP ─────────────────────────────────────────────────────
      // Credit driver earnings — idempotent (won't double-credit on retry).
      await this.driverWalletService.creditTripEarnings(
        driverId,
        driverEarnings,
        bookingId,
      );
    }

    // Zipto Shield: ₹1 contributed per completed booking (fire-and-forget)
    this.ziptoShieldService.contribute(savedBooking.id).catch(() => {});

    // Email the GST/tax invoice to the customer (fire-and-forget, no email = skip)
    this.emailInvoiceOnDelivery(savedBooking.id).catch(() => {});

    // FCM: notify customer trip is complete
    this.notificationService.pushToCustomer(
      booking.customer_id,
      'general',
      '✅ Delivery Completed!',
      `Your package has been delivered. Final fare: ₹${Math.round(finalFare)}`,
      { type: 'trip_completed', bookingId: savedBooking.id, finalFare: String(Math.round(finalFare)) },
    ).catch(() => {});

    // Award coins to customer for successful delivery
    const coinReward = await this.coinService.awardCoins(
      booking.customer_id,
      booking.id,
      Number(booking.distance) || 0,
      Number(booking.final_fare),
      booking.service_category,
    );

    // Referral payout — if this customer was referred and this is their first
    // completed ride, credit both the referee and the referrer (idempotent).
    this.referralService
      .onFirstCompletedRide(booking.customer_id, booking.id)
      .catch((err) =>
        this.logger.error(`Referral reward failed for booking ${booking.id}: ${err?.message}`),
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
        platform_fee: customerPlatformFee,
        shield_fee: SHIELD_FEE,
        driver_earnings: driverEarnings,
      },
    };
  }

  /**
   * Get the current active booking for a customer (used by the live status banner).
   * Checks Redis for a searching offer first, then DB for accepted/ongoing bookings.
   */
  async getCustomerActiveBooking(userId: string): Promise<any> {
    // 1. Check DB for an active booking
    const booking = await this.bookingRepository.findOne({
      where: {
        customer_id: userId,
        status: In([
          BookingStatus.PENDING,
          BookingStatus.ACCEPTED,
          BookingStatus.DRIVER_ASSIGNED,
          BookingStatus.ONGOING,
        ]),
      },
      order: { created_at: 'DESC' },
    });

    if (booking) {
      return {
        id: booking.id,
        status: booking.status,
        pickup_address: booking.pickup_address,
        drop_address: booking.drop_address,
        estimated_fare: booking.estimated_fare,
        vehicle_type: booking.vehicle_type,
        has_driver: !!booking.driver_id,
      };
    }

    // 2. Check Redis for a still-searching offer
    const activeOfferId = await this.cacheManager.get<string>(`customer:active_offer:${userId}`);
    if (!activeOfferId) return null;

    // Check if offer was accepted → get real booking
    const realBookingId = await this.cacheManager.get<string>(`offer:accepted:${activeOfferId}`);
    if (realBookingId) {
      const realBooking = await this.bookingRepository.findOne({ where: { id: realBookingId } });
      if (realBooking && realBooking.status !== BookingStatus.COMPLETED && realBooking.status !== BookingStatus.CANCELLED) {
        return {
          id: realBookingId,
          offer_id: activeOfferId,
          status: realBooking.status,
          pickup_address: realBooking.pickup_address,
          drop_address: realBooking.drop_address,
          estimated_fare: realBooking.estimated_fare,
          vehicle_type: realBooking.vehicle_type,
          has_driver: true,
        };
      }
      await this.cacheManager.del(`customer:active_offer:${userId}`);
      return null;
    }

    // Offer still searching in Redis
    const offerData = await this.cacheManager.get<any>(`offer:${activeOfferId}`);
    if (offerData) {
      return {
        id: activeOfferId,
        status: BookingStatus.PENDING,
        pickup_address: offerData.pickup_address,
        drop_address: offerData.drop_address,
        estimated_fare: offerData.estimated_fare,
        vehicle_type: offerData.vehicle_type,
        has_driver: false,
      };
    }

    // Offer expired
    await this.cacheManager.del(`customer:active_offer:${userId}`);
    return null;
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

  // ─── Driver Handoff ────────────────────────────────────────────────────────

  private static readonly HANDOFF_TTL_MS = 3 * 60 * 1000; // 3 minutes
  private static readonly HANDOFF_RADIUS_KM = 5;

  /**
   * Current driver requests a handoff (vehicle breakdown mid-delivery).
   * Stores the offer in Redis and broadcasts to nearby available drivers.
   */
  // ─── Rogue-driver / abandonment pipeline ─────────────────────────────────────

  /**
   * Central response pipeline — called by all three guards (SLA, socket, GPS cron).
   * Idempotent: skips silently if booking is already flagged.
   */
  async flagBookingAbandoned(
    bookingId: string,
    driverId: string,
    detectedBy: 'socket_disconnect' | 'sla_deadline' | 'gps_cron',
  ): Promise<void> {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking) return;
    if (booking.status !== BookingStatus.ONGOING) return;
    if (booking.is_flagged) return; // Already handled

    // 1. Flag the booking
    booking.is_flagged = true;
    booking.flag_reason = detectedBy;
    booking.flagged_at = new Date();
    await this.bookingRepository.save(booking);

    // 2. Create fraud incident + freeze driver wallet (idempotent inside service)
    await this.driverFraudService.createIncidentAndFreezeWallet(bookingId, driverId, detectedBy);

    // 3. Notify customer via socket
    this.bookingGateway.notifyUser(booking.customer_id, 'delivery_investigation', {
      bookingId,
      message: "We're investigating your delivery. Our team is looking into this urgently.",
    });

    // 4. Push FCM to customer
    this.notificationService
      .push(booking.customer_id, 'general', 'Delivery Update',
        "We're investigating your delivery. We'll keep you updated.",
        { type: 'delivery_investigation', bookingId })
      .catch(() => {});

    this.logger.warn(
      `[flagBookingAbandoned] booking=${bookingId} driver=${driverId} detected_by=${detectedBy}`,
    );
  }

  /**
   * Guard C: GPS heartbeat cron — runs every 5 minutes.
   * Finds ongoing bookings where the driver hasn't sent a GPS ping in 20+ minutes.
   */
  @Cron('*/5 * * * *')
  async checkGhostDrivers(): Promise<void> {
    try {
      const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000);

      const suspectedBookings = await this.bookingRepository
        .createQueryBuilder('b')
        .select(['b.id', 'b.driver_id', 'b.pickup_verified_at', 'b.is_flagged'])
        .where('b.status = :status', { status: BookingStatus.ONGOING })
        .andWhere('b.is_flagged = false')
        .andWhere('b.driver_id IS NOT NULL')
        .andWhere('b.pickup_verified_at IS NOT NULL')
        .andWhere('b.pickup_verified_at < :cutoff', { cutoff: twentyMinAgo })
        .getMany();

      for (const booking of suspectedBookings) {
        try {
          const lastPing = await this.cacheManager.get(`driver:last_ping:${booking.driver_id}`);
          if (lastPing !== null) continue; // Driver is actively pinging — all good

          this.logger.warn(
            `[GhostCron] No GPS ping for driver=${booking.driver_id} on booking=${booking.id} — flagging`,
          );
          await this.flagBookingAbandoned(booking.id, booking.driver_id, 'gps_cron');
        } catch (innerErr: any) {
          this.logger.error(`[GhostCron] Failed processing booking=${booking.id}: ${innerErr?.message}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[GhostCron] Cron job failed: ${err?.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  async requestHandoff(bookingId: string, driverId: string, reason: string) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    if (booking.driver_id !== driverId) {
      throw new ForbiddenException('You are not the assigned driver for this booking');
    }

    const handoffableStatuses = [
      BookingStatus.ACCEPTED,
      BookingStatus.DRIVER_ASSIGNED,
      BookingStatus.ONGOING,
    ];
    if (!handoffableStatuses.includes(booking.status)) {
      throw new BadRequestException(
        `Cannot request handoff for a booking in status: ${booking.status}`,
      );
    }

    if (booking.handoff_count >= 1) {
      throw new BadRequestException('This booking has already been handed off once and cannot be handed off again');
    }

    const existingHandoff = await this.cacheManager.get(`handoff:${bookingId}`);
    if (existingHandoff) {
      throw new BadRequestException('A handoff request is already active for this booking');
    }

    // Get the current driver's GPS position to find nearby drivers
    const [driverLoc] = await this.bookingRepository.manager.query(
      `SELECT ST_X(current_location::geometry) AS lng,
              ST_Y(current_location::geometry) AS lat
       FROM driver_profiles WHERE user_id = $1 LIMIT 1`,
      [driverId],
    );

    const lat: number | null = driverLoc?.lat ?? null;
    const lng: number | null = driverLoc?.lng ?? null;

    const handoffData = {
      bookingId,
      originalDriverId: driverId,
      reason,
      pickup_address: booking.pickup_address,
      drop_address:   booking.drop_address,
      estimated_fare: Number(booking.estimated_fare),
      distance:       Number(booking.distance),
      vehicle_type:   booking.vehicle_type,
      customer_id:    booking.customer_id,
      booking_status: booking.status,
      lat,
      lng,
      created_at: Date.now(),
    };

    await this.cacheManager.set(
      `handoff:${bookingId}`,
      handoffData,
      BookingService.HANDOFF_TTL_MS,
    );

    // Find and notify nearby available drivers (excluding the requesting driver)
    if (lat !== null && lng !== null) {
      const nearbyAll = await this.findNearbyDrivers(
        lat,
        lng,
        BookingService.HANDOFF_RADIUS_KM,
        booking.vehicle_type,
      );
      const eligible = nearbyAll.filter((d: any) => d.user_id !== driverId);

      for (const d of eligible) {
        this.bookingGateway.notifyUser(d.user_id, 'handoff_offer', {
          bookingId,
          pickup_address: booking.pickup_address,
          drop_address:   booking.drop_address,
          estimated_fare: Number(booking.estimated_fare),
          distance:       Number(booking.distance),
          vehicle_type:   booking.vehicle_type,
          reason,
          booking_status: booking.status,
          time_left_seconds: BookingService.HANDOFF_TTL_MS / 1000,
        });
      }

      this.logger.log(
        `[requestHandoff] booking=${bookingId} driver=${driverId} notified ${eligible.length} nearby drivers`,
      );
    } else {
      this.logger.warn(
        `[requestHandoff] Driver ${driverId} has no location — handoff stored but no drivers notified`,
      );
    }

    // Queue expiry job to notify original driver if no one accepts in time
    await this.bookingQueue.add(
      'handoff_expiry',
      { bookingId, originalDriverId: driverId },
      { delay: BookingService.HANDOFF_TTL_MS },
    );

    return {
      message: 'Handoff request sent. Nearby drivers have been notified.',
      expires_in_seconds: BookingService.HANDOFF_TTL_MS / 1000,
    };
  }

  /**
   * A nearby driver accepts the handoff.
   * Atomically transfers the booking to the new driver.
   */
  async acceptHandoff(bookingId: string, newDriverId: string, vehicleId: string) {
    const handoffData = await this.cacheManager.get<any>(`handoff:${bookingId}`);
    if (!handoffData) {
      throw new NotFoundException('No active handoff request found for this booking');
    }

    if (handoffData.originalDriverId === newDriverId) {
      throw new ForbiddenException('You cannot accept your own handoff request');
    }

    // Atomic lock — prevents two drivers accepting simultaneously
    const lockAcquired = await this.cacheManager.setnx(
      `handoff:${bookingId}:accepting`,
      newDriverId,
      30000,
    );
    if (!lockAcquired) {
      throw new BadRequestException('Handoff is being accepted by another driver');
    }

    try {
      // Re-fetch booking inside lock to guard against stale state
      const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
      if (!booking) {
        throw new NotFoundException('Booking not found');
      }

      const handoffableStatuses = [
        BookingStatus.ACCEPTED,
        BookingStatus.DRIVER_ASSIGNED,
        BookingStatus.ONGOING,
      ];
      if (!handoffableStatuses.includes(booking.status)) {
        throw new BadRequestException('Booking is no longer in a transferable state');
      }

      // Guard: handoff_count must still be 0 (no double-handoff)
      if (booking.handoff_count >= 1) {
        throw new BadRequestException('This booking has already been handed off');
      }

      // Verify new driver is approved
      const [driverProfile] = await this.bookingRepository.manager.query(
        `SELECT verification_status FROM driver_profiles WHERE user_id = $1 LIMIT 1`,
        [newDriverId],
      );
      if (!driverProfile || driverProfile.verification_status !== 'approved') {
        throw new ForbiddenException('Your account is not approved to accept bookings');
      }

      // Verify vehicle belongs to the new driver, is approved, and matches required vehicle type
      const [vehicle] = await this.bookingRepository.manager.query(
        `SELECT v.id FROM vehicles v
         JOIN driver_profiles dp ON dp.id = v.driver_id
         WHERE v.id = $1
           AND dp.user_id = $2
           AND v.verification_status = 'approved'
           AND v.vehicle_type = $3
         LIMIT 1`,
        [vehicleId, newDriverId, booking.vehicle_type],
      );
      if (!vehicle) {
        throw new ForbiddenException(
          `Vehicle not found, not yours, not approved, or does not match required type (${booking.vehicle_type})`,
        );
      }

      // New driver must not already have an active booking
      const existingActive = await this.bookingRepository.findOne({
        where: [
          { driver_id: newDriverId, status: BookingStatus.ACCEPTED },
          { driver_id: newDriverId, status: BookingStatus.DRIVER_ASSIGNED },
          { driver_id: newDriverId, status: BookingStatus.ONGOING },
        ],
      });
      if (existingActive) {
        throw new BadRequestException(
          'You already have an active delivery. Complete it before accepting a handoff.',
        );
      }

      // Transfer booking
      const originalDriverId = booking.driver_id;
      booking.original_driver_id = originalDriverId;
      booking.driver_id   = newDriverId;
      booking.vehicle_id  = vehicleId;
      booking.handoff_count = 1;
      await this.bookingRepository.save(booking);

      // Clean up Redis
      await this.cacheManager.del(`handoff:${bookingId}`);

      // Notify original driver
      this.bookingGateway.notifyUser(originalDriverId, 'handoff_accepted', {
        bookingId,
        message: 'A nearby driver has taken over your delivery. You are now free.',
      });

      // Notify customer
      this.bookingGateway.notifyUser(booking.customer_id, 'driver_changed', {
        bookingId,
        message: 'Your delivery driver has changed due to a vehicle issue. Your package is on the way.',
      });

      this.logger.log(
        `[acceptHandoff] booking=${bookingId} transferred from ${originalDriverId} to ${newDriverId}`,
      );

      return {
        message: 'Handoff accepted. You are now responsible for this delivery.',
        booking_id: bookingId,
        booking_status: booking.status,
        pickup_otp_already_verified: booking.pickup_otp_verified,
        delivery_otp_required: !booking.otp_verified,
      };
    } finally {
      // Always release lock regardless of success or failure
      await this.cacheManager.del(`handoff:${bookingId}:accepting`);
    }
  }

  /**
   * Original driver cancels their own handoff request (changed mind / vehicle fixed).
   */
  async cancelHandoff(bookingId: string, driverId: string) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    if (booking.driver_id !== driverId) {
      throw new ForbiddenException('You are not the assigned driver for this booking');
    }

    const handoffData = await this.cacheManager.get(`handoff:${bookingId}`);
    if (!handoffData) {
      throw new BadRequestException('No active handoff request exists for this booking');
    }

    await this.cacheManager.del(`handoff:${bookingId}`);

    this.logger.log(`[cancelHandoff] booking=${bookingId} driver=${driverId} cancelled handoff`);

    return { message: 'Handoff request cancelled. You remain responsible for this delivery.' };
  }

  /**
   * Poll the status of an active handoff request.
   * Accessible by the current driver or the original driver (after handoff).
   */
  async getHandoffStatus(bookingId: string, driverId: string) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const isCurrentDriver  = booking.driver_id === driverId;
    const isOriginalDriver = booking.original_driver_id === driverId;
    if (!isCurrentDriver && !isOriginalDriver) {
      throw new ForbiddenException('You are not associated with this booking');
    }

    const handoffData = await this.cacheManager.get<any>(`handoff:${bookingId}`);
    const hasActiveHandoff = !!handoffData;

    let expiresInSeconds: number | null = null;
    if (hasActiveHandoff && handoffData.created_at) {
      const elapsed = Date.now() - handoffData.created_at;
      expiresInSeconds = Math.max(0, Math.round((BookingService.HANDOFF_TTL_MS - elapsed) / 1000));
    }

    return {
      has_active_handoff: hasActiveHandoff,
      handoff_count: booking.handoff_count,
      original_driver_id: booking.original_driver_id ?? null,
      active_handoff: hasActiveHandoff
        ? {
            reason: handoffData.reason,
            created_at: new Date(handoffData.created_at).toISOString(),
            expires_in_seconds: expiresInSeconds,
          }
        : null,
    };
  }

  /**
   * Called by Bull queue when handoff expires with no taker.
   */
  async expireHandoff(bookingId: string, originalDriverId: string) {
    const handoffData = await this.cacheManager.get(`handoff:${bookingId}`);
    if (!handoffData) return; // Already accepted or cancelled — nothing to do

    await this.cacheManager.del(`handoff:${bookingId}`);

    this.bookingGateway.notifyUser(originalDriverId, 'handoff_expired', {
      bookingId,
      message:
        'No nearby driver accepted the handoff within 3 minutes. Please contact support or continue the delivery.',
    });

    this.logger.warn(
      `[expireHandoff] booking=${bookingId} handoff expired — no driver accepted`,
    );
  }
}
