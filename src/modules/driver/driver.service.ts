import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DriverProfile,
  AvailabilityStatus,
  VerificationStatus,
} from './entities/driver-profile.entity';
import { BankAccount } from './entities/bank-account.entity';
import { WithdrawalRequest, WithdrawalStatus } from './entities/withdrawal-request.entity';
import { Vehicle, VehicleType } from '../vehicle/entities/vehicle.entity';
import { User } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import {
  UpdateDriverDto,
  UpdateAvailabilityDto,
  UpdateLocationDto,
  OnboardDriverDto,
} from './dto/driver.dto';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto/bank-account.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { S3Service } from '../../services/s3.service';
import { NotificationService } from '../notification/notification.service';
import { RedisService } from '../../services/redis.service';

/** GPS ping TTL: if a driver stops sending location for 20 min during an active delivery,
 *  the cron guard treats them as a ghost. */
const GPS_PING_TTL_MS = 20 * 60 * 1000;

@Injectable()
export class DriverService {
  constructor(
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(BankAccount)
    private bankAccountRepository: Repository<BankAccount>,
    @InjectRepository(WithdrawalRequest)
    private withdrawalRepository: Repository<WithdrawalRequest>,
    private readonly s3Service: S3Service,
    private readonly notificationService: NotificationService,
    private readonly cacheManager: RedisService,
  ) {}

  /**
   * Get driver profile (flattened — name/phone/email surfaced at top level)
   */
  async getProfile(userId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    // Count actual completed trips from bookings (source of truth)
    const totalTrips = await this.bookingRepository.count({
      where: { driver_id: userId, status: BookingStatus.COMPLETED },
    });

    // Count total feedback/ratings received
    const [{ count: ratingCount }] = await this.bookingRepository.manager.query(
      `SELECT COUNT(*)::int AS count FROM ratings WHERE driver_id = $1`,
      [userId],
    );

    // Surface user-level fields so frontend can read profile.name directly
    return {
      ...profile,
      name: profile.user?.name ?? null,
      phone: profile.user?.phone ?? null,
      email: profile.user?.email ?? null,
      total_trips: totalTrips,
      total_ratings: ratingCount as number,
    };
  }

  /**
   * Update driver profile
   */
  async updateProfile(userId: string, updateDriverDto: UpdateDriverDto) {
    const profile = await this.getProfile(userId);

    // Update user fields
    const { name, email } = updateDriverDto;
    if (name || email) {
      await this.userRepository.update(userId, {
        ...(name && { name, is_profile_complete: true }),
        ...(email && { email }),
      });
    }

    // Update profile fields
    const { license_number, license_expiry } = updateDriverDto;
    if (license_number !== undefined) {
      profile.license_number = license_number;
    }
    if (license_expiry !== undefined) {
      profile.license_expiry = new Date(license_expiry);
    }

    await this.driverProfileRepository.save(profile);

    // Return updated profile
    return this.getProfile(userId);
  }

  /**
   * Update driver availability status
   */
  async updateAvailability(userId: string, updateAvailabilityDto: UpdateAvailabilityDto) {
    const profile = await this.getProfile(userId);

    profile.availability_status = updateAvailabilityDto.availability_status;
    await this.driverProfileRepository.save(profile);

    return { availability_status: profile.availability_status };
  }

  /**
   * Update driver location using PostGIS Point
   */
  async updateLocation(userId: string, updateLocationDto: UpdateLocationDto) {
    const { latitude, longitude } = updateLocationDto;

    await this.driverProfileRepository
      .createQueryBuilder()
      .update(DriverProfile)
      .set({
        current_location: () => `ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)`,
      })
      .where('user_id = :userId', { userId })
      .execute();

    // Heartbeat for ghost-driver detection: key expires in 20 min
    // If the cron finds an ongoing booking without this key, the driver has gone dark.
    await this.cacheManager.set(`driver:last_ping:${userId}`, Date.now(), GPS_PING_TTL_MS);

    return { message: 'Location updated successfully' };
  }

