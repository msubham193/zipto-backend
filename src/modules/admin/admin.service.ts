import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { User, UserRole } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { Payment, PaymentStatus } from '../payment/entities/payment.entity';
import { DriverProfile, VerificationStatus } from '../driver/entities/driver-profile.entity';
import { Vehicle } from '../vehicle/entities/vehicle.entity';

import { PricingRule } from '../booking/entities/pricing-rule.entity';
import {
  DEFAULT_PRICING_CITY,
  getDefaultPricingRules,
  LEGACY_VEHICLE_TYPES,
} from '../booking/constants/default-pricing-rules';

@Injectable()
export class AdminService {
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
  ) {}

  /**
   * Get dashboard statistics
   */
  async getDashboardStats() {
    const [
      totalUsers,
      totalCustomers,
      totalDrivers,
      totalBookings,
      completedBookings,
      ongoingBookings,
      totalRevenue,
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
    ]);

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
   * Get all vehicles with pagination
   */
  async getAllVehicles(query: { page?: number; limit?: number }) {
    const { page = 1, limit = 20 } = query;

    const [vehicles, total] = await this.vehicleRepository.findAndCount({
      relations: ['driver', 'driver.user'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

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
    const { status, page = 1, limit = 20 } = query;

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
    const { page = 1, limit = 20 } = query;

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
    const { page = 1, limit = 20 } = query;

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
      relations: ['user'],
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

    // Get driver's booking statistics
    const [totalBookings, completedBookings, totalEarnings] = await Promise.all([
      this.bookingRepository.count({ where: { driver: { id: driverId } } }),
      this.bookingRepository.count({
        where: { driver: { id: driverId }, status: BookingStatus.COMPLETED },
      }),
      this.paymentRepository
        .createQueryBuilder('payment')
        .leftJoin('payment.booking', 'booking')
        .where('booking.driver_id = :driverId', { driverId })
        .andWhere('payment.payment_status = :status', { status: PaymentStatus.COMPLETED })
        .select('SUM(payment.driver_earnings)', 'total')
        .getRawOne(),
    ]);

    return {
      ...driver,
      statistics: {
        total_bookings: totalBookings,
        completed_bookings: completedBookings,
        total_earnings: parseFloat(totalEarnings?.total || '0'),
      },
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

    switch (query.period) {
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
      success: true,
      data: {
        chartData: bookingsByDay,
        summary: {
          totalBookings,
          completed,
          cancelled,
          completionRate:
            totalBookings > 0 ? parseFloat(((completed / totalBookings) * 100).toFixed(1)) : 0,
          avgPerDay: Math.round(totalBookings / diffDays),
        },
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
      .getRawOne();

    const totalRevenue = parseFloat(summaryResult?.totalRevenue || '0');
    // Assuming 20% platform fee if not explicitly tracked
    const platformFee = totalRevenue * 0.2;
    const driverPayouts = totalRevenue * 0.8;

    const totalPayments = await queryBuilder.clone().getCount();

    return {
      success: true,
      data: {
        chartData: revenueByDay,
        summary: {
          totalRevenue,
          platformFee,
          driverPayouts,
          avgOrderValue: totalPayments > 0 ? Math.round(totalRevenue / totalPayments) : 0,
        },
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
      success: true,
      data: {
        topDrivers: formattedDrivers,
      },
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
      success: true,
      data: {
        acquisition: {
          newCustomers,
          returningCustomers,
          retentionRate,
          churnRate,
        },
        satisfaction: {
          averageRating: parseFloat(averageRating),
          fiveStarReviews: 0, // Placeholder as we lack reviews table
          supportTickets: 0, // Placeholder
          resolutionRate: 0, // Placeholder
        },
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
        data = bookingReport.data.chartData;
        headers = ['Date', 'Bookings'];
        break;
      case 'revenue':
        const revenueReport = await this.getRevenueReports(query);
        data = revenueReport.data.chartData;
        headers = ['Date', 'Revenue'];
        break;
      case 'drivers':
        const driverReport = await this.getDriverReports(query);
        data = driverReport.data.topDrivers;
        headers = ['ID', 'Name', 'Trips', 'Earnings', 'Rating'];
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
}
