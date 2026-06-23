import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Razorpay = require('razorpay');
import {
  DriverProfile,
  AvailabilityStatus,
  VerificationStatus,
} from './entities/driver-profile.entity';
import { BankAccount } from './entities/bank-account.entity';
import { WithdrawalRequest, WithdrawalStatus } from './entities/withdrawal-request.entity';
import { DriverTopupRequest, TopupRequestStatus } from './entities/driver-topup-request.entity';
import { DriverWalletTransaction } from './entities/driver-wallet-transaction.entity';
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
import { DriverWalletService } from './driver-wallet.service';
import { RazorpayXService } from '../../services/razorpayx.service';
import { CashfreeService } from '../../services/cashfree.service';
import { CashfreePayoutService } from '../../services/cashfree-payout.service';

/** GPS ping TTL: if a driver stops sending location for 20 min during an active delivery,
 *  the cron guard treats them as a ghost. */
const GPS_PING_TTL_MS = 20 * 60 * 1000;

@Injectable()
export class DriverService {
  private readonly logger = new Logger(DriverService.name);

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
    @InjectRepository(DriverTopupRequest)
    private topupRequestRepository: Repository<DriverTopupRequest>,
    @InjectRepository(DriverWalletTransaction)
    private walletTxnRepository: Repository<DriverWalletTransaction>,
    private readonly s3Service: S3Service,
    private readonly notificationService: NotificationService,
    private readonly cacheManager: RedisService,
    private readonly driverWalletService: DriverWalletService,
    private readonly configService: ConfigService,
    private readonly razorpayXService: RazorpayXService,
    private readonly cashfreeService: CashfreeService,
    private readonly cashfreePayoutService: CashfreePayoutService,
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

    // Documents/photos are private R2 keys → presign so the app can render them.
    const signedDocs = await this.s3Service.signFields({
      profile_image: profile.profile_image,
      aadhar_front_image: profile.aadhar_front_image,
      aadhar_back_image: profile.aadhar_back_image,
      driving_license_image: profile.driving_license_image,
      vehicle_rc_image: profile.vehicle_rc_image,
    });