  /**
   * Get driver earnings dashboard
   */
  async getEarnings(userId: string) {
    const profile = await this.getProfile(userId);

    return {
      wallet_balance: profile.wallet_balance,
      total_trips: profile.total_trips,
      average_rating: profile.average_rating,
    };
  }

  /**
   * Get driver daily stats
   */
  async getDailyStats(userId: string) {
    // Ensure the driver profile exists
    await this.getProfile(userId);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const bookings = await this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.driver_id = :userId', { userId })
      .andWhere('booking.status = :status', { status: BookingStatus.COMPLETED })
      .andWhere('booking.completion_time >= :startOfDay', { startOfDay })
      .andWhere('booking.completion_time <= :endOfDay', { endOfDay })
      .getMany();

    const todayEarnings = bookings.reduce(
      (sum, booking) => sum + Number(booking.driver_earnings || 0),
      0,
    );
    const todayOrders = bookings.length;

    return {
      today_earnings: todayEarnings,
      today_orders: todayOrders,
    };
  }

  /**
   * Get trip history with pagination
   */
  async getTripHistory(userId: string, page: number = 1, limit: number = 10, status?: string) {
    const where: any = { driver_id: userId };
    if (status) {
      where.status = status;
    }

    const [bookings, total] = await this.bookingRepository.findAndCount({
      where,
      relations: ['customer', 'payments'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const trips = bookings.map(b => ({
      id: b.id,
      status: b.status,
      pickup_location: b.pickup_address,
      dropoff_location: b.drop_address,
      amount: b.final_fare || b.estimated_fare,
      distance: b.distance,
      vehicle_type: b.vehicle_type,
      service_category: b.service_category,
      created_at: b.created_at,
      completion_time: b.completion_time,
      customer_name: b.customer?.name || null,
      customer_phone: b.customer?.phone || null,
      payment_status: b.payments?.some(p => p.payment_status === 'completed')
        ? 'paid'
        : b.status === BookingStatus.COMPLETED ? 'paid' : 'unpaid',
      payment_method: b.payments?.find(p => p.payment_status === 'completed')?.payment_method
        || (b.status === BookingStatus.COMPLETED ? 'cash' : null),
      driver_earnings: b.driver_earnings,
      cancellation_reason: b.cancellation_reason,
    }));

    return {
      trips,
      ...getPaginationMeta(total, page, limit),
    };
  }

  /**
   * Create initial driver profile (called during driver registration)
   */
  async createProfile(userId: string, licenseNumber: string, licenseExpiry: Date) {
    const existingProfile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
    });

    if (existingProfile) {
      return existingProfile;
    }

    const profile = this.driverProfileRepository.create({
      user_id: userId,
      license_number: licenseNumber,
      license_expiry: licenseExpiry,
      availability_status: AvailabilityStatus.OFFLINE,
    });

    const saved = await this.driverProfileRepository.save(profile);

    // Notify admin about new driver registration
    await this.notificationService.pushAdmin(
      'driver_registered',
      'New Driver Registered',
      `A new driver has registered and created their profile. Awaiting KYC submission.`,
      { driverUserId: userId },
    );

    return saved;
  }

  /**
   * Onboard driver with documents
   */
  async onboardDriver(
    userId: string,
    onboardDriverDto: OnboardDriverDto,
    files: {
      aadhar_front?: Express.Multer.File[];
      aadhar_back?: Express.Multer.File[];
      driving_license?: Express.Multer.File[];
      vehicle_rc?: Express.Multer.File[];
      profile_photo?: Express.Multer.File[];
    },
  ) {
    let profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      profile = this.driverProfileRepository.create({
        user_id: userId,
        availability_status: AvailabilityStatus.OFFLINE,
      });
    }

    // Update User details
    const { name, email } = onboardDriverDto;
    if (name || email) {
      try {
        await this.userRepository.update(userId, {
          ...(name && { name }),
          ...(email && { email }),
        });
      } catch (err: any) {
        // Handle duplicate email constraint
        if (err?.code === '23505' || err?.message?.includes('duplicate key')) {
          // Still update name if email is taken
          if (name) {
            await this.userRepository.update(userId, { name });
          }
          // Don't throw — proceed with onboarding, email just won't be updated
        } else {
          throw err;
        }
      }
    }

    // Update Driver Profile details
    const { address, license_number, license_expiry } = onboardDriverDto;

    if (address) profile.address = address;
    if (license_number) profile.license_number = license_number;
    if (license_expiry) profile.license_expiry = new Date(license_expiry);

    // Handle File Uploads to S3
    const folder = 'driver-documents';

    if (files.aadhar_front?.[0]) {
      profile.aadhar_front_image = await this.s3Service.uploadFile(
        files.aadhar_front[0].buffer,
        files.aadhar_front[0].originalname,
        files.aadhar_front[0].mimetype,
        folder,
      );
    }
    if (files.aadhar_back?.[0]) {
      profile.aadhar_back_image = await this.s3Service.uploadFile(
        files.aadhar_back[0].buffer,
        files.aadhar_back[0].originalname,
        files.aadhar_back[0].mimetype,
        folder,
      );
    }
    if (files.driving_license?.[0]) {
      profile.driving_license_image = await this.s3Service.uploadFile(
        files.driving_license[0].buffer,
        files.driving_license[0].originalname,
        files.driving_license[0].mimetype,
        folder,
      );
    }
    if (files.vehicle_rc?.[0]) {
      profile.vehicle_rc_image = await this.s3Service.uploadFile(
        files.vehicle_rc[0].buffer,
        files.vehicle_rc[0].originalname,
        files.vehicle_rc[0].mimetype,
        folder,
      );
    }
    if (files.profile_photo?.[0]) {
      profile.profile_image = await this.s3Service.uploadFile(
        files.profile_photo[0].buffer,
        files.profile_photo[0].originalname,
        files.profile_photo[0].mimetype,
        folder,
      );
    }

    await this.driverProfileRepository.save(profile);

    // Handle Vehicle Details
    const { vehicle_registration_number, vehicle_type, vehicle_model, vehicle_capacity } =
      onboardDriverDto;

    if (vehicle_registration_number) {
      let vehicle = await this.vehicleRepository.findOne({
        where: { driver_id: profile.id },
      });

      if (!vehicle) {
        vehicle = this.vehicleRepository.create({
          driver_id: profile.id,
          registration_number: vehicle_registration_number,
        });
      }

      vehicle.registration_number = vehicle_registration_number;
      if (vehicle_type) vehicle.vehicle_type = vehicle_type as VehicleType;
      if (vehicle_model) vehicle.vehicle_model = vehicle_model;
      if (vehicle_capacity) vehicle.capacity = vehicle_capacity;

      if (files.vehicle_rc?.[0]) {
        vehicle.rc_document_url = await this.s3Service.uploadFile(
          files.vehicle_rc[0].buffer,
          files.vehicle_rc[0].originalname,
          files.vehicle_rc[0].mimetype,
          folder,
        );
      }

      const savedVehicle = await this.vehicleRepository.save(vehicle);

      // Update the driver profile with the vehicle ID if not already set
      if (profile.vehicle_id !== savedVehicle.id) {
        profile.vehicle_id = savedVehicle.id;
        await this.driverProfileRepository.save(profile);
      }
    }

    // Notify admin about KYC submission
    const driverName = onboardDriverDto.name ?? `Driver #${userId.slice(-6).toUpperCase()}`;
    await this.notificationService.pushAdmin(
      'kyc_submitted',
      'KYC Documents Submitted',
      `${driverName} has submitted KYC documents and is awaiting verification.`,
      { driverUserId: userId },
    );

    return { message: 'Driver onboarded successfully', profile };
  }

