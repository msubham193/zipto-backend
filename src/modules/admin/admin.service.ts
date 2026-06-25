import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, DataSource } from 'typeorm';
import { User, UserRole } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { Payment, PaymentStatus } from '../payment/entities/payment.entity';
import { DriverProfile, VerificationStatus } from '../driver/entities/driver-profile.entity';
import { WithdrawalRequest, WithdrawalStatus } from '../driver/entities/withdrawal-request.entity';
import { BankAccount } from '../driver/entities/bank-account.entity';
import { Vehicle } from '../vehicle/entities/vehicle.entity';
import { Rating } from '../rating/entities/rating.entity';
import { NotificationService } from '../notification/notification.service';

import { PricingRule } from '../booking/entities/pricing-rule.entity';
import {
  DEFAULT_PRICING_CITY,
  getDefaultPricingRules,
  LEGACY_VEHICLE_TYPES,
} from '../booking/constants/default-pricing-rules';
import { DriverWalletService } from '../driver/driver-wallet.service';
import { RazorpayXService } from '../../services/razorpayx.service';
import { CashfreePayoutService } from '../../services/cashfree-payout.service';
import { S3Service } from '../../services/s3.service';
import { SystemSettingsService } from '../settings/system-settings.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(Payment)
    private paymentRepository: Repository<Payment>,
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(PricingRule)
    private pricingRuleRepository: Repository<PricingRule>,
    @InjectRepository(WithdrawalRequest)
    private withdrawalRepository: Repository<WithdrawalRequest>,
    @InjectRepository(BankAccount)
    private bankAccountRepository: Repository<BankAccount>,
    @InjectRepository(Rating)
    private ratingRepository: Repository<Rating>,
    private notificationService: NotificationService,
    private dataSource: DataSource,
    private driverWalletService: DriverWalletService,
    private razorpayXService: RazorpayXService,
    private cashfreePayoutService: CashfreePayoutService,
    private s3Service: S3Service,
    private systemSettings: SystemSettingsService,
  ) {}

  /**
   * Get dashboard statistics with growth metrics (vs previous 30-day period)
   */
  async getDashboardStats() {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalCustomers,
      totalDrivers,
      totalBookings,
      completedBookings,
      ongoingBookings,
      totalRevenue,
      pendingKYC,
      // Current period (last 30 days)
      newCustomersThisPeriod,
      newDriversThisPeriod,
      bookingsThisPeriod,
      revenueThisPeriod,
      // Previous period (30-60 days ago)
      newCustomersPrevPeriod,
      newDriversPrevPeriod,
      bookingsPrevPeriod,
      revenuePrevPeriod,
    ] = await Promise.all([
      this.userRepository.count(),
      this.userRepository.count({ where: { role: UserRole.CUSTOMER, is_deleted: false } }),
      // Count driver PROFILES (not driver users) so the dashboard matches the
      // "All Drivers" list — a user can have role=driver without having completed
      // onboarding (no profile), which previously made the two counts disagree.
      this.driverProfileRepository.count(),
      this.bookingRepository.count(),
      this.bookingRepository.count({ where: { status: BookingStatus.COMPLETED } }),
      this.bookingRepository.count({ where: { status: BookingStatus.ONGOING } }),
      this.paymentRepository
        .createQueryBuilder('payment')
        .select('SUM(payment.amount)', 'total')
        .where('payment.payment_status = :status', { status: PaymentStatus.COMPLETED })
        .getRawOne(),
      this.driverProfileRepository.count({ where: { verification_status: VerificationStatus.PENDING } }),
      // Current period counts
      this.userRepository.count({ where: { role: UserRole.CUSTOMER, is_deleted: false, created_at: Between(thirtyDaysAgo, now) } }),
      this.driverProfileRepository.count({ where: { created_at: Between(thirtyDaysAgo, now) } }),
      this.bookingRepository.count({ where: { created_at: Between(thirtyDaysAgo, now) } }),
      this.paymentRepository
        .createQueryBuilder('payment')
        .select('SUM(payment.amount)', 'total')
        .where('payment.payment_status = :status AND payment.created_at BETWEEN :from AND :to', {
          status: PaymentStatus.COMPLETED,
          from: thirtyDaysAgo,
          to: now,
        })
        .getRawOne(),
      // Previous period counts
      this.userRepository.count({ where: { role: UserRole.CUSTOMER, is_deleted: false, created_at: Between(sixtyDaysAgo, thirtyDaysAgo) } }),
      this.driverProfileRepository.count({ where: { created_at: Between(sixtyDaysAgo, thirtyDaysAgo) } }),
      this.bookingRepository.count({ where: { created_at: Between(sixtyDaysAgo, thirtyDaysAgo) } }),
      this.paymentRepository
        .createQueryBuilder('payment')
        .select('SUM(payment.amount)', 'total')
        .where('payment.payment_status = :status AND payment.created_at BETWEEN :from AND :to', {
          status: PaymentStatus.COMPLETED,
          from: sixtyDaysAgo,
          to: thirtyDaysAgo,
        })
        .getRawOne(),
    ]);

    const calcGrowth = (current: number, previous: number): number => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return parseFloat((((current - previous) / previous) * 100).toFixed(1));
    };

    const revCurrent = parseFloat(revenueThisPeriod?.total || '0');
    const revPrev = parseFloat(revenuePrevPeriod?.total || '0');

    return {
      users: {
        total: totalUsers,
        customers: totalCustomers,
        drivers: totalDrivers,
      },
      bookings: {
        total: totalBookings,
        completed: completedBookings,
        ongoing: ongoingBookings,
      },
      revenue: {
        total: parseFloat(totalRevenue?.total || '0'),
      },
      pending_kyc: pendingKYC,
      growth: {
        customers: calcGrowth(newCustomersThisPeriod, newCustomersPrevPeriod),
        drivers: calcGrowth(newDriversThisPeriod, newDriversPrevPeriod),
        bookings: calcGrowth(bookingsThisPeriod, bookingsPrevPeriod),
        revenue: calcGrowth(revCurrent, revPrev),
      },
    };
  }

  /**
   * Get pending driver verifications
   */
  async getPendingDriverVerifications() {
    const profiles = await this.driverProfileRepository.find({
      where: { verification_status: VerificationStatus.PENDING },
      relations: ['user'],
      order: { created_at: 'ASC' },
    });
    // Documents are stored as private R2 keys → presign so the admin KYC page
    // can render them (same as getDriverById / getDriverKyc).
    return Promise.all(
      profiles.map(async (p) => ({
        ...p,
        ...(await this.s3Service.signFields({
          aadhar_front_image: p.aadhar_front_image,
          aadhar_back_image: p.aadhar_back_image,
          driving_license_image: p.driving_license_image,
          vehicle_rc_image: p.vehicle_rc_image,
          profile_image: p.profile_image,
        })),
      })),
    );
  }

  /**
   * Approve driver verification
   */
  async approveDriver(driverProfileId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { id: driverProfileId },
    });

    if (!profile) {
      throw new Error('Driver profile not found');
    }

    await this.driverProfileRepository.update(driverProfileId, {
      verification_status: VerificationStatus.APPROVED,
      rejection_reason: null,
    });

    // Also mark the user as verified
    await this.userRepository.update(profile.user_id, {
      is_verified: true,
    });

    // Notify driver
    await this.notificationService.notifyDriverApproved(profile.user_id);

    return { message: 'Driver approved successfully' };
  }

  /**
   * Reject driver verification
   */
  async rejectDriver(driverProfileId: string, reason?: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { id: driverProfileId },
    });

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    const cleanReason = (reason || '').trim() || undefined;

    // Notify before wiping data so the FCM token is still valid.
    await this.notificationService.notifyDriverRejected(profile.user_id, cleanReason).catch(() => {});

    // Purge KYC documents from cloud storage (best-effort — never block the rejection).
    for (const ref of [
      profile.aadhar_front_image,
      profile.aadhar_back_image,
      profile.driving_license_image,
      profile.vehicle_rc_image,
      profile.profile_image,
    ]) {
      if (ref) await this.s3Service.deleteFile(ref).catch(() => {});
    }

    // Delete any vehicles linked to this driver profile.
    await this.vehicleRepository.delete({ driver_id: profile.id }).catch(() => {});

    // Delete the driver profile entirely so the driver can re-onboard fresh.
    await this.driverProfileRepository.delete({ id: driverProfileId });

    // Reset the user: clear verification + sessions so they land back at onboarding.
    await this.userRepository.update(profile.user_id, {
      is_verified: false,
      refresh_token: null,
      fcm_token: null,
    });

    this.logger.log(`[rejectDriver] profile ${driverProfileId} deleted, user ${profile.user_id} reset`);
    return { message: 'Driver rejected and data cleared. Driver can re-register.' };
  }

  /**
   * Get pending vehicle verifications
   */
  async getPendingVehicleVerifications() {
    return this.vehicleRepository.find({
      where: { verification_status: VerificationStatus.PENDING },
      relations: ['driver', 'driver.user'],
      order: { created_at: 'ASC' },
    });
  }

  /**
   * Get all vehicles with pagination, optional status filter and search
   */
  async getAllVehicles(query: { page?: number; limit?: number; status?: string; search?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const { status, search } = query;

    const qb = this.vehicleRepository
      .createQueryBuilder('vehicle')
      .leftJoinAndSelect('vehicle.driver', 'driver')
      .leftJoinAndSelect('driver.user', 'user')
      .orderBy('vehicle.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (status && status !== 'all') {
      qb.andWhere('vehicle.verification_status = :status', { status });
    }

    if (search) {
      qb.andWhere(
        '(LOWER(vehicle.vehicle_model) LIKE :search OR LOWER(vehicle.registration_number) LIKE :search OR LOWER(user.name) LIKE :search)',
        { search: `%${search.toLowerCase()}%` },
      );
    }

    const [vehicles, total] = await qb.getManyAndCount();

    return {
      vehicles,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Get vehicle details by ID
   */
  async getVehicleById(vehicleId: string) {
    const vehicle = await this.vehicleRepository.findOne({
      where: { id: vehicleId },
      relations: ['driver', 'driver.user'],
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    return vehicle;
  }

  /**
   * Approve vehicle
   */
  async approveVehicle(vehicleId: string) {
    await this.vehicleRepository.update(vehicleId, {
      verification_status: VerificationStatus.APPROVED,
    });

    return { message: 'Vehicle approved successfully' };
  }

  /**
   * Reject vehicle
   */
  async rejectVehicle(vehicleId: string) {
    await this.vehicleRepository.update(vehicleId, {
      verification_status: VerificationStatus.REJECTED,
    });

    return { message: 'Vehicle rejected' };
  }

  /**
   * Get all bookings with filters
   */
  async getAllBookings(query: { status?: BookingStatus; page?: number; limit?: number }) {
    const { status } = query;
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const queryBuilder = this.bookingRepository
      .createQueryBuilder('booking')
      .leftJoinAndSelect('booking.customer', 'customer')
      .leftJoinAndSelect('booking.driver', 'driver')
      .leftJoinAndSelect('booking.vehicle', 'vehicle');

    if (status) {
      queryBuilder.where('booking.status = :status', { status });
    }

    const [bookings, total] = await queryBuilder
      .orderBy('booking.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      bookings,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Get analytics data
   */
  async getAnalytics() {
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const [bookingsByDay, revenueByDay] = await Promise.all([
      this.bookingRepository
        .createQueryBuilder('booking')
        .select('DATE(booking.created_at)', 'date')
        .addSelect('COUNT(*)', 'count')
        .where('booking.created_at >= :startDate', { startDate: last30Days })
        .groupBy('DATE(booking.created_at)')
        .orderBy('date', 'ASC')
        .getRawMany(),

      this.paymentRepository
        .createQueryBuilder('payment')
        .select('DATE(payment.created_at)', 'date')
        .addSelect('SUM(payment.amount)', 'revenue')
        .where('payment.created_at >= :startDate', { startDate: last30Days })
        .andWhere('payment.payment_status = :status', { status: PaymentStatus.COMPLETED })
        .groupBy('DATE(payment.created_at)')
        .orderBy('date', 'ASC')
        .getRawMany(),
    ]);

    return {
      bookings_by_day: bookingsByDay,
      revenue_by_day: revenueByDay,
    };
  }

  /**
   * Get all customers with pagination
   */
  async getAllCustomers(query: { page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const [customers, total] = await this.userRepository.findAndCount({
      // Hide self-deleted (anonymized) accounts from the admin list.
      where: { role: UserRole.CUSTOMER, is_deleted: false },
      select: ['id', 'phone', 'email', 'name', 'is_verified', 'is_active', 'created_at'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      customers,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Get all drivers with pagination
   */
  async getAllDrivers(query: { page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const [drivers, total] = await this.driverProfileRepository.findAndCount({
      relations: ['user'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      drivers,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Get driver details by ID
   */
  async getDriverById(driverId: string) {
    const driver = await this.driverProfileRepository.findOne({
      where: { id: driverId },
      relations: ['user', 'bank_accounts'],
    });

    if (!driver) {
      throw new Error('Driver not found');
    }

    // Recover missing vehicle_id for older driver profiles
    if (!driver.vehicle_id) {
      const vehicle = await this.vehicleRepository.findOne({
        where: { driver_id: driverId },
      });
      if (vehicle) {
        driver.vehicle_id = vehicle.id;
        await this.driverProfileRepository.update(driverId, { vehicle_id: vehicle.id });
      }
    }

    // bookings.driver_id stores the User ID (not DriverProfile ID)
    const driverUserId = driver.user_id;

    // Get driver's booking statistics
    const [totalBookings, completedBookings, totalEarnings] = await Promise.all([
      this.bookingRepository.count({ where: { driver_id: driverUserId } }),
      this.bookingRepository.count({
        where: { driver_id: driverUserId, status: BookingStatus.COMPLETED },
      }),
      this.paymentRepository
        .createQueryBuilder('payment')
        .leftJoin('payment.booking', 'booking')
        .where('booking.driver_id = :driverUserId', { driverUserId })
        .andWhere('payment.payment_status = :status', { status: PaymentStatus.COMPLETED })
        .select('SUM(payment.driver_earnings)', 'total')
        .getRawOne(),
    ]);

    // Fetch last 20 ratings for this driver
    const recentRatings = await this.ratingRepository.find({
      where: { driver_id: driverUserId },
      relations: ['customer'],
      order: { created_at: 'DESC' },
      take: 20,
    });

    // Convert private R2 document keys to presigned URLs for the admin panel.
    const signedDocs = await this.s3Service.signFields({
      aadhar_front_image: driver.aadhar_front_image,
      aadhar_back_image: driver.aadhar_back_image,
      driving_license_image: driver.driving_license_image,
      vehicle_rc_image: driver.vehicle_rc_image,
      profile_image: driver.profile_image,
    });

    // Decode the PostGIS geography Point into plain lat/lng for the map.
    const loc: any[] = await this.dataSource.query(
      `SELECT ST_Y(current_location::geometry) AS lat,
              ST_X(current_location::geometry) AS lng
         FROM driver_profiles WHERE id = $1`,
      [driverId],
    );
    const current_lat = loc?.[0]?.lat != null ? Number(loc[0].lat) : null;
    const current_lng = loc?.[0]?.lng != null ? Number(loc[0].lng) : null;

    return {
      ...driver,
      ...signedDocs,
      current_lat,
      current_lng,
      statistics: {
        total_bookings: totalBookings,
        completed_bookings: completedBookings,
        total_earnings: parseFloat(totalEarnings?.total || '0'),
      },
      recent_ratings: recentRatings.map((r) => ({
        id: r.id,
        rating: Number(r.rating),
        comment: r.comment || null,
        customer_name: r.customer?.name || 'Anonymous',
        created_at: r.created_at,
      })),
    };
  }

  /**
   * Get customer by ID with booking stats
   */
  async getCustomerById(customerId: string) {
    const customer = await this.userRepository.findOne({
      where: { id: customerId, role: UserRole.CUSTOMER },
      select: ['id', 'phone', 'email', 'name', 'is_verified', 'is_active', 'created_at'],
    });

    if (!customer) throw new NotFoundException('Customer not found');

    const [totalBookings, completedBookings, totalSpent] = await Promise.all([
      this.bookingRepository.count({ where: { customer_id: customerId } }),
      this.bookingRepository.count({ where: { customer_id: customerId, status: BookingStatus.COMPLETED } }),
      this.paymentRepository
        .createQueryBuilder('payment')
        .leftJoin('payment.booking', 'booking')
        .where('booking.customer_id = :customerId', { customerId })
        .andWhere('payment.payment_status = :status', { status: PaymentStatus.COMPLETED })
        .select('SUM(payment.amount)', 'total')
        .getRawOne(),
    ]);

    return {
      ...customer,
      statistics: {
        total_bookings: totalBookings,
        completed_bookings: completedBookings,
        total_spent: parseFloat(totalSpent?.total || '0'),
      },
    };
  }

  /**
   * Block a customer
   */
  async blockCustomer(customerId: string) {
    const customer = await this.userRepository.findOne({ where: { id: customerId, role: UserRole.CUSTOMER } });
    if (!customer) throw new NotFoundException('Customer not found');
    await this.userRepository.update(customerId, { is_active: false });
    return { message: 'Customer blocked successfully' };
  }

  /**
   * Unblock a customer
   */
  async unblockCustomer(customerId: string) {
    const customer = await this.userRepository.findOne({ where: { id: customerId, role: UserRole.CUSTOMER } });
    if (!customer) throw new NotFoundException('Customer not found');
    await this.userRepository.update(customerId, { is_active: true });
    return { message: 'Customer unblocked successfully' };
  }

  /**
   * Get customer booking history (paginated)
   */
  async getCustomerBookings(customerId: string, query: { page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const [bookings, total] = await this.bookingRepository.findAndCount({
      where: { customer_id: customerId },
      relations: ['driver', 'payments'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { bookings, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Suspend a driver
   */
  async suspendDriver(driverProfileId: string, reason?: string) {
    const profile = await this.driverProfileRepository.findOne({ where: { id: driverProfileId } });
    if (!profile) throw new NotFoundException('Driver not found');
    await this.userRepository.update(profile.user_id, { is_active: false });
    const clean = (reason || '').trim();
    await this.notificationService.push(
      profile.user_id,
      'general',
      'Account Suspended',
      clean
        ? `Your account has been suspended. Reason: ${clean}. Please contact support.`
        : 'Your account has been suspended by admin. Please contact support.',
      { type: 'account_suspended', ...(clean ? { reason: clean } : {}) },
    );
    return { message: 'Driver suspended successfully' };
  }

  /**
   * Activate a driver
   */
  async activateDriver(driverProfileId: string) {
    const profile = await this.driverProfileRepository.findOne({ where: { id: driverProfileId } });
    if (!profile) throw new NotFoundException('Driver not found');
    await this.userRepository.update(profile.user_id, { is_active: true });
    await this.notificationService.push(
      profile.user_id,
      'general',
      'Account Activated',
      'Your account has been reactivated. You can now receive bookings.',
    );
    return { message: 'Driver activated successfully' };
  }

  /**
   * Get booking by ID (admin full detail)
   */
  async getBookingById(bookingId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['customer', 'driver', 'vehicle', 'payments'],
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Include driver profile ID so admin panel can link to the driver detail page
    let driver_profile_id: string | null = null;
    if (booking.driver_id) {
      const profile = await this.driverProfileRepository.findOne({
        where: { user_id: booking.driver_id },
        select: ['id'],
      });
      driver_profile_id = profile?.id ?? null;
    }

    return { ...booking, driver_profile_id };
  }

  /**
   * Cancel booking as admin
   */
  async cancelBooking(bookingId: string, reason: string) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if ([BookingStatus.COMPLETED, BookingStatus.CANCELLED].includes(booking.status)) {
      throw new Error(`Booking is already ${booking.status}`);
    }
    await this.bookingRepository.update(bookingId, {
      status: BookingStatus.CANCELLED,
      cancellation_reason: reason,
    });
    return { message: 'Booking cancelled successfully' };
  }

  /**
   * Reassign booking to a different driver
   */
  async reassignBooking(bookingId: string, newDriverId: string) {
    const booking = await this.bookingRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    const driver = await this.userRepository.findOne({ where: { id: newDriverId, role: UserRole.DRIVER } });
    if (!driver) throw new NotFoundException('Driver not found');
    await this.bookingRepository.update(bookingId, { driver_id: newDriverId, status: BookingStatus.DRIVER_ASSIGNED });
    await this.notificationService.push(
      newDriverId,
      'general',
      'Booking Assigned',
      'A booking has been assigned to you by admin.',
    );
    return { message: 'Booking reassigned successfully' };
  }

  /**
   * Get all payments with pagination
   */
  async getAllPayments(query: { page?: number; limit?: number; status?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const { status } = query;
    const qb = this.paymentRepository
      .createQueryBuilder('payment')
      .leftJoinAndSelect('payment.booking', 'booking')
      .leftJoinAndSelect('booking.customer', 'customer')
      .leftJoinAndSelect('booking.driver', 'driver')
      .orderBy('payment.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (status && status !== 'all') {
      qb.where('payment.payment_status = :status', { status });
    }

    const [payments, total] = await qb.getManyAndCount();
    return { payments, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Get customer payment history
   */
  async getCustomerPayments(customerId: string, query: { page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const customer = await this.userRepository.findOne({ where: { id: customerId, role: UserRole.CUSTOMER } });
    if (!customer) throw new NotFoundException('Customer not found');

    const [payments, total] = await this.paymentRepository
      .createQueryBuilder('payment')
      .leftJoinAndSelect('payment.booking', 'booking')
      .where('booking.customer_id = :customerId', { customerId })
      .orderBy('payment.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { payments, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Get driver KYC documents
   */
  async getDriverKyc(driverId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { id: driverId },
      relations: ['user'],
    });
    if (!profile) throw new NotFoundException('Driver not found');

    // Documents are stored as private R2 keys → hand out short-lived presigned URLs.
    const documents = await this.s3Service.signFields({
      aadhar_front: profile.aadhar_front_image,
      aadhar_back: profile.aadhar_back_image,
      driving_license: profile.driving_license_image,
      vehicle_rc: profile.vehicle_rc_image,
      profile_image: profile.profile_image,
    });

    return {
      driver_id: profile.id,
      user_id: profile.user_id,
      name: profile.user?.name,
      phone: profile.user?.phone,
      verification_status: profile.verification_status,
      license_number: profile.license_number,
      license_expiry: profile.license_expiry,
      documents,
    };
  }

  /**
   * GST report: GST actually collected (completed payments) per booking, with
   * the customer's GSTIN + name + CGST/SGST breakdown, plus running totals.
   * Filterable by date range and GSTIN.
   */
  async getGstReport(params: {
    from?: string;
    to?: string;
    gstin?: string;
    type?: string; // 'b2b' | 'b2c' | undefined (all)
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
    const offset = (page - 1) * limit;

    const conds: string[] = [
      `p.payment_status = 'completed'`,
      `(b.fare_breakdown->>'gst_amount') IS NOT NULL`,
      `(b.fare_breakdown->>'gst_amount')::numeric > 0`,
    ];
    const args: any[] = [];
    if (params.from && params.to) {
      args.push(params.from, `${params.to}T23:59:59.999Z`);
      conds.push(`b.created_at BETWEEN $${args.length - 1} AND $${args.length}`);
    }
    if (params.gstin) {
      args.push(params.gstin.trim().toUpperCase());
      conds.push(`b.customer_gstin = $${args.length}`);
    }
    // B2B = has a customer GSTIN; B2C = no GSTIN.
    const type = (params.type || '').toLowerCase();
    if (type === 'b2b') conds.push(`b.customer_gstin IS NOT NULL`);
    else if (type === 'b2c') conds.push(`b.customer_gstin IS NULL`);
    const where = conds.join(' AND ');

    const transactions = await this.bookingRepository.manager.query(
      `SELECT b.id AS booking_id, b.created_at, b.customer_gstin,
              COALESCE(u.name, b.name) AS customer_name,
              COALESCE(u.phone, b.mobile_number) AS customer_phone,
              (b.fare_breakdown->>'delivery_charge')::numeric AS delivery_charge,
              (b.fare_breakdown->>'gst_percent')::numeric  AS gst_percent,
              (b.fare_breakdown->>'cgst_amount')::numeric   AS cgst_amount,
              (b.fare_breakdown->>'sgst_amount')::numeric   AS sgst_amount,
              (b.fare_breakdown->>'gst_amount')::numeric    AS gst_amount,
              b.estimated_fare::numeric AS total,
              p.payment_method, p.payment_status
         FROM bookings b
         JOIN payments p ON p.booking_id = b.id
         LEFT JOIN users u ON u.id = b.customer_id
        WHERE ${where}
        ORDER BY b.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      args,
    );

    const [summary] = await this.bookingRepository.manager.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM((b.fare_breakdown->>'gst_amount')::numeric),0)    AS total_gst,
              COALESCE(SUM((b.fare_breakdown->>'cgst_amount')::numeric),0)   AS total_cgst,
              COALESCE(SUM((b.fare_breakdown->>'sgst_amount')::numeric),0)   AS total_sgst,
              COALESCE(SUM((b.fare_breakdown->>'delivery_charge')::numeric),0) AS total_taxable,
              COUNT(*) FILTER (WHERE b.customer_gstin IS NOT NULL)::int AS b2b_count,
              COUNT(*) FILTER (WHERE b.customer_gstin IS NULL)::int     AS b2c_count,
              COALESCE(SUM((b.fare_breakdown->>'gst_amount')::numeric) FILTER (WHERE b.customer_gstin IS NOT NULL),0) AS b2b_gst,
              COALESCE(SUM((b.fare_breakdown->>'gst_amount')::numeric) FILTER (WHERE b.customer_gstin IS NULL),0)     AS b2c_gst
         FROM bookings b
         JOIN payments p ON p.booking_id = b.id
        WHERE ${where}`,
      args,
    );

    const total = Number(summary?.count) || 0;
    return {
      summary: {
        total_gst: Number(summary?.total_gst) || 0,
        total_cgst: Number(summary?.total_cgst) || 0,
        total_sgst: Number(summary?.total_sgst) || 0,
        total_taxable: Number(summary?.total_taxable) || 0,
        invoice_count: total,
        b2b_count: Number(summary?.b2b_count) || 0,
        b2c_count: Number(summary?.b2c_count) || 0,
        b2b_gst: Number(summary?.b2b_gst) || 0,
        b2c_gst: Number(summary?.b2c_gst) || 0,
      },
      transactions,
      total,
      page,
      limit,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /**
   * Build a GST/tax invoice for a single booking (admin view — no access check).
   * Mirrors PaymentService.generateInvoice so the report and the customer app
   * issue identical invoices. A valid B2B tax invoice needs both GSTINs.
   */
  async getGstInvoice(bookingId: string) {
    const payment = await this.paymentRepository.findOne({
      where: { booking_id: bookingId },
      relations: ['booking', 'booking.customer'],
    });
    if (!payment || !payment.booking) {
      throw new NotFoundException('Payment not found for this booking');
    }

    const booking = payment.booking;
    const bd = (booking.fare_breakdown || {}) as any;
    const tax = await this.systemSettings.getTaxSettings();
    const customerGstin = booking.customer_gstin || null;
    const isTaxInvoice = !!customerGstin && !!tax.zipto_gstin;

    return {
      invoice_number: `ZPT-${bookingId.slice(0, 8).toUpperCase()}`,
      invoice_date: payment.created_at ?? new Date(),
      is_tax_invoice: isTaxInvoice,
      seller: {
        name: tax.zipto_legal_name,
        gstin: tax.zipto_gstin || null,
        address: tax.zipto_invoice_address || null,
        state: tax.zipto_gst_state,
      },
      buyer: {
        name: booking.name || booking.customer?.name || null,
        phone: booking.mobile_number || booking.customer?.phone || null,
        gstin: customerGstin,
      },
      booking_id: bookingId,
      payment_id: payment.id,
      description: `Delivery service${booking.pickup_address ? ` (${booking.pickup_address} → ${booking.drop_address})` : ''}`,
      charges: {
        delivery_charge: bd.delivery_charge ?? null,
        platform_fee: bd.platform_fee ?? 0,
        gst_percent: bd.gst_percent ?? 0,
        cgst_amount: bd.cgst_amount ?? 0,
        sgst_amount: bd.sgst_amount ?? 0,
        gst_amount: bd.gst_amount ?? 0,
      },
      total: Number(payment.amount),
      payment_method: payment.payment_method,
      payment_status: payment.payment_status,
      note:
        customerGstin && !tax.zipto_gstin
          ? 'Zipto GSTIN not yet configured — set it in Admin → GST settings to issue a valid tax invoice.'
          : undefined,
    };
  }

  /**
   * Driver earnings overview: per-driver lifetime earnings (from completed
   * payments), current wallet balance, trips, and withdrawal totals.
   */
  async getDriverEarnings(params: { search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
    const offset = (page - 1) * limit;

    const args: any[] = [];
    let searchCond = '';
    if (params.search) {
      args.push(`%${params.search.trim()}%`);
      searchCond = `WHERE (u.name ILIKE $${args.length} OR u.phone ILIKE $${args.length})`;
    }

    const drivers = await this.driverProfileRepository.manager.query(
      `SELECT dp.id AS driver_profile_id, dp.user_id,
              u.name, u.phone,
              dp.wallet_balance::numeric AS wallet_balance,
              dp.total_trips,
              dp.average_rating::numeric AS average_rating,
              COALESCE(e.total_earnings, 0)::numeric      AS total_earnings,
              COALESCE(w.total_withdrawn, 0)::numeric     AS total_withdrawn,
              COALESCE(w.pending_withdrawals, 0)::numeric AS pending_withdrawals
         FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id
         LEFT JOIN (
           SELECT b.driver_id, SUM(p.driver_earnings) AS total_earnings
             FROM bookings b
             JOIN payments p ON p.booking_id = b.id AND p.payment_status = 'completed'
            GROUP BY b.driver_id
         ) e ON e.driver_id = dp.user_id
         LEFT JOIN (
           SELECT driver_profile_id,
                  SUM(amount) FILTER (WHERE status = 'completed') AS total_withdrawn,
                  SUM(amount) FILTER (WHERE status IN ('pending','processing')) AS pending_withdrawals
             FROM driver_withdrawal_requests
            GROUP BY driver_profile_id
         ) w ON w.driver_profile_id = dp.id
         ${searchCond}
        ORDER BY total_earnings DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}`,
      args,
    );

    const [cnt] = await this.driverProfileRepository.manager.query(
      `SELECT COUNT(*)::int AS count FROM driver_profiles dp JOIN users u ON u.id = dp.user_id ${searchCond}`,
      args,
    );
    const [tot] = await this.driverProfileRepository.manager.query(
      `SELECT COALESCE(SUM(p.driver_earnings),0)::numeric AS total_earnings
         FROM payments p WHERE p.payment_status = 'completed'`,
    );
    const total = Number(cnt?.count) || 0;

    return {
      summary: { total_driver_earnings: Number(tot?.total_earnings) || 0, driver_count: total },
      drivers,
      total,
      page,
      limit,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /**
   * Get booking live tracking info (status + driver current location)
   */
  async getBookingTracking(bookingId: string) {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId },
      relations: ['driver'],
    });
    if (!booking) throw new NotFoundException('Booking not found');

    let driverLocation: { latitude: number; longitude: number } | null = null;

    if (booking.driver_id) {
      const driverProfile = await this.driverProfileRepository.findOne({
        where: { user_id: booking.driver_id },
        select: ['current_location'],
      });

      if (driverProfile?.current_location) {
        try {
          const geo = typeof driverProfile.current_location === 'string'
            ? JSON.parse(driverProfile.current_location)
            : driverProfile.current_location as any;
          driverLocation = {
            longitude: geo.coordinates?.[0],
            latitude: geo.coordinates?.[1],
          };
        } catch {
          // ignore parse errors
        }
      }
    }

    return {
      booking_id: booking.id,
      status: booking.status,
      pickup_location: booking.pickup_location,
      pickup_address: booking.pickup_address,
      drop_location: booking.drop_location,
      drop_address: booking.drop_address,
      driver: booking.driver
        ? { id: booking.driver.id, name: booking.driver.name, phone: booking.driver.phone }
        : null,
      driver_current_location: driverLocation,
      acceptance_time: booking.acceptance_time,
      start_time: booking.start_time,
    };
  }

  /**
   * Helper method to get date range from query
   */
  private getDateRange(query: { period?: string; startDate?: string; endDate?: string }): {
    start: Date;
    end: Date;
  } {
    const today = new Date();
    const start = new Date(today);
    const end = new Date(today);

    // Set end of today
    end.setHours(23, 59, 59, 999);

    // If no period but custom dates provided, treat as custom
    const period = query.period || (query.startDate || query.endDate ? 'custom' : undefined);

    switch (period) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'yesterday':
        start.setDate(today.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        end.setDate(today.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        break;
      case 'last7days':
        start.setDate(today.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        break;
      case 'last30days':
        start.setDate(today.getDate() - 30);
        start.setHours(0, 0, 0, 0);
        break;
      case 'thisMonth':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
      case 'lastMonth':
        start.setMonth(today.getMonth() - 1);
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        end.setDate(0); // Last day of previous month
        end.setHours(23, 59, 59, 999);
        break;
      case 'custom':
        if (query.startDate) {
          const customStart = new Date(query.startDate);
          start.setTime(customStart.getTime());
          start.setHours(0, 0, 0, 0);
        }
        if (query.endDate) {
          const customEnd = new Date(query.endDate);
          end.setTime(customEnd.getTime());
          end.setHours(23, 59, 59, 999);
        }
        break;
      default:
        // Default to last 30 days
        start.setDate(today.getDate() - 30);
        start.setHours(0, 0, 0, 0);
    }

    return { start, end };
  }

  /**
   * Get booking reports
   */
  async getBookingReports(query: {
    period?: string;
    startDate?: string;
    endDate?: string;
    city?: string;
  }) {
    const { start, end } = this.getDateRange(query);

    const queryBuilder = this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.created_at BETWEEN :start AND :end', { start, end });

    if (query.city && query.city !== 'all') {
      queryBuilder.andWhere('booking.city = :city', { city: query.city });
    }

    // Chart Data
    const bookingsByDay = await queryBuilder
      .clone()
      .select('DATE(booking.created_at)', 'date')
      .addSelect('COUNT(*)', 'value')
      .groupBy('DATE(booking.created_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    // Summary Data
    const totalBookings = await queryBuilder.clone().getCount();
    const completed = await queryBuilder
      .clone()
      .andWhere('booking.status = :status', { status: BookingStatus.COMPLETED })
      .getCount();
    const cancelled = await queryBuilder
      .clone()
      .andWhere('booking.status = :status', { status: BookingStatus.CANCELLED })
      .getCount();

    // Calculate days difference
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;

    return {
      chartData: bookingsByDay.map((row) => ({
        date: row.date,
        value: parseInt(row.value, 10) || 0,
      })),
      summary: {
        totalBookings,
        completed,
        cancelled,
        completionRate:
          totalBookings > 0 ? parseFloat(((completed / totalBookings) * 100).toFixed(1)) : 0,
        avgPerDay: Math.round(totalBookings / diffDays),
      },
    };
  }

  /**
   * Get revenue reports
   */
  async getRevenueReports(query: {
    period?: string;
    startDate?: string;
    endDate?: string;
    city?: string;
  }) {
    const { start, end } = this.getDateRange(query);

    const queryBuilder = this.paymentRepository
      .createQueryBuilder('payment')
      .leftJoin('payment.booking', 'booking')
      .where('payment.created_at BETWEEN :start AND :end', { start, end })
      .andWhere('payment.payment_status = :status', { status: PaymentStatus.COMPLETED });

    if (query.city && query.city !== 'all') {
      // payment table doesn't have city, so join with booking
      queryBuilder.andWhere('booking.city = :city', { city: query.city });
    }

    // Chart Data
    const revenueByDay = await queryBuilder
      .clone()
      .select('DATE(payment.created_at)', 'date')
      .addSelect('SUM(payment.amount)', 'value')
      .groupBy('DATE(payment.created_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    // Summary Data
    const summaryResult = await queryBuilder
      .clone()
      .select('SUM(payment.amount)', 'totalRevenue')
      .addSelect('SUM(payment.driver_earnings)', 'driverPayouts')
      .getRawOne();

    const totalRevenue = parseFloat(summaryResult?.totalRevenue || '0');
    const driverPayouts = parseFloat(summaryResult?.driverPayouts || '0');
    const platformFee = parseFloat((totalRevenue - driverPayouts).toFixed(2));

    const totalPayments = await queryBuilder.clone().getCount();

    return {
      chartData: revenueByDay.map((row) => ({
        date: row.date,
        value: parseFloat(row.value) || 0,
      })),
      summary: {
        totalRevenue,
        platformFee,
        driverPayouts,
        avgOrderValue: totalPayments > 0 ? parseFloat((totalRevenue / totalPayments).toFixed(2)) : 0,
      },
    };
  }

  /**
   * Get driver reports
   */
  async getDriverReports(query: {
    period?: string;
    startDate?: string;
    endDate?: string;
    city?: string;
  }) {
    const { start, end } = this.getDateRange(query);

    // Calculate Driver Stats based on bookings in period
    const topDrivers = await this.bookingRepository
      .createQueryBuilder('booking')
      .leftJoin('booking.driver', 'driver') // Join with user
      .leftJoin('booking.payments', 'payment', 'payment.payment_status = :paymentStatus', {
        paymentStatus: PaymentStatus.COMPLETED,
      })
      .select('booking.driver_id', 'id')
      .addSelect('driver.name', 'name')
      .addSelect('COUNT(booking.id)', 'trips')
      .addSelect('COALESCE(SUM(payment.amount) * 0.8, 0)', 'earnings') // Approx 80% earnings
      // We don't have direct rating on booking, checking driver profile
      // For now, fetching simplified data
      .where('booking.created_at BETWEEN :start AND :end', { start, end })
      .andWhere('booking.status = :status', { status: BookingStatus.COMPLETED })
      .andWhere('booking.driver_id IS NOT NULL')
      .groupBy('booking.driver_id')
      .addGroupBy('driver.name') // Postgres requires this
      .orderBy('earnings', 'DESC')
      .limit(10)
      .getRawMany();

    // Fetch up-to-date ratings from driver profile for these top drivers
    const driverIds = topDrivers.map((d) => d.id);
    const driverRatingsMap: Record<string, number> = {};
    if (driverIds.length > 0) {
      const profiles = await this.driverProfileRepository
        .createQueryBuilder('profile')
        .where('profile.user_id IN (:...driverIds)', { driverIds })
        .select(['profile.user_id', 'profile.average_rating'])
        .getMany();

      profiles.forEach((p) => {
        driverRatingsMap[p.user_id] = parseFloat(p.average_rating?.toString() || '0');
      });
    }

    const formattedDrivers = topDrivers.map((d) => ({
      id: d.id,
      name: d.name,
      trips: parseInt(d.trips),
      earnings: parseFloat(d.earnings),
      rating: driverRatingsMap[d.id] || 0,
    }));

    return {
      topDrivers: formattedDrivers,
    };
  }

  /**
   * Get customer reports
   */
  async getCustomerReports(query: {
    period?: string;
    startDate?: string;
    endDate?: string;
    city?: string;
  }) {
    const { start, end } = this.getDateRange(query);

    // New Customers in period
    const newCustomers = await this.userRepository.count({
      where: {
        role: UserRole.CUSTOMER,
        created_at: Between(start, end),
      },
    });

    // Active customers (who made a booking in this period)
    const activeCustomerResult = await this.bookingRepository
      .createQueryBuilder('booking')
      .select('COUNT(DISTINCT booking.customer_id)', 'count')
      .where('booking.created_at BETWEEN :start AND :end', { start, end })
      .getRawOne();

    const activeCustomers = parseInt(activeCustomerResult?.count || '0');

    // Returning customers: Active customers who joined BEFORE this period
    const returningCustomerResult = await this.bookingRepository
      .createQueryBuilder('booking')
      .leftJoin('booking.customer', 'customer')
      .select('COUNT(DISTINCT booking.customer_id)', 'count')
      .where('booking.created_at BETWEEN :start AND :end', { start, end })
      .andWhere('customer.created_at < :start', { start })
      .getRawOne();

    const returningCustomers = parseInt(returningCustomerResult?.count || '0');

    // Churn calculation is complex, approximating:
    // Customers active last period but NOT this period
    // For simplicity, returning mock-ish data based on available metrics or implementing fully would verify historical data
    // Let's implement simpler retention: (Returning Customers / (Active Customers at Start of Period)) * 100
    // Simplified: Retention Rate = (Returning Customers / Total Active Customers) * 100

    const retentionRate =
      activeCustomers > 0
        ? parseFloat(((returningCustomers / activeCustomers) * 100).toFixed(1))
        : 0;

    const churnRate = parseFloat((100 - retentionRate).toFixed(1));

    // Satisfaction (Average Rating)
    // Assuming ratings come from bookings or driver profiles.
    // Since we don't have explicit review table, using DriverProfile average rating global for now
    // Or check if bookings have ratings

    const avgRatingResult = await this.driverProfileRepository
      .createQueryBuilder('profile')
      .select('AVG(profile.average_rating)', 'avg')
      .getRawOne();

    const averageRating = parseFloat(avgRatingResult?.avg || '0').toFixed(1);

    return {
      acquisition: {
        newCustomers,
        returningCustomers,
        retentionRate,
        churnRate,
      },
      satisfaction: {
        averageRating: parseFloat(averageRating),
        fiveStarReviews: 0,
        supportTickets: 0,
      },
    };
  }

  /**
   * Export reports
   */
  async exportReports(query: {
    type?: string;
    format?: string;
    period?: string;
    startDate?: string;
    endDate?: string;
    city?: string;
  }) {
    // Generate data based on type
    let data = [];
    let headers = [];

    switch (query.type) {
      case 'bookings':
        const bookingReport = await this.getBookingReports(query);
        data = bookingReport.chartData;
        headers = ['Date', 'Bookings'];
        break;
      case 'revenue':
        const revenueReport = await this.getRevenueReports(query);
        data = revenueReport.chartData;
        headers = ['Date', 'Revenue'];
        break;
      case 'drivers':
        const driverReport = await this.getDriverReports(query);
        data = driverReport.topDrivers;
        headers = ['ID', 'Name', 'Trips', 'Earnings', 'Rating'];
        break;
      case 'customers':
        const customerReport = await this.getCustomerReports(query);
        data = [customerReport.acquisition];
        headers = ['NewCustomers', 'ReturningCustomers', 'RetentionRate', 'ChurnRate'];
        break;
      default:
        throw new Error('Invalid export type');
    }

    if (query.format === 'csv') {
      return this.generateCSV(data, headers);
    }

    // PDF Implementation would go here (omitted for brevity)
    return 'PDF format not supported yet';
  }

  private generateCSV(data: any[], headers: string[]): string {
    const headerRow = headers.join(',') + '\n';
    const rows = data
      .map((row) => {
        return headers
          .map((header) => {
            const key = header.toLowerCase();
            // Handle mapping simple keys
            if (key === 'date') return row.date;
            if (key === 'bookings') return row.value;
            if (key === 'revenue') return row.value;
            // Handle driver keys
            return row[key] || '';
          })
          .join(',');
      })
      .join('\n');

    return headerRow + rows;
  }

  /**
   * Seed Pricing Rules
   */
  async seedPricingRules() {
    const rules = getDefaultPricingRules(DEFAULT_PRICING_CITY);
    const results = [];

    for (const rule of rules) {
      const existing = await this.pricingRuleRepository.findOne({
        where: { vehicle_type: rule.vehicle_type, city: rule.city },
      });

      if (existing) {
        Object.assign(existing, rule, { is_active: true });
        results.push(await this.pricingRuleRepository.save(existing));
      } else {
        const newRule = this.pricingRuleRepository.create(rule);
        results.push(await this.pricingRuleRepository.save(newRule));
      }
    }

    await this.pricingRuleRepository
      .createQueryBuilder()
      .update(PricingRule)
      .set({ is_active: false })
      .where('city = :city', { city: DEFAULT_PRICING_CITY })
      .andWhere('vehicle_type IN (:...legacyTypes)', { legacyTypes: LEGACY_VEHICLE_TYPES })
      .execute();

    return { message: 'Pricing rules seeded successfully', count: results.length, data: results };
  }

  // ─── Withdrawal Management ────────────────────────────────────────────────

  async getWithdrawals(status?: string) {
    const where: any = {};
    if (status) where.status = status;

    return this.withdrawalRepository.find({
      where,
      relations: ['driver_profile', 'driver_profile.user', 'bank_account'],
      order: { created_at: 'DESC' },
    });
  }

  async approveWithdrawal(withdrawalId: string, remarks?: string, payoutReference?: string) {
    const withdrawal = await this.withdrawalRepository.findOne({
      where: { id: withdrawalId },
      relations: ['driver_profile', 'driver_profile.user', 'bank_account'],
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal request not found');
    if (withdrawal.status === WithdrawalStatus.COMPLETED) return withdrawal;
    if (withdrawal.status === WithdrawalStatus.REJECTED) {
      throw new BadRequestException('Cannot approve a withdrawal that has already been rejected');
    }
    // Auto-payout already triggered at request time — payout is in flight, webhook will finalize
    if (withdrawal.status === WithdrawalStatus.PROCESSING && withdrawal.payout_id) {
      throw new BadRequestException(
        `Payout already in progress (transfer: ${withdrawal.payout_id}). Status will update automatically via webhook when IMPS settles.`,
      );
    }

    const driverUserId = withdrawal.driver_profile?.user_id;
    const amount       = Number(withdrawal.amount);
    const bankAccount  = withdrawal.bank_account;

    // ── Attempt automated payout via Cashfree Payouts ─────────────────────
    if (this.cashfreePayoutService.isConfigured && bankAccount?.cashfree_beneficiary_id) {
      try {
        const transfer = await this.cashfreePayoutService.createTransfer({
          transferId:    this.cashfreePayoutService.generateTransferId(withdrawalId),
          beneficiaryId: bankAccount.cashfree_beneficiary_id,
          amount,
          remarks:       'Zipto driver payout',
          mode:          'imps',
        });

        // Mark as PROCESSING — final status comes via webhook
        withdrawal.status     = WithdrawalStatus.PROCESSING;
        withdrawal.payout_id  = transfer.transferId;
        if (transfer.utr) withdrawal.payout_reference = transfer.utr;
        if (remarks) withdrawal.remarks = remarks;
        const saved = await this.withdrawalRepository.save(withdrawal);

        this.logger.log(`[CashfreePayout] Payout queued: withdrawal=${withdrawalId}, transfer=${transfer.transferId}, status=${transfer.status}`);

        if (driverUserId) {
          const bankName = bankAccount.bank_name ?? 'your bank account';
          const last4    = bankAccount.account_number?.slice(-4) ?? '';
          this.notificationService.sendPushNotification({
            user_id: driverUserId,
            title: '💸 Payout Initiated!',
            body: `₹${amount.toLocaleString('en-IN')} is being transferred to ${bankName}${last4 ? ` (••••${last4})` : ''}. Expect credit within 30 minutes via IMPS.`,
            data: { type: 'withdrawal_approved', amount: String(amount), withdrawal_id: withdrawalId },
          }).catch(() => {});
        }
        return saved;
      } catch (err: any) {
        // Cashfree call failed — fall through to manual-approve path
        this.logger.error(
          `[CashfreePayout] Automated payout failed for withdrawal=${withdrawalId}: ${err?.response?.data?.message ?? err?.message}. Falling back to manual.`,
        );
      }
    } else if (this.cashfreePayoutService.isConfigured && !bankAccount?.cashfree_beneficiary_id) {
      // Bank account not yet synced — proceed manually
      this.logger.warn(
        `[CashfreePayout] Bank account ${bankAccount?.id ?? 'unknown'} has no beneficiary_id — payout will be manual.`,
      );
    }

    // ── Manual fallback: mark COMPLETED (admin physically transfers money) ──
    withdrawal.status = WithdrawalStatus.COMPLETED;
    if (remarks) withdrawal.remarks = remarks;
    if (payoutReference) withdrawal.payout_reference = payoutReference;
    const saved = await this.withdrawalRepository.save(withdrawal);

    if (driverUserId) {
      const bankName = bankAccount?.bank_name ?? 'your bank account';
      const last4    = bankAccount?.account_number?.slice(-4) ?? '';
      this.notificationService.sendPushNotification({
        user_id: driverUserId,
        title: '💸 Withdrawal Approved!',
        body: `₹${amount.toLocaleString('en-IN')} is being transferred to ${bankName}${last4 ? ` (••••${last4})` : ''}. Allow 1–2 business days.`,
        data: { type: 'withdrawal_approved', amount: String(amount), withdrawal_id: withdrawalId },
      }).catch(() => {});
    }
    return saved;
  }

  /**
   * Handle Cashfree Payouts webhook events (TRANSFER_SUCCESS / TRANSFER_FAILED /
   * TRANSFER_REVERSED). Called from the webhook endpoint; verifies the HMAC
   * signature, then finalizes or refunds the withdrawal. Idempotent.
   */
  async handlePayoutWebhook(rawBody: Buffer, signature: string, timestamp: string): Promise<void> {
    const raw = rawBody.toString('utf8');
    if (!this.cashfreePayoutService.verifyWebhookSignature(raw, signature, timestamp)) {
      this.logger.warn('[CashfreePayout] Webhook signature invalid — ignored');
      return;
    }

    // Parse JSON (V2) or fall back to form-urlencoded (V1).
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      try {
        event = Object.fromEntries(new URLSearchParams(raw));
      } catch {
        this.logger.warn('[CashfreePayout] Webhook: unparseable body');
        return;
      }
    }

    // Tolerate both V2 ({ type, data:{ transfer_id, status, transfer_utr } })
    // and V1 ({ event, transferId, ... }) field shapes.
    const data = event?.data ?? event?.payload ?? event?.transfer ?? event ?? {};
    const eventType: string = String(event?.type ?? event?.event ?? data?.event ?? '').toUpperCase();
    const transferId: string =
      data?.transfer_id ?? data?.transfer?.transfer_id ?? data?.transferId ?? event?.transferId;
    const status: string = String(
      data?.status ?? data?.transfer?.status ?? event?.status ?? '',
    ).toUpperCase();
    if (!transferId) {
      this.logger.warn('[CashfreePayout] Webhook: no transfer_id in payload');
      return;
    }

    this.logger.log(`[CashfreePayout] Webhook type=${eventType}, transfer=${transferId}, status=${status}`);

    const withdrawal = await this.withdrawalRepository.findOne({
      where: { payout_id: transferId },
      relations: ['driver_profile'],
    });
    if (!withdrawal) {
      this.logger.warn(`[CashfreePayout] No withdrawal found for transfer_id=${transferId}`);
      return;
    }

    const driverUserId = withdrawal.driver_profile?.user_id;
    const amount       = Number(withdrawal.amount);

    const isSuccess = eventType === 'TRANSFER_SUCCESS' || status === 'SUCCESS';
    const isFailure =
      eventType === 'TRANSFER_FAILED' ||
      eventType === 'TRANSFER_REVERSED' ||
      ['FAILED', 'REJECTED', 'REVERSED', 'ERROR', 'CANCELLED'].includes(status);

    if (isSuccess) {
      // ── Success: finalize ──────────────────────────────────────────────
      if (withdrawal.status === WithdrawalStatus.COMPLETED) return; // idempotent
      const utr: string =
        data?.transfer_utr ?? data?.transfer?.transfer_utr ?? data?.utr ?? event?.utr ?? '';
      withdrawal.status           = WithdrawalStatus.COMPLETED;
      withdrawal.payout_reference = utr || withdrawal.payout_reference;
      await this.withdrawalRepository.save(withdrawal);
      this.logger.log(`[CashfreePayout] Payout processed: withdrawal=${withdrawal.id}, UTR=${utr}`);

      if (driverUserId) {
        this.notificationService.sendPushNotification({
          user_id: driverUserId,
          title: '✅ Payout Successful',
          body: `₹${amount.toLocaleString('en-IN')} has been credited to your bank account.${utr ? ` UTR: ${utr}` : ''}`,
          data: { type: 'payout_processed', amount: String(amount), withdrawal_id: withdrawal.id },
        }).catch(() => {});
      }

    } else if (isFailure) {
      // ── Failure: refund wallet ─────────────────────────────────────────
      if (withdrawal.status === WithdrawalStatus.REJECTED) return; // idempotent
      const failureReason: string =
        data?.status_description ??
        data?.transfer?.status_description ??
        (eventType || 'Payout failed');

      withdrawal.status         = WithdrawalStatus.REJECTED;
      withdrawal.failure_reason = failureReason;
      await this.withdrawalRepository.save(withdrawal);

      // Refund driver wallet (idempotent)
      if (driverUserId) {
        await this.driverWalletService.withdrawalRefund(driverUserId, amount, withdrawal.id);
        this.logger.log(`[CashfreePayout] Payout ${eventType}: wallet refunded ₹${amount} for driver=${driverUserId}`);
        this.notificationService.sendPushNotification({
          user_id: driverUserId,
          title: '⚠️ Payout Failed',
          body: `Your ₹${amount.toLocaleString('en-IN')} withdrawal could not be processed and has been refunded to your Zipto wallet. Please try again.`,
          data: { type: 'payout_failed', amount: String(amount), withdrawal_id: withdrawal.id },
        }).catch(() => {});
      }
    }
  }

  async rejectWithdrawal(withdrawalId: string, remarks?: string) {
    const withdrawal = await this.withdrawalRepository.findOne({
      where: { id: withdrawalId },
      relations: ['driver_profile', 'driver_profile.user'],
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal request not found');
    if (withdrawal.status === WithdrawalStatus.COMPLETED) {
      throw new BadRequestException('Cannot reject a withdrawal that has already been completed');
    }
    if (withdrawal.status === WithdrawalStatus.REJECTED) {
      return withdrawal; // idempotent — already rejected
    }

    // Refund via wallet service (idempotent, logs a transaction record)
    const driverUserId = withdrawal.driver_profile?.user_id;
    if (driverUserId) {
      await this.driverWalletService.withdrawalRefund(
        driverUserId,
        Number(withdrawal.amount),
        withdrawalId,
      );
    }

    withdrawal.status = WithdrawalStatus.REJECTED;
    if (remarks) withdrawal.remarks = remarks;
    const saved = await this.withdrawalRepository.save(withdrawal);

    // Notify driver: amount refunded to wallet
    if (driverUserId) {
      const amount = Number(withdrawal.amount);
      this.notificationService.sendPushNotification({
        user_id: driverUserId,
        title: 'Withdrawal Rejected',
        body: `Your ₹${amount.toLocaleString('en-IN')} withdrawal was rejected and has been refunded to your Zipto wallet.${remarks ? ` Reason: ${remarks}` : ''}`,
        data: { type: 'withdrawal_rejected', amount: String(amount), withdrawal_id: withdrawalId },
      }).catch(() => {});
    }

    return saved;
  }

  // ─── UPI Topup Requests ───────────────────────────────────────────────────

  async getTopupRequests(status?: string) {
    const where: any = status ? { status } : {};
    const rows = await this.dataSource.query(
      `SELECT r.*, u.name as driver_name, u.phone as driver_phone
       FROM driver_topup_requests r
       JOIN users u ON u.id = r.driver_user_id
       ${status ? `WHERE r.status = '${status}'` : ''}
       ORDER BY r.created_at DESC`,
    );
    return rows;
  }

  async approveTopupRequest(requestId: string) {
    const rows = await this.dataSource.query(
      `SELECT * FROM driver_topup_requests WHERE id = $1`, [requestId],
    );
    if (!rows.length) throw new NotFoundException('Topup request not found');
    const req = rows[0];
    if (req.status !== 'pending') throw new BadRequestException('Request is already ' + req.status);

    await this.dataSource.query(
      `UPDATE driver_topup_requests SET status = 'approved', updated_at = NOW() WHERE id = $1`, [requestId],
    );

    const newBalance = await this.driverWalletService.adminCredit(
      req.driver_user_id,
      Number(req.amount),
      `UPI top-up approved — UTR ${req.utr_number}`,
    );

    this.notificationService.sendPushNotification({
      user_id: req.driver_user_id,
      title: 'Wallet Topped Up!',
      body: `₹${Number(req.amount).toLocaleString('en-IN')} added to your Zipto wallet. New balance: ₹${newBalance.toLocaleString('en-IN')}.`,
      data: { type: 'topup_approved', amount: String(req.amount) },
    }).catch(() => {});

    return { message: 'Approved and wallet credited', new_balance: newBalance };
  }

  async rejectTopupRequest(requestId: string, remarks?: string) {
    const rows = await this.dataSource.query(
      `SELECT * FROM driver_topup_requests WHERE id = $1`, [requestId],
    );
    if (!rows.length) throw new NotFoundException('Topup request not found');
    const req = rows[0];
    if (req.status !== 'pending') throw new BadRequestException('Request is already ' + req.status);

    await this.dataSource.query(
      `UPDATE driver_topup_requests SET status = 'rejected', remarks = $1, updated_at = NOW() WHERE id = $2`,
      [remarks ?? null, requestId],
    );

    this.notificationService.sendPushNotification({
      user_id: req.driver_user_id,
      title: 'Top-up Rejected',
      body: `Your ₹${Number(req.amount).toLocaleString('en-IN')} top-up request was rejected.${remarks ? ` Reason: ${remarks}` : ''} Contact support if you believe this is an error.`,
      data: { type: 'topup_rejected' },
    }).catch(() => {});

    return { message: 'Topup request rejected' };
  }

  // ─── Driver Wallet ────────────────────────────────────────────────────────

  async adminCreditDriverWallet(driverProfileId: string, amount: number, note: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { id: driverProfileId },
      relations: ['user'],
    });
    if (!profile) throw new NotFoundException('Driver not found');

    const newBalance = await this.driverWalletService.adminCredit(
      profile.user_id,
      amount,
      note,
    );

    // Push notification
    this.notificationService.sendPushNotification({
      user_id: profile.user_id,
      title: 'Wallet Credited',
      body: `₹${amount.toLocaleString('en-IN')} added to your Zipto wallet. New balance: ₹${newBalance.toLocaleString('en-IN')}.`,
      data: { type: 'wallet_credit', amount: String(amount) },
    }).catch(() => {});

    return { message: 'Wallet credited', new_balance: newBalance };
  }

  // ─── Driver Data Reset ────────────────────────────────────────────────────

  /**
   * Reset a single driver's earnings, wallet, trips and ride history.
   * Deletes only records belonging to this driver — no other driver is affected.
   */
  /**
   * Live map feed: every driver currently online or busy, with their last known
   * GPS location, vehicle, and active trip (if any). Powers the dashboard map.
   */
  async getLiveDrivers() {
    const rows: any[] = await this.dataSource.query(
      `SELECT
          dp.id                                AS driver_profile_id,
          dp.user_id                           AS user_id,
          u.name                               AS name,
          u.phone                              AS phone,
          dp.availability_status               AS status,
          dp.average_rating                    AS rating,
          dp.updated_at                        AS updated_at,
          ST_Y(dp.current_location::geometry)  AS lat,
          ST_X(dp.current_location::geometry)  AS lng,
          v.registration_number                AS vehicle_number,
          v.vehicle_type                        AS vehicle_type,
          b.id                                 AS active_booking_id,
          b.status                             AS active_booking_status
        FROM driver_profiles dp
        JOIN users u
          ON u.id = dp.user_id AND u.is_active = true AND u.is_deleted = false
        LEFT JOIN vehicles v ON v.id = dp.vehicle_id
        LEFT JOIN LATERAL (
          SELECT id, status FROM bookings
           WHERE driver_id = dp.user_id
             AND status IN ('accepted','driver_assigned','ongoing')
           ORDER BY created_at DESC
           LIMIT 1
        ) b ON true
        WHERE dp.availability_status IN ('online','busy')
          AND dp.current_location IS NOT NULL
        ORDER BY dp.availability_status, u.name`,
    );

    const drivers = rows
      .map((r) => ({
        driver_profile_id: r.driver_profile_id,
        user_id: r.user_id,
        name: r.name,
        phone: r.phone,
        status: r.status as 'online' | 'busy',
        rating: r.rating != null ? Number(r.rating) : null,
        lat: r.lat != null ? Number(r.lat) : null,
        lng: r.lng != null ? Number(r.lng) : null,
        vehicle_number: r.vehicle_number ?? null,
        vehicle_type: r.vehicle_type ?? null,
        active_booking_id: r.active_booking_id ?? null,
        active_booking_status: r.active_booking_status ?? null,
        last_updated: r.updated_at,
      }))
      .filter((d) => d.lat != null && d.lng != null);

    return {
      total: drivers.length,
      online: drivers.filter((d) => d.status === 'online').length,
      busy: drivers.filter((d) => d.status === 'busy').length,
      drivers,
    };
  }

  async resetDriverData(driverProfileId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { id: driverProfileId },
      relations: ['user'],
    });
    if (!profile) throw new NotFoundException('Driver profile not found');

    const userId = profile.user_id;
    const cleared: Record<string, number> = {};

    // Many tables reference this driver's bookings via a booking_id FK
    // (driver_fraud_incidents, customer_reports, payments, …), so every child
    // row MUST be cleared before the bookings themselves — otherwise the final
    // DELETE fails with a foreign-key violation. Run it all in one transaction.
    //
    // Two gotchas handled here:
    //  • bookings.driver_id / ratings.driver_id store the USER id, not the
    //    driver_profile id — so we match on EITHER id ($1 = userId, $2 = profileId).
    //  • some booking_id columns are varchar (e.g. support_tickets) while
    //    bookings.id is uuid, so everything is compared as ::text to avoid
    //    "operator does not exist: character varying = uuid".
    const bScope = `(SELECT id::text FROM bookings WHERE driver_id::text IN ($1, $2))`;

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      // Every statement takes the same two params ($1=userId, $2=profileId);
      // RETURNING 1 → the result array length is the affected-row count.
      const del = async (label: string, sql: string) => {
        const rows = await runner.query(`${sql} RETURNING 1`, [userId, driverProfileId]);
        cleared[label] = Array.isArray(rows) ? rows.length : 0;
      };

      // ── 1. Rows hanging off this driver's bookings (FK children first) ──
      await del('payments',                  `DELETE FROM payments WHERE booking_id::text IN ${bScope}`);
      await del('ratings',                   `DELETE FROM ratings WHERE driver_id::text IN ($1, $2) OR booking_id::text IN ${bScope}`);
      await del('transaction_logs',          `DELETE FROM transaction_logs WHERE user_id::text IN ($1, $2) OR counterparty_user_id::text IN ($1, $2) OR booking_id::text IN ${bScope}`);
      await del('coin_transactions',         `DELETE FROM coin_transactions WHERE booking_id::text IN ${bScope}`);
      await del('zipto_shield_transactions', `DELETE FROM zipto_shield_transactions WHERE booking_id::text IN ${bScope}`);
      await del('driver_fraud_incidents',    `DELETE FROM driver_fraud_incidents WHERE driver_id::text IN ($1, $2) OR booking_id::text IN ${bScope}`);
      await del('customer_reports',          `DELETE FROM customer_reports WHERE booking_id::text IN ${bScope}`);
      await del('support_tickets',           `DELETE FROM support_tickets WHERE booking_id::text IN ${bScope}`);
      await del('coupon_usages',             `DELETE FROM coupon_usages WHERE booking_id::text IN ${bScope}`);
      // Referrals are kept (they record a relationship); just unlink the booking.
      await del('referrals_unlinked',        `UPDATE referrals SET qualifying_booking_id = NULL WHERE qualifying_booking_id::text IN ${bScope}`);

      // ── 2. Driver-scoped money tables ──
      await del('driver_wallet_transactions', `DELETE FROM driver_wallet_transactions WHERE driver_user_id::text IN ($1, $2)`);
      await del('driver_topup_requests',      `DELETE FROM driver_topup_requests WHERE driver_user_id::text IN ($1, $2)`);
      await del('driver_withdrawal_requests', `DELETE FROM driver_withdrawal_requests WHERE driver_profile_id::text IN ($1, $2)`);

      // ── 3. The bookings themselves ──
      await del('bookings', `DELETE FROM bookings WHERE driver_id::text IN ($1, $2)`);

      // ── 4. Reset profile counters ──
      await runner.query(
        `UPDATE driver_profiles
            SET wallet_balance = 0, total_trips = 0, average_rating = NULL,
                wallet_frozen = false, wallet_freeze_reason = NULL
          WHERE id::text IN ($1, $2)`,
        [userId, driverProfileId],
      );

      await runner.commitTransaction();
    } catch (err: any) {
      await runner.rollbackTransaction();
      this.logger.error(`[Admin] resetDriverData failed for ${driverProfileId}: ${err?.message ?? err}`);
      throw new BadRequestException(`Failed to reset driver data: ${err?.message ?? 'unknown error'}`);
    } finally {
      await runner.release();
    }

    this.logger.log(
      `[Admin] Driver data reset: driver=${driverProfileId} (${profile.user?.name ?? userId}) — ${JSON.stringify(cleared)}`,
    );

    return {
      message: `All earnings, wallet, and ride data cleared for driver ${profile.user?.name ?? userId}.`,
      cleared,
    };
  }

  // ─── Dev / Test Data Reset ────────────────────────────────────────────────

  async resetAllData() {
    const q = this.dataSource.query.bind(this.dataSource);

    // Delete in FK-safe order (child tables first)
    const tables = [
      'ratings',
      'driver_wallet_transactions',
      'zipto_shield_transactions',
      'zipto_shield_ledger',
      'driver_fraud_incidents',
      'customer_wallet_transactions',
      'coin_transactions',
      'withdrawal_requests',
      'payments',
      'bookings',
    ];

    const counts: Record<string, number> = {};
    for (const table of tables) {
      try {
        const result = await q(`DELETE FROM "${table}"`);
        counts[table] = result[1] ?? 0;
      } catch {
        counts[table] = -1; // table may not exist yet — skip
      }
    }

    // Reset driver profile counters
    await q(
      `UPDATE driver_profiles SET wallet_balance = 0, total_trips = 0, average_rating = NULL, wallet_frozen = false, wallet_freeze_reason = NULL`,
    );

    return {
      message: 'All trip, earnings, and wallet data has been cleared.',
      cleared: counts,
    };
  }
}