    // Surface user-level fields so frontend can read profile.name directly
    return {
      ...profile,
      ...signedDocs,
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
    // Load the raw entity (NOT getProfile, whose doc fields hold presigned URLs —
    // saving those would overwrite the stored R2 object keys).
    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
    });
    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

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

    // Return updated profile (with presigned document URLs)
    return this.getProfile(userId);
  }

  /**
   * Update driver availability status
   */
  async updateAvailability(userId: string, updateAvailabilityDto: UpdateAvailabilityDto) {
    // Targeted update — avoid round-tripping getProfile()'s presigned doc URLs
    // back into the stored R2 keys.
    const result = await this.driverProfileRepository.update(
      { user_id: userId },
      { availability_status: updateAvailabilityDto.availability_status },
    );
    if (!result.affected) {
      throw new NotFoundException('Driver profile not found');
    }
    return { availability_status: updateAvailabilityDto.availability_status };
  }

  /**
   * Update driver location using PostGIS Point
   */
  async updateLocation(userId: string, updateLocationDto: UpdateLocationDto) {
    const { latitude, longitude } = updateLocationDto;

    // Parameterized — never interpolate coordinates into SQL even though the DTO
    // validates them as lat/lng.
    await this.driverProfileRepository.manager.query(
      `UPDATE driver_profiles
         SET current_location = ST_SetSRID(ST_MakePoint($1, $2), 4326),
             last_location_at = NOW()
       WHERE user_id = $3`,
      [longitude, latitude, userId],
    );

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
      // Round to 2 decimals — summing floats like 45.40 + 39.80 produces binary
      // artifacts (e.g. 173.60000000000002) that must never reach the client.
      today_earnings: Math.round(todayEarnings * 100) / 100,
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
      is_primary: existingCount === 0,
      cashfree_sync_status: 'pending',
    });
    const saved = await this.bankAccountRepository.save(account);

    // Fire-and-forget Cashfree beneficiary sync so the API response is instant
    this.syncBankAccountToCashfree(userId, saved).catch(err =>
      this.logger.warn(`[CashfreePayout] Sync failed for bank_account=${saved.id}: ${err?.message}`)
    );

    return saved;
  }

  /**
   * Register the driver's bank account as a Cashfree Payouts beneficiary so we
   * can push automated withdrawals to it. Idempotent — Cashfree treats an
   * existing beneficiary_id as success. Stores the beneficiary id on the row.
   */
  private async syncBankAccountToCashfree(userId: string, bankAccount: BankAccount): Promise<void> {
    if (!this.cashfreePayoutService.isConfigured) return;

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) return;

    // One beneficiary per bank account (account number can differ per row).
    const beneficiaryId = this.cashfreePayoutService.generateBeneficiaryId(bankAccount.id);

    try {
      const beneId = await this.cashfreePayoutService.createBeneficiary({
        beneficiaryId,
        name: bankAccount.account_holder_name || user.name || 'Zipto Driver',
        phone: user.phone ?? '',
        email: user.email || undefined,
        ifsc: bankAccount.ifsc_code,
        accountNumber: bankAccount.account_number,
      });

      await this.bankAccountRepository.update(bankAccount.id, {
        cashfree_beneficiary_id: beneId,
        cashfree_sync_status: 'synced',
      });
      this.logger.log(`[CashfreePayout] Bank account synced: ${bankAccount.id} → beneficiary=${beneId}`);
    } catch (err: any) {
      await this.bankAccountRepository.update(bankAccount.id, { cashfree_sync_status: 'failed' });
      throw err;
    }
  }

  private async syncBankAccountToRazorpay(userId: string, bankAccount: BankAccount): Promise<void> {
    if (!this.razorpayXService.isConfigured) return;

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) return;

    // Reuse the contact_id from any other bank account of this driver if it already exists
    const withContact = await this.bankAccountRepository.findOne({
      where: { driver_profile_id: bankAccount.driver_profile_id, razorpay_contact_id: Not(IsNull()) },
    });

    let contactId: string;
    if (withContact?.razorpay_contact_id) {
      contactId = withContact.razorpay_contact_id!;
    } else {
      contactId = await this.razorpayXService.createContact({
        name: user.name,
        email: user.email || undefined,
        phone: user.phone ?? '',
        referenceId: userId,
      });
    }

    const fundAccountId = await this.razorpayXService.createFundAccount({
      contactId,
      accountHolderName: bankAccount.account_holder_name,
      ifscCode: bankAccount.ifsc_code,
      accountNumber: bankAccount.account_number,
    });

    await this.bankAccountRepository.update(bankAccount.id, {
      razorpay_contact_id: contactId,
      razorpay_fund_account_id: fundAccountId,
      razorpay_sync_status: 'synced',
    });
    this.logger.log(`[RazorpayX] Bank account synced: ${bankAccount.id} → fundAccount=${fundAccountId}`);
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

    const bookingIds = inPeriod.map(b => b.id);

    // Use wallet transactions as source of truth for cash vs online classification.
    // trip_earnings_credit = online (wallet was credited with driver earnings)
    // cash_commission_deduction = cash (wallet was debited for commission)
    // Any booking with no wallet txn defaults to cash (driver kept full fare, no record created yet).
    const cashBookingIds = new Set<string>();
    const onlineBookingIds = new Set<string>();
    if (bookingIds.length) {
      const txns = await this.walletTxnRepository.find({
        where: bookingIds.map(id => ({ booking_id: id })),
        select: ['booking_id', 'type'],
      });
      for (const t of txns) {
        if (!t.booking_id) continue;
        if (t.type === 'trip_earnings_credit') onlineBookingIds.add(t.booking_id);
        if (t.type === 'cash_commission_deduction') cashBookingIds.add(t.booking_id);
      }
    }

    let totalEarnings = 0;
    let totalGrossFare = 0;
    let totalAppCommission = 0;
    let totalPlatformFee = 0;
    let totalShieldFee = 0;
    // cash_earnings = gross fare physically collected from customer (not net)
    let cashEarnings = 0;
    let cashNetEarnings = 0; // net for cash trips, used to compute dues
    let onlineEarnings = 0;
    let cashTripCount = 0;
    let onlineTripCount = 0;

    for (const b of inPeriod) {
      const driverEarnings = Number(b.driver_earnings || 0);
      const commission = Number(b.skido_commission || 0);
      const gross = Number(b.final_fare || 0);
      const fb = b.fare_breakdown as any;
      const isOnline = onlineBookingIds.has(b.id);

      totalEarnings += driverEarnings;
      totalGrossFare += gross;
      totalAppCommission += commission;
      totalPlatformFee += Number(fb?.platform_fee ?? 2);
      totalShieldFee += Number(fb?.shield_fee ?? 1);

      if (isOnline) {
        onlineEarnings += driverEarnings;
        onlineTripCount++;
      } else {
        // Driver physically collects the full gross fare from the customer.
        // They owe (gross - net) back to the platform — tracked as cash_dues.
        cashEarnings += gross;
        cashNetEarnings += driverEarnings;
        cashTripCount++;
      }
    }

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
      cash_trip_count: cashTripCount,
      online_trip_count: onlineTripCount,
      cash_earnings: parseFloat(cashEarnings.toFixed(2)),
      cash_dues: parseFloat((cashEarnings - cashNetEarnings).toFixed(2)),
      online_earnings: parseFloat(onlineEarnings.toFixed(2)),
      breakdown: {
        gross_fare: parseFloat(totalGrossFare.toFixed(2)),
        app_commission: parseFloat(totalAppCommission.toFixed(2)),
        platform_fee: parseFloat(totalPlatformFee.toFixed(2)),
        shield_fee: parseFloat(totalShieldFee.toFixed(2)),
        net_earnings: parseFloat(totalEarnings.toFixed(2)),
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

    // Block if there is already a pending/processing withdrawal to prevent double-withdrawal
    const existing = await this.withdrawalRepository.findOne({
      where: [
        { driver_profile_id: profile.id, status: WithdrawalStatus.PENDING },
        { driver_profile_id: profile.id, status: WithdrawalStatus.PROCESSING },
      ],
    });
    if (existing) {
      throw new BadRequestException(
        `You already have a withdrawal request of ₹${Number(existing.amount).toFixed(2)} pending. Please wait for it to be processed.`,
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

    // Create PENDING request first (no wallet touch yet)
    const request = this.withdrawalRepository.create({
      driver_profile_id: profile.id,
      amount,
      ...(bankAccountId && { bank_account_id: bankAccountId }),
      status: WithdrawalStatus.PENDING,
    });
    const saved = await this.withdrawalRepository.save(request) as WithdrawalRequest;

    // Atomically debit wallet under a FOR UPDATE lock — re-checks balance against concurrent requests
    try {
      await this.driverWalletService.withdrawalDebit(userId, amount, saved.id);
    } catch (err) {
      // Rollback: if debit fails (e.g. concurrent withdrawal drained balance), void the request
      await this.withdrawalRepository.update(saved.id, {
        status: WithdrawalStatus.REJECTED,
        remarks: 'Auto-voided: wallet debit failed (possible concurrent request)',
      });
      throw err;
    }

    // ── Auto-trigger Cashfree payout immediately (no admin approval needed) ──
    if (this.cashfreePayoutService.isConfigured && bankAccountId) {
      const bankAccount = await this.bankAccountRepository.findOne({
        where: { id: bankAccountId },
      });

      if (bankAccount) {
        // Ensure the beneficiary is registered — sync now if it hasn't been yet
        if (!bankAccount.cashfree_beneficiary_id) {
          await this.syncBankAccountToCashfree(userId, bankAccount).catch(err =>
            this.logger.warn(`[CashfreePayout] Beneficiary sync failed before payout: ${err?.message}`),
          );
          const refreshed = await this.bankAccountRepository.findOne({ where: { id: bankAccountId } });
          if (refreshed?.cashfree_beneficiary_id) {
            bankAccount.cashfree_beneficiary_id = refreshed.cashfree_beneficiary_id;
          }
        }

        if (bankAccount.cashfree_beneficiary_id) {
          try {
            const transfer = await this.cashfreePayoutService.createTransfer({
              transferId:    this.cashfreePayoutService.generateTransferId(saved.id),
              beneficiaryId: bankAccount.cashfree_beneficiary_id,
              amount,
              remarks:       'Zipto driver payout',
              mode:          'imps',
            });

            // FAILED/REJECTED right away → refund and void; else mark PROCESSING.
            if (this.isFailedTransferStatus(transfer.status)) {
              await this.failWithdrawalAndRefund(saved.id, userId, amount, transfer.message ?? transfer.status);
            } else {
              await this.withdrawalRepository.update(saved.id, {
                status:    WithdrawalStatus.PROCESSING,
                payout_id: transfer.transferId,
                ...(transfer.utr ? { payout_reference: transfer.utr } : {}),
              });

              this.logger.log(`[CashfreePayout] Auto-payout triggered: withdrawal=${saved.id}, transfer=${transfer.transferId}, status=${transfer.status}`);

              this.notificationService.sendPushNotification({
                user_id: userId,
                title: '💸 Payout Initiated!',
                body: `₹${amount.toLocaleString('en-IN')} is being transferred to ${bankAccount.bank_name ?? 'your bank account'}${bankAccount.account_number ? ` (••••${bankAccount.account_number.slice(-4)})` : ''}. Expect credit within 30 minutes via IMPS.`,
                data: { type: 'withdrawal_processing', amount: String(amount), withdrawal_id: saved.id },
              }).catch(() => {});
            }
          } catch (err: any) {
            // Payout failed to initiate — leave as PENDING so admin can manually approve
            this.logger.error(
              `[CashfreePayout] Auto-payout initiation failed for withdrawal=${saved.id}: ${err?.response?.data?.message ?? err?.message}. Stays PENDING for admin review.`,
            );
          }
        }
      }
    }

    const remainingBalance = await this.driverWalletService.getWalletBalance(userId);

    return {
      success: true,
      message: 'Withdrawal request submitted successfully',
      withdrawal_id: saved.id,
      amount: saved.amount,
      remaining_balance: parseFloat(remainingBalance.toFixed(2)),
    };
  }

  /** Cashfree payout statuses that mean the money will NOT move — refund the wallet. */
  private isFailedTransferStatus(status: string): boolean {
    return ['FAILED', 'REJECTED', 'REVERSED', 'ERROR', 'CANCELLED'].includes(
      (status || '').toUpperCase(),
    );
  }

  /**
   * Mark a withdrawal REJECTED and refund the debited amount to the driver wallet.
   * Idempotent via withdrawalRefund's reference guard.
   */
  private async failWithdrawalAndRefund(
    withdrawalId: string,
    driverUserId: string,
    amount: number,
    reason: string,
  ): Promise<void> {
    await this.withdrawalRepository.update(withdrawalId, {
      status: WithdrawalStatus.REJECTED,
      failure_reason: reason,
    });
    await this.driverWalletService.withdrawalRefund(driverUserId, amount, withdrawalId);
    this.logger.warn(
      `[CashfreePayout] Payout failed at initiation for withdrawal=${withdrawalId}: ${reason}. Wallet refunded ₹${amount}.`,
    );
    this.notificationService.sendPushNotification({
      user_id: driverUserId,
      title: '⚠️ Payout Failed',
      body: `Your ₹${amount.toLocaleString('en-IN')} withdrawal could not be processed and has been refunded to your Zipto wallet. Please try again.`,
      data: { type: 'payout_failed', amount: String(amount), withdrawal_id: withdrawalId },
    }).catch(() => {});
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

  // ─── UPI Top-up Requests ──────────────────────────────────────────────────

  async submitTopupRequest(userId: string, amount: number, utrNumber: string) {
    const profile = await this.driverProfileRepository.findOne({ where: { user_id: userId } });
    if (!profile) throw new NotFoundException('Driver profile not found');

    const duplicate = await this.topupRequestRepository.findOne({ where: { utr_number: utrNumber } });
    if (duplicate) throw new BadRequestException('This UTR number has already been submitted');

    const request = this.topupRequestRepository.create({
      driver_user_id: userId,
      driver_profile_id: profile.id,
      amount,
      utr_number: utrNumber,
      status: TopupRequestStatus.PENDING,
    });
    await this.topupRequestRepository.save(request);
    return {
      message: 'Top-up request submitted. Your wallet will be credited once admin verifies the payment.',
      request_id: request.id,
    };
  }

  /**
   * Auto-verify a UPI topup using the response from react-native-upi-payment.
   * Called immediately after the UPI app returns SUCCESS to the driver app.
   * Credits the wallet in real-time — no admin action required.
   */
  async autoVerifyUpiTopup(
    userId: string,
    amount: number,
    upiTxnId: string,
    utrNumber: string,
    upiStatus: string,
  ): Promise<{ new_balance: number }> {
    const profile = await this.driverProfileRepository.findOne({ where: { user_id: userId } });
    if (!profile) throw new NotFoundException('Driver profile not found');

    if (upiStatus !== 'SUCCESS') {
      throw new BadRequestException(`UPI payment status is ${upiStatus} — only SUCCESS payments are credited.`);
    }

    // Use UTR if available, otherwise generate a unique ref for this topup
    const ref = (utrNumber || upiTxnId || `AUTO-${userId.slice(-8)}-${Date.now()}`).toUpperCase();

    // Idempotency: if this UTR was already credited, return current balance
    const existing = await this.topupRequestRepository.findOne({ where: { utr_number: ref } });
    if (existing && existing.status === TopupRequestStatus.APPROVED) {
      const balance = await this.driverWalletService.getWalletBalance(userId);
      return { new_balance: balance };
    }
    if (existing) throw new BadRequestException('This transaction has already been processed.');

    // Record + credit atomically
    const request = this.topupRequestRepository.create({
      driver_user_id: userId,
      driver_profile_id: profile.id,
      amount,
      utr_number: ref,
      status: TopupRequestStatus.APPROVED,
      remarks: `Auto-verified via UPI app | txnId: ${upiTxnId}`,
    });
    await this.topupRequestRepository.save(request);

    const new_balance = await this.driverWalletService.topUp(userId, amount, ref);
    return { new_balance };
  }

  async getDriverTopupRequests(userId: string) {
    return this.topupRequestRepository.find({
      where: { driver_user_id: userId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Step 1 of native Razorpay checkout top-up.
   * Creates a Razorpay Order and a PENDING DriverTopupRequest.
   * Returns order_id + key so the app can open RazorpayCheckout.open().
   */
  async createTopupOrder(userId: string, amount: number): Promise<{
    order_id: string;
    amount_paise: number;
    key_id: string;
    currency: string;
    request_id: string;
    is_test_mode?: boolean;
    new_balance?: number;
  }> {
    const profile = await this.driverProfileRepository.findOne({ where: { user_id: userId } });
    if (!profile) throw new NotFoundException('Driver profile not found');

    const keyId     = this.configService.get<string>('externalServices.razorpay.keyId')     ?? '';
    const keySecret = this.configService.get<string>('externalServices.razorpay.keySecret') ?? '';
    if (!keyId || !keySecret) throw new BadRequestException('Payment gateway not configured');

    const forceOneRupee = this.configService.get<string>('RAZORPAY_FORCE_ONE_RUPEE') === 'true';
    const amountPaise   = forceOneRupee ? 100 : Math.round(amount * 100);

    const isTestMode = keyId.startsWith('rzp_test');
    if (isTestMode) {
      const ref = `TEST-${userId.slice(-6).toUpperCase()}-${Date.now()}`;
      const request = this.topupRequestRepository.create({
        driver_user_id: userId, driver_profile_id: profile.id,
        amount, utr_number: ref, status: TopupRequestStatus.APPROVED,
        remarks: 'Auto-approved (Razorpay test mode)',
      });
      await this.topupRequestRepository.save(request);
      const new_balance = await this.driverWalletService.topUp(userId, amount, ref);
      return { order_id: ref, amount_paise: amountPaise, key_id: keyId, currency: 'INR', request_id: request.id, is_test_mode: true, new_balance };
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    let order: any;
    try {
      order = await razorpay.orders.create({
        amount:   amountPaise,
        currency: 'INR',
        receipt:  `topup_${userId.slice(-8)}_${Date.now()}`,
      });
    } catch (err: any) {
      this.logger.error(`[Topup] Razorpay order.create failed: ${JSON.stringify(err)}`);
      throw new BadRequestException(err?.error?.description || err?.message || 'Failed to create payment order.');
    }

    const request = this.topupRequestRepository.create({
      driver_user_id: userId, driver_profile_id: profile.id,
      amount, utr_number: order.id,
      status:  TopupRequestStatus.PENDING,
      remarks: `Razorpay order: ${order.id}`,
    });
    await this.topupRequestRepository.save(request);

    return { order_id: order.id, amount_paise: amountPaise, key_id: keyId, currency: 'INR', request_id: request.id };
  }

  /**
   * Step 2 — called after RazorpayCheckout.open() succeeds.
   * Verifies the HMAC signature then credits the wallet.
   */
  async verifyTopupPayment(
    userId: string,
    razorpayOrderId:   string,
    razorpayPaymentId: string,
    razorpaySignature: string,
    amount: number,
  ): Promise<{ new_balance: number }> {
    const crypto = require('crypto');
    const keySecret = this.configService.get<string>('externalServices.razorpay.keySecret') ?? '';
    if (!keySecret) throw new BadRequestException('Payment gateway not configured');

    const generated = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
    if (generated !== razorpaySignature) {
      throw new BadRequestException('Invalid payment signature — payment could not be verified.');
    }

    // Idempotency: find the pending request by order_id
    const request = await this.topupRequestRepository.findOne({
      where: { utr_number: razorpayOrderId, driver_user_id: userId },
    });
    if (!request) throw new NotFoundException('Top-up request not found');
    if (request.status === TopupRequestStatus.APPROVED) {
      const balance = await this.driverWalletService.getWalletBalance(userId);
      return { new_balance: balance };
    }

    // Atomic approve-and-credit
    const updated = await this.topupRequestRepository.update(
      { id: request.id, status: TopupRequestStatus.PENDING },
      { status: TopupRequestStatus.APPROVED, remarks: `Paid | paymentId: ${razorpayPaymentId}` },
    );
    if (!updated.affected) {
      const balance = await this.driverWalletService.getWalletBalance(userId);
      return { new_balance: balance };
    }

    const new_balance = await this.driverWalletService.topUp(userId, Number(request.amount), razorpayPaymentId);
    this.logger.log(`[Topup] Wallet credited ₹${request.amount} for driver=${userId} payment=${razorpayPaymentId}`);
    return { new_balance };
  }

  // ─── Cashfree wallet top-up (native UPI-intent checkout) ────────────────────

  /**
   * Create a Cashfree order + PENDING DriverTopupRequest. The app opens the
   * native Cashfree checkout with the returned payment_session_id (UPI intent).
   */
  async createCashfreeTopupOrder(userId: string, amount: number): Promise<{
    order_id: string;
    payment_session_id: string;
    mode: string;
    request_id: string;
  }> {
    const profile = await this.driverProfileRepository.findOne({ where: { user_id: userId } });
    if (!profile) throw new NotFoundException('Driver profile not found');
    if (!this.cashfreeService.isEnabled) throw new BadRequestException('Payment gateway not configured');

    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: ['id', 'phone', 'email'],
    });
    const phone = (user?.phone || '').replace(/\D/g, '').slice(-10) || '9999999999';

    const orderId = this.cashfreeService.generateOrderId();
    const base = (
      this.configService.get<string>('HDFC_REDIRECT_BASE_URL') ||
      process.env.HDFC_REDIRECT_BASE_URL ||
      'https://api.ridezipto.com/api'
    ).replace(/\/+$/, '');

    const { paymentSessionId } = await this.cashfreeService.createOrder({
      orderId,
      amount,
      customerId: userId,
      customerPhone: phone,
      customerEmail: user?.email || undefined,
      returnUrl: `${base}/payment/cashfree/return?order_id={order_id}`,
      notifyUrl: `${base}/payment/cashfree/webhook`,
      tags: { purpose: 'driver_topup', user_id: userId },
    });

    const request = this.topupRequestRepository.create({
      driver_user_id: userId,
      driver_profile_id: profile.id,
      amount,
      utr_number: orderId, // Cashfree order id is the unique reference
      status: TopupRequestStatus.PENDING,
      remarks: `Cashfree order: ${orderId}`,
    });
    await this.topupRequestRepository.save(request);

    return {
      order_id: orderId,
      payment_session_id: paymentSessionId,
      mode: this.cashfreeService.mode,
      request_id: request.id,
    };
  }

  /**
   * Confirm a Cashfree top-up (called after the SDK reports completion).
   * Verifies the order is PAID with Cashfree, then atomically credits the
   * wallet exactly once.
   */
  async verifyCashfreeTopup(userId: string, orderId: string): Promise<{ new_balance: number; status: string }> {
    return this.creditCashfreeTopup(orderId, userId);
  }

  /**
   * Webhook-driven fallback for driver wallet top-ups. The PG server-to-server
   * webhook calls this so a top-up is still credited even if the rider app
   * never calls verify (e.g. the driver force-closed the app after paying).
   * Safe to race with verifyCashfreeTopup — the conditional status flip in
   * creditCashfreeTopup guarantees the wallet is credited at most once.
   */
  async creditCashfreeTopupFromWebhook(orderId: string): Promise<void> {
    try {
      await this.creditCashfreeTopup(orderId);
    } catch (err: any) {
      this.logger.warn(`[Topup] Webhook credit skipped for order=${orderId}: ${err?.message ?? err}`);
    }
  }

  /**
   * Verify a Cashfree top-up order is PAID and credit the driver's wallet
   * exactly once. Shared by the app's verify call and the PG webhook fallback.
   * @param expectedUserId when provided (app path), scopes the lookup to that
   *        driver so one driver can't confirm another's order.
   */
  private async creditCashfreeTopup(
    orderId: string,
    expectedUserId?: string,
  ): Promise<{ new_balance: number; status: string }> {
    const request = await this.topupRequestRepository.findOne({
      where: expectedUserId
        ? { utr_number: orderId, driver_user_id: expectedUserId }
        : { utr_number: orderId },
    });
    if (!request) throw new NotFoundException('Top-up request not found');

    const driverUserId = request.driver_user_id;

    if (request.status === TopupRequestStatus.APPROVED) {
      return { new_balance: await this.driverWalletService.getWalletBalance(driverUserId), status: 'approved' };
    }

    const order = await this.cashfreeService.getOrder(orderId);
    if (!order.isPaid) {
      return {
        new_balance: await this.driverWalletService.getWalletBalance(driverUserId),
        status: order.orderStatus,
      };
    }

    // Single-flight: only the caller that flips PENDING→APPROVED credits the wallet.
    const updated = await this.topupRequestRepository.update(
      { id: request.id, status: TopupRequestStatus.PENDING },
      { status: TopupRequestStatus.APPROVED, remarks: `Cashfree paid: ${orderId}` },
    );
    if (!updated.affected) {
      return { new_balance: await this.driverWalletService.getWalletBalance(driverUserId), status: 'approved' };
    }

    const new_balance = await this.driverWalletService.topUp(driverUserId, Number(request.amount), orderId);
    this.logger.log(`[Topup] Cashfree wallet credit ₹${request.amount} for driver=${driverUserId} order=${orderId}`);
    return { new_balance, status: 'approved' };
  }

  /**
   * Create a Razorpay payment link for wallet top-up.
   * In test mode the wallet is credited immediately (no real payment required).
   * In live mode a short URL is returned; the app opens it, the customer pays,
   * and the app polls getTopupRequestStatus() until it flips to 'approved'.
   */
  async createWalletTopupLink(userId: string, amount: number): Promise<{
    short_url: string | null;
    amount: number;
    request_id: string;
    is_test_mode?: boolean;
    new_balance?: number;
  }> {
    const profile = await this.driverProfileRepository.findOne({ where: { user_id: userId } });
    if (!profile) throw new NotFoundException('Driver profile not found');

    const keyId     = this.configService.get<string>('externalServices.razorpay.keyId')     ?? '';
    const keySecret = this.configService.get<string>('externalServices.razorpay.keySecret') ?? '';
    if (!keyId || !keySecret) throw new BadRequestException('Payment gateway not configured');

    const isTestMode = keyId.startsWith('rzp_test');

    if (isTestMode) {
      const ref = `TEST-${userId.slice(-6).toUpperCase()}-${Date.now()}`;
      const request = this.topupRequestRepository.create({
        driver_user_id:    userId,
        driver_profile_id: profile.id,
        amount,
        utr_number:  ref,
        status:      TopupRequestStatus.APPROVED,
        remarks:     'Auto-approved (Razorpay test mode)',
      });
      await this.topupRequestRepository.save(request);
      const new_balance = await this.driverWalletService.topUp(userId, amount, ref);
      this.logger.log(`[Topup] Test-mode auto-credit ₹${amount} for driver=${userId}`);
      return { short_url: null, amount, request_id: request.id, is_test_mode: true, new_balance };
    }

    // Create a PENDING record first so we have an ID to embed in reference_id
    const placeholder = `INIT-${Date.now()}-${Math.floor(Math.random() * 9999)}`;
    const request = this.topupRequestRepository.create({
      driver_user_id:    userId,
      driver_profile_id: profile.id,
      amount,
      utr_number:  placeholder,
      status:      TopupRequestStatus.PENDING,
      remarks:     'Razorpay payment link initiated',
    });
    await this.topupRequestRepository.save(request);

    const razorpay    = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const forceOneRupee = this.configService.get<string>('RAZORPAY_FORCE_ONE_RUPEE') === 'true';
    const amountPaise = forceOneRupee ? 100 : Math.round(amount * 100);

    let link: any;
    try {
      link = await razorpay.paymentLink.create({
        amount:       amountPaise,
        currency:     'INR',
        description:  `Zipto Driver Wallet Top-up Rs.${amount}`,
        reminder_enable: false,
        notify:       { sms: false, email: false },
        reference_id: `tp_${request.id}`,
      });
    } catch (err: any) {
      this.logger.error(`[Topup] Razorpay paymentLink.create failed: ${JSON.stringify(err)}`);
      await this.topupRequestRepository.remove(request);
      const msg = err?.error?.description || err?.message || 'Failed to create payment link. Please try again.';
      throw new BadRequestException(msg);
    }

    // Store Razorpay link ID so getTopupRequestStatus can fetch payment status
    request.utr_number = link.id;
    request.remarks    = `Razorpay link: ${link.id}`;
    await this.topupRequestRepository.save(request);

    this.logger.log(`[Topup] Payment link created ${link.id} for driver=${userId} amount=₹${amount}`);
    return { short_url: link.short_url, amount, request_id: request.id };
  }

  /**
   * Poll this after returning from the Razorpay payment page.
   * When the payment link is paid, credits the wallet atomically (idempotent).
   */
  async getTopupRequestStatus(userId: string, requestId: string): Promise<{
    status: 'pending' | 'approved' | 'rejected';
    new_balance?: number;
  }> {
    const request = await this.topupRequestRepository.findOne({
      where: { id: requestId, driver_user_id: userId },
    });
    if (!request) throw new NotFoundException('Top-up request not found');

    if (request.status === TopupRequestStatus.APPROVED) {
      const balance = await this.driverWalletService.getWalletBalance(userId);
      return { status: 'approved', new_balance: balance };
    }
    if (request.status === TopupRequestStatus.REJECTED) {
      return { status: 'rejected' };
    }

    // PENDING: check Razorpay if the link has been paid
    const linkId = request.utr_number;
    if (linkId && linkId.startsWith('plink_')) {
      const keyId     = this.configService.get<string>('externalServices.razorpay.keyId')     ?? '';
      const keySecret = this.configService.get<string>('externalServices.razorpay.keySecret') ?? '';
      if (keyId && keySecret) {
        try {
          const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
          const link = await razorpay.paymentLink.fetch(linkId);
          if (link.status === 'paid') {
            // Atomic: only credit once — UPDATE WHERE status = 'pending'
            const result = await this.topupRequestRepository.update(
              { id: requestId, driver_user_id: userId, status: TopupRequestStatus.PENDING },
              { status: TopupRequestStatus.APPROVED, remarks: `Paid via Razorpay | link: ${linkId}` },
            );
            if (result.affected && result.affected > 0) {
              const new_balance = await this.driverWalletService.topUp(userId, Number(request.amount), linkId);
              this.logger.log(`[Topup] Wallet credited ₹${request.amount} for driver=${userId} via poll`);
              return { status: 'approved', new_balance };
            }
            // Another concurrent poll already credited — return current balance
            const balance = await this.driverWalletService.getWalletBalance(userId);
            return { status: 'approved', new_balance: balance };
          }
        } catch (err) {
          this.logger.warn(`[Topup] Razorpay fetch failed for link=${linkId}: ${err}`);
        }
      }
    }

    return { status: 'pending' };
  }
}