  /**
   * Get driver attendance calendar with per-day earnings & hours
   */
  async getCalendar(
    userId: string,
    period: 'month' | 'week',
    year: number,
    month: number,
    weekStart?: string,
  ) {
    // Resolve date range
    let from: Date;
    let to: Date;

    if (period === 'week') {
      if (weekStart) {
        from = new Date(weekStart);
        from.setHours(0, 0, 0, 0);
      } else {
        // Default to the Monday of the current week
        const today = new Date();
        const dow = today.getDay(); // 0=Sun
        const diff = dow === 0 ? -6 : 1 - dow; // shift to Monday
        from = new Date(today);
        from.setDate(today.getDate() + diff);
        from.setHours(0, 0, 0, 0);
      }
      to = new Date(from);
      to.setDate(from.getDate() + 6);
      to.setHours(23, 59, 59, 999);
    } else {
      from = new Date(year, month - 1, 1, 0, 0, 0, 0);
      to = new Date(year, month, 0, 23, 59, 59, 999); // last day of month
    }

    // Query all active bookings (non-cancelled) grouped by the day the driver
    // accepted them. This covers: accepted, ongoing, and completed trips.
    // For completed trips we also capture earnings + hours; for others we just
    // know the driver was working that day.
    const ACTIVE_STATUSES = [
      BookingStatus.ACCEPTED,
      BookingStatus.DRIVER_ASSIGNED,
      BookingStatus.ONGOING,
      BookingStatus.COMPLETED,
    ];

    const rows: Array<{
      work_date: string | Date;
      trips: string;
      earnings: string;
      first_trip: Date | null;
      last_trip: Date | null;
      hours_worked: string;
    }> = await this.bookingRepository
      .createQueryBuilder('b')
      // Use acceptance_time as the "work day" anchor so online-but-no-completion
      // days are still captured. Fall back to created_at for edge cases.
      .select("DATE(COALESCE(b.acceptance_time, b.created_at))", 'work_date')
      .addSelect(
        `COUNT(CASE WHEN b.status = '${BookingStatus.COMPLETED}' THEN 1 END)`,
        'trips',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN b.status = '${BookingStatus.COMPLETED}' THEN b.driver_earnings ELSE 0 END), 0)`,
        'earnings',
      )
      .addSelect('MIN(b.acceptance_time)', 'first_trip')
      .addSelect(
        `MAX(COALESCE(b.completion_time, b.acceptance_time))`,
        'last_trip',
      )
      .addSelect(
        `EXTRACT(EPOCH FROM (MAX(COALESCE(b.completion_time, b.acceptance_time)) - MIN(b.acceptance_time))) / 3600`,
        'hours_worked',
      )
      .where('b.driver_id = :userId', { userId })
      .andWhere('b.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .andWhere('COALESCE(b.acceptance_time, b.created_at) >= :from', { from })
      .andWhere('COALESCE(b.acceptance_time, b.created_at) <= :to', { to })
      .groupBy("DATE(COALESCE(b.acceptance_time, b.created_at))")
      .orderBy("DATE(COALESCE(b.acceptance_time, b.created_at))", 'ASC')
      .getRawMany();

    // Build a lookup map: ISO date string → row
    const dayMap = new Map<string, typeof rows[0]>();
    for (const row of rows) {
      const key =
        row.work_date instanceof Date
          ? row.work_date.toISOString().split('T')[0]
          : String(row.work_date).split('T')[0];
      dayMap.set(key, row);
    }

    // For today: if the driver is currently online and not already in the map,
    // inject a "present with 0 trips" entry so going online alone counts.
    const todayStr = new Date().toISOString().split('T')[0];
    if (!dayMap.has(todayStr)) {
      const profile = await this.driverProfileRepository.findOne({
        where: { user_id: userId },
        select: ['id', 'availability_status'],
      });
      if (profile?.availability_status === AvailabilityStatus.ONLINE) {
        dayMap.set(todayStr, {
          work_date: todayStr,
          trips: '0',
          earnings: '0',
          first_trip: null,
          last_trip: null,
          hours_worked: '0',
        });
      }
    }

    // Generate one entry per calendar day in the range
    const days: Array<{
      date: string;
      day_of_week: string;
      is_present: boolean;
      earnings: number;
      trips: number;
      hours_worked: number;
      first_trip_at: string | null;
      last_trip_at: string | null;
    }> = [];

    const cursor = new Date(from);
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    while (cursor <= to) {
      const dateStr = cursor.toISOString().split('T')[0];
      const row = dayMap.get(dateStr);

      const hours = row
        ? Math.max(0, parseFloat(row.hours_worked) || 0)
        : 0;

      const fmt = (d: Date | null) => {
        if (!d) return null;
        const dt = new Date(d);
        return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      };

      days.push({
        date: dateStr,
        day_of_week: DAY_NAMES[cursor.getDay()],
        is_present: !!row,
        earnings: row ? parseFloat(row.earnings) : 0,
        trips: row ? parseInt(row.trips, 10) : 0,
        hours_worked: parseFloat(hours.toFixed(1)),
        first_trip_at: row ? fmt(row.first_trip) : null,
        last_trip_at: row ? fmt(row.last_trip) : null,
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    const presentDays = days.filter(d => d.is_present);
    const summary = {
      days_present: presentDays.length,
      total_days: days.length,
      total_earnings: parseFloat(
        presentDays.reduce((s, d) => s + d.earnings, 0).toFixed(2),
      ),
      total_trips: presentDays.reduce((s, d) => s + d.trips, 0),
      total_hours: parseFloat(
        presentDays.reduce((s, d) => s + d.hours_worked, 0).toFixed(1),
      ),
    };

    return {
      period,
      year: from.getFullYear(),
      month: from.getMonth() + 1,
      week_start: period === 'week' ? from.toISOString().split('T')[0] : null,
      week_end: period === 'week' ? to.toISOString().split('T')[0] : null,
      summary,
      days,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bank Account CRUD
  // ─────────────────────────────────────────────────────────────────────────

  private async getDriverProfileId(userId: string): Promise<string> {
    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
      select: ['id'],
    });
    if (!profile) throw new NotFoundException('Driver profile not found');
    return profile.id;
  }

  async getBankAccounts(userId: string): Promise<BankAccount[]> {
    const driverProfileId = await this.getDriverProfileId(userId);
    return this.bankAccountRepository.find({
      where: { driver_profile_id: driverProfileId },
      order: { is_primary: 'DESC', created_at: 'ASC' },
    });
  }

  async addBankAccount(userId: string, dto: CreateBankAccountDto): Promise<BankAccount> {
    const driverProfileId = await this.getDriverProfileId(userId);

    const existingCount = await this.bankAccountRepository.count({
      where: { driver_profile_id: driverProfileId },
    });

    const account = this.bankAccountRepository.create({
      ...dto,
      ifsc_code: dto.ifsc_code.toUpperCase(),
      driver_profile_id: driverProfileId,
      is_primary: existingCount === 0, // first account is auto-primary
    });

    return this.bankAccountRepository.save(account);
  }

  async updateBankAccount(
    userId: string,
    bankAccountId: string,
    dto: UpdateBankAccountDto,
  ): Promise<BankAccount> {
    const driverProfileId = await this.getDriverProfileId(userId);
    const account = await this.bankAccountRepository.findOne({
      where: { id: bankAccountId, driver_profile_id: driverProfileId },
    });
    if (!account) throw new NotFoundException('Bank account not found');

    Object.assign(account, {
      ...dto,
      ...(dto.ifsc_code && { ifsc_code: dto.ifsc_code.toUpperCase() }),
    });
    return this.bankAccountRepository.save(account);
  }

  async deleteBankAccount(userId: string, bankAccountId: string): Promise<void> {
    const driverProfileId = await this.getDriverProfileId(userId);
    const account = await this.bankAccountRepository.findOne({
      where: { id: bankAccountId, driver_profile_id: driverProfileId },
    });
    if (!account) throw new NotFoundException('Bank account not found');

    await this.bankAccountRepository.remove(account);

    // If the deleted account was primary, auto-promote the oldest remaining one
    if (account.is_primary) {
      const next = await this.bankAccountRepository.findOne({
        where: { driver_profile_id: driverProfileId },
        order: { created_at: 'ASC' },
      });
      if (next) {
        next.is_primary = true;
        await this.bankAccountRepository.save(next);
      }
    }
  }

  async setPrimaryBankAccount(userId: string, bankAccountId: string): Promise<BankAccount> {
    const driverProfileId = await this.getDriverProfileId(userId);
    const account = await this.bankAccountRepository.findOne({
      where: { id: bankAccountId, driver_profile_id: driverProfileId },
    });
    if (!account) throw new NotFoundException('Bank account not found');

    // Unset all primaries for this driver, then set the selected one
    await this.bankAccountRepository.update(
      { driver_profile_id: driverProfileId },
      { is_primary: false },
    );
    account.is_primary = true;
    return this.bankAccountRepository.save(account);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Earnings
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Earnings dashboard for a given period (today | week | month).
   * Returns totals + a simple fare breakdown + current wallet balance.
   */
  async getEarningsDashboard(userId: string, period: 'today' | 'week' | 'month' | 'all') {
    const now = new Date();
    let from: Date;
    let to: Date = new Date(now);
    to.setHours(23, 59, 59, 999);

    if (period === 'today') {
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      const dow = now.getDay(); // 0=Sun
      const diff = dow === 0 ? -6 : 1 - dow; // shift to Monday
      from = new Date(now);
      from.setDate(now.getDate() + diff);
      from.setHours(0, 0, 0, 0);
    } else if (period === 'all') {
      from = new Date(0); // epoch — all time
      to = new Date(8640000000000000); // max date
    } else {
      from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    }

    const bookings = await this.bookingRepository.find({
      where: {
        driver_id: userId,
        status: BookingStatus.COMPLETED,
      },
      select: ['id', 'driver_earnings', 'skido_commission', 'final_fare', 'fare_breakdown', 'completion_time'],
    });

    // Filter to the period in JS (simpler than parameterised date query for nullable completion_time)
    const inPeriod = bookings.filter(b => {
      const t = b.completion_time ? new Date(b.completion_time) : null;
      return t && t >= from && t <= to;
    });

    let totalEarnings = 0;
    let totalGrossFare = 0;
    let totalPlatformFee = 0;
    let totalBaseFare = 0;
    let totalDistanceCharge = 0;
    let totalOtherCharges = 0;

    for (const b of inPeriod) {
      const driverEarnings = Number(b.driver_earnings || 0);
      const commission = Number(b.skido_commission || 0);
      const gross = Number(b.final_fare || 0);
      const fb = b.fare_breakdown as any;

      totalEarnings += driverEarnings;
      totalGrossFare += gross;
      totalPlatformFee += commission;
      totalBaseFare += Number(fb?.base_fare || 0);
      totalDistanceCharge += Number(fb?.distance_charge || 0);
    }

    // "Other charges" = anything beyond base + distance that the driver still got
    totalOtherCharges = Math.max(0, totalEarnings - totalBaseFare - totalDistanceCharge);

    // Current wallet balance (accumulated, not period-specific)
    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
      select: ['id', 'wallet_balance'],
    });

    const minWithdrawal = profile ? await this.getMinWithdrawal(profile.id) : 1000;

    return {
      period,
      wallet_balance: Number(profile?.wallet_balance || 0),
      min_withdrawal_amount: minWithdrawal,
      total_earnings: parseFloat(totalEarnings.toFixed(2)),
      trip_count: inPeriod.length,
      breakdown: {
        base_fare: parseFloat(totalBaseFare.toFixed(2)),
        distance_charge: parseFloat(totalDistanceCharge.toFixed(2)),
        other_charges: parseFloat(totalOtherCharges.toFixed(2)),
        platform_fee: parseFloat(totalPlatformFee.toFixed(2)),
        gross_fare: parseFloat(totalGrossFare.toFixed(2)),
      },
    };
  }

  /** Returns the minimum withdrawal amount for a driver based on their vehicle type. */
  private async getMinWithdrawal(driverProfileId: string): Promise<number> {
    const vehicle = await this.vehicleRepository.findOne({
      where: { driver_id: driverProfileId },
    });
    const type = (vehicle?.vehicle_type ?? '').toLowerCase();
    return type === VehicleType.BIKE || type === VehicleType.SCOOTY ? 500 : 1000;
  }

  /**
   * Request a withdrawal from wallet balance.
   * Minimum: ₹500 for two-wheelers (bike/scooty), ₹1000 for all other vehicles.
   */
  async requestWithdrawal(
    userId: string,
    amount: number,
    bankAccountId?: string,
  ) {
    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
      select: ['id', 'wallet_balance', 'wallet_frozen', 'wallet_freeze_reason'],
    });
    if (!profile) throw new NotFoundException('Driver profile not found');

    if (profile.wallet_frozen) {
      throw new BadRequestException(
        `Your wallet is temporarily frozen pending an account review. Reason: ${profile.wallet_freeze_reason || 'policy violation'}. Please contact support.`,
      );
    }

    // Minimum withdrawal depends on vehicle type
    const minWithdrawal = await this.getMinWithdrawal(profile.id);
    if (!amount || amount < minWithdrawal) {
      throw new BadRequestException(
        `Minimum withdrawal amount for your vehicle type is ₹${minWithdrawal}`,
      );
    }

    const balance = Number(profile.wallet_balance || 0);
    if (amount > balance) {
      throw new BadRequestException(
        `Insufficient balance. Available: ₹${balance.toFixed(2)}`,
      );
    }

    // Validate bank account belongs to this driver (optional but safe)
    if (bankAccountId) {
      const account = await this.bankAccountRepository.findOne({
        where: { id: bankAccountId, driver_profile_id: profile.id },
      });
      if (!account) throw new NotFoundException('Bank account not found');
    } else {
      // Auto-pick primary bank account
      const primary = await this.bankAccountRepository.findOne({
        where: { driver_profile_id: profile.id, is_primary: true },
      });
      bankAccountId = primary?.id ?? undefined;
    }

    // Deduct balance
    await this.driverProfileRepository.update(profile.id, {
      wallet_balance: balance - amount,
    });

    // Record withdrawal request
    const request = this.withdrawalRepository.create({
      driver_profile_id: profile.id,
      amount,
      ...(bankAccountId && { bank_account_id: bankAccountId }),
      status: WithdrawalStatus.PENDING,
    });
    const saved = await this.withdrawalRepository.save(request) as WithdrawalRequest;

    return {
      success: true,
      message: 'Withdrawal request submitted successfully',
      withdrawal_id: saved.id,
      amount: saved.amount,
      remaining_balance: parseFloat((balance - amount).toFixed(2)),
    };
  }

  /**
   * Get withdrawal history for the driver
   */
  async getWithdrawalHistory(userId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
      select: ['id'],
    });
    if (!profile) throw new NotFoundException('Driver profile not found');

    return this.withdrawalRepository.find({
      where: { driver_profile_id: profile.id },
      relations: ['bank_account'],
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Get driver verification status
   */
  async getVerificationStatus(userId: string) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
    });

    return {
      is_verified: user.is_verified,
      verification_status: profile?.verification_status || VerificationStatus.PENDING,
      message:
        profile?.verification_status === VerificationStatus.APPROVED
          ? 'Your profile has been verified by the admin.'
          : profile?.verification_status === VerificationStatus.REJECTED
            ? 'Your profile has been rejected. Please contact support.'
            : 'Your profile is pending admin verification.',
    };
  }
}
