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
      this.userRepository.count({ where: { role: UserRole.CUSTOMER } }),
      this.userRepository.count({ where: { role: UserRole.DRIVER } }),
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
      this.userRepository.count({ where: { role: UserRole.CUSTOMER, created_at: Between(thirtyDaysAgo, now) } }),
      this.userRepository.count({ where: { role: UserRole.DRIVER, created_at: Between(thirtyDaysAgo, now) } }),
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
      this.userRepository.count({ where: { role: UserRole.CUSTOMER, created_at: Between(sixtyDaysAgo, thirtyDaysAgo) } }),
      this.userRepository.count({ where: { role: UserRole.DRIVER, created_at: Between(sixtyDaysAgo, thirtyDaysAgo) } }),
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
    return this.driverProfileRepository.find({
      where: { verification_status: VerificationStatus.PENDING },
      relations: ['user'],
      order: { created_at: 'ASC' },
    });
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
  async rejectDriver(driverProfileId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { id: driverProfileId },
    });

    if (!profile) {
      throw new Error('Driver profile not found');
    }

    await this.driverProfileRepository.update(driverProfileId, {
      verification_status: VerificationStatus.REJECTED,
    });

    // Also mark the user as not verified
    await this.userRepository.update(profile.user_id, {
      is_verified: false,
    });

    // Notify driver
    await this.notificationService.notifyDriverRejected(profile.user_id);

    return { message: 'Driver rejected' };
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
      where: { role: UserRole.CUSTOMER },
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

    return {
      ...driver,
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
    await this.notificationService.push(
      profile.user_id,
      'general',
      'Account Suspended',
      reason || 'Your account has been suspended by admin.',
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

    return {
      driver_id: profile.id,
      user_id: profile.user_id,
      name: profile.user?.name,
      phone: profile.user?.phone,
      verification_status: profile.verification_status,
      license_number: profile.license_number,
      license_expiry: profile.license_expiry,
      documents: {
        aadhar_front: profile.aadhar_front_image,
        aadhar_back: profile.aadhar_back_image,
        driving_license: profile.driving_license_image,
        vehicle_rc: profile.vehicle_rc_image,
        profile_image: profile.profile_image,
      },
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
        `Payout already in progress (payout_id: ${withdrawal.payout_id}). Status will update automatically via webhook when IMPS settles.`,
      );
    }

    const driverUserId = withdrawal.driver_profile?.user_id;
    const amount       = Number(withdrawal.amount);
    const bankAccount  = withdrawal.bank_account;

    // ── Attempt automated payout via RazorpayX ────────────────────────────
    if (this.razorpayXService.isConfigured && bankAccount?.razorpay_fund_account_id) {
      try {
        const payout = await this.razorpayXService.createPayout({
          fundAccountId: bankAccount.razorpay_fund_account_id,
          amountPaise:   Math.round(amount * 100),
          referenceId:   `WD_${withdrawalId.slice(-32)}`,
          narration:     `Zipto Payout`,
          mode:          'IMPS',
        });

        // Mark as PROCESSING — final status comes via webhook
        withdrawal.status     = WithdrawalStatus.PROCESSING;
        withdrawal.payout_id  = payout.id;
        if (remarks) withdrawal.remarks = remarks;
        const saved = await this.withdrawalRepository.save(withdrawal);

        this.logger.log(`[RazorpayX] Payout queued: withdrawal=${withdrawalId}, payout=${payout.id}`);

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
        // RazorpayX call failed — fall through to manual-approve path
        this.logger.error(
          `[RazorpayX] Automated payout failed for withdrawal=${withdrawalId}: ${err?.error?.description ?? err?.message}. Falling back to manual.`,
        );
      }
    } else if (this.razorpayXService.isConfigured && !bankAccount?.razorpay_fund_account_id) {
      // Bank account not yet synced — try syncing now and proceed manually
      this.logger.warn(
        `[RazorpayX] Bank account ${bankAccount?.id ?? 'unknown'} has no fund_account_id — payout will be manual.`,
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
   * Handle Razorpay payout webhook events.
   * Called from the webhook endpoint after signature verification.
   */
  async handlePayoutWebhook(rawBody: Buffer, signature: string): Promise<void> {
    if (!this.razorpayXService.validateWebhookSignature(rawBody, signature)) {
      this.logger.warn('[RazorpayX] Webhook signature invalid — ignored');
      return;
    }

    let event: any;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch {
      this.logger.warn('[RazorpayX] Webhook: invalid JSON');
      return;
    }

    const payoutId: string = event?.payload?.payout?.entity?.id;
    if (!payoutId) return;

    this.logger.log(`[RazorpayX] Webhook event=${event.event}, payout=${payoutId}`);

    const withdrawal = await this.withdrawalRepository.findOne({
      where: { payout_id: payoutId },
      relations: ['driver_profile'],
    });
    if (!withdrawal) {
      this.logger.warn(`[RazorpayX] No withdrawal found for payout_id=${payoutId}`);
      return;
    }

    const driverUserId = withdrawal.driver_profile?.user_id;
    const amount       = Number(withdrawal.amount);

    if (event.event === 'payout.processed') {
      // ── Success: finalize ──────────────────────────────────────────────
      if (withdrawal.status === WithdrawalStatus.COMPLETED) return; // idempotent
      const utr: string = event?.payload?.payout?.entity?.utr ?? '';
      withdrawal.status          = WithdrawalStatus.COMPLETED;
      withdrawal.payout_reference = utr || withdrawal.payout_reference;
      await this.withdrawalRepository.save(withdrawal);
      this.logger.log(`[RazorpayX] Payout processed: withdrawal=${withdrawal.id}, UTR=${utr}`);

      if (driverUserId) {
        this.notificationService.sendPushNotification({
          user_id: driverUserId,
          title: '✅ Payout Successful',
          body: `₹${amount.toLocaleString('en-IN')} has been credited to your bank account.${utr ? ` UTR: ${utr}` : ''}`,
          data: { type: 'payout_processed', amount: String(amount), withdrawal_id: withdrawal.id },
        }).catch(() => {});
      }

    } else if (event.event === 'payout.failed' || event.event === 'payout.reversed') {
      // ── Failure: refund wallet ─────────────────────────────────────────
      if (withdrawal.status === WithdrawalStatus.REJECTED) return; // idempotent
      const failureReason: string =
        event?.payload?.payout?.entity?.failure_reason ??
        event?.payload?.payout?.entity?.status_details?.description ??
        event.event;

      withdrawal.status         = WithdrawalStatus.REJECTED;
      withdrawal.failure_reason = failureReason;
      await this.withdrawalRepository.save(withdrawal);

      // Refund driver wallet
      if (driverUserId) {
        await this.driverWalletService.withdrawalRefund(driverUserId, amount, withdrawal.id);
        this.logger.log(`[RazorpayX] Payout ${event.event}: wallet refunded ₹${amount} for driver=${driverUserId}`);
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
  async resetDriverData(driverProfileId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { id: driverProfileId },
      relations: ['user'],
    });
    if (!profile) throw new NotFoundException('Driver profile not found');

    const userId = profile.user_id;
    const q = this.dataSource.query.bind(this.dataSource);

    // 1. Wallet transactions
    const [, walletDeleted] = await q(
      `DELETE FROM driver_wallet_transactions WHERE driver_user_id = $1`, [userId],
    );
    // 2. Topup requests
    const [, topupDeleted] = await q(
      `DELETE FROM driver_topup_requests WHERE driver_user_id = $1`, [userId],
    );
    // 3. Withdrawal requests
    const [, withdrawalDeleted] = await q(
      `DELETE FROM driver_withdrawal_requests WHERE driver_profile_id = $1`, [driverProfileId],
    );
    // 4. Payments tied to bookings driven by this driver
    const [, paymentDeleted] = await q(
      `DELETE FROM payments WHERE booking_id IN (
         SELECT id FROM bookings WHERE driver_id = $1
       )`, [driverProfileId],
    );
    // 5. Ratings given for this driver
    const [, ratingDeleted] = await q(
      `DELETE FROM ratings WHERE driver_id = $1`, [driverProfileId],
    );
    // 6. Bookings assigned to this driver
    const [, bookingDeleted] = await q(
      `DELETE FROM bookings WHERE driver_id = $1`, [driverProfileId],
    );
    // 7. Reset counters on driver profile
    await q(
      `UPDATE driver_profiles
       SET wallet_balance = 0, total_trips = 0, average_rating = NULL,
           wallet_frozen = false, wallet_freeze_reason = NULL
       WHERE id = $1`, [driverProfileId],
    );

    this.logger.log(
      `[Admin] Driver data reset: driver=${driverProfileId} (${profile.user?.name ?? userId})`,
    );

    return {
      message: `All earnings, wallet, and ride data cleared for driver ${profile.user?.name ?? userId}.`,
      cleared: {
        wallet_transactions: walletDeleted ?? 0,
        topup_requests:      topupDeleted  ?? 0,
        withdrawals:         withdrawalDeleted ?? 0,
        payments:            paymentDeleted ?? 0,
        ratings:             ratingDeleted  ?? 0,
        bookings:            bookingDeleted ?? 0,
      },
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
