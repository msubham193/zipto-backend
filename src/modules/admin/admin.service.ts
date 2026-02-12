import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import { Payment, PaymentStatus } from '../payment/entities/payment.entity';
import { DriverProfile, VerificationStatus } from '../driver/entities/driver-profile.entity';
import { Vehicle } from '../vehicle/entities/vehicle.entity';

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
    await this.driverProfileRepository.update(driverProfileId, {
      verification_status: VerificationStatus.APPROVED,
    });

    return { message: 'Driver approved successfully' };
  }

  /**
   * Reject driver verification
   */
  async rejectDriver(driverProfileId: string) {
    await this.driverProfileRepository.update(driverProfileId, {
      verification_status: VerificationStatus.REJECTED,
    });

    return { message: 'Driver rejected' };
  }

  /**
   * Get pending vehicle verifications
   */
  async getPendingVehicleVerifications() {
    return this.vehicleRepository.find({
      where: { verification_status: VerificationStatus.PENDING },
      relations: ['driver'],
      order: { created_at: 'ASC' },
    });
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
        .select("DATE(booking.created_at)", 'date')
        .addSelect('COUNT(*)', 'count')
        .where('booking.created_at >= :startDate', { startDate: last30Days })
        .groupBy('DATE(booking.created_at)')
        .orderBy('date', 'ASC')
        .getRawMany(),

      this.paymentRepository
        .createQueryBuilder('payment')
        .select("DATE(payment.created_at)", 'date')
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
      relations: ['user', 'vehicles'],
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
      relations: ['user', 'vehicles'],
    });

    if (!driver) {
      throw new Error('Driver not found');
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
}
