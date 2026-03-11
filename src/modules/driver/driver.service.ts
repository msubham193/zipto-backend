import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DriverProfile,
  AvailabilityStatus,
  VerificationStatus,
} from './entities/driver-profile.entity';
import { Vehicle, VehicleType } from '../vehicle/entities/vehicle.entity';
import { User } from '../auth/entities/user.entity';
import { Booking, BookingStatus } from '../booking/entities/booking.entity';
import {
  UpdateDriverDto,
  UpdateAvailabilityDto,
  UpdateLocationDto,
  OnboardDriverDto,
} from './dto/driver.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';
import { S3Service } from '../../services/s3.service';

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
    private readonly s3Service: S3Service,
  ) {}

  /**
   * Get driver profile
   */
  async getProfile(userId: string) {
    const profile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      throw new NotFoundException('Driver profile not found');
    }

    return profile;
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

    // Create PostGIS Point using ST_MakePoint and ST_SetSRID
    await this.driverProfileRepository
      .createQueryBuilder()
      .update(DriverProfile)
      .set({
        current_location: () => `ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)`,
      })
      .where('user_id = :userId', { userId })
      .execute();

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
    const driverProfile = await this.getProfile(userId);

    // TODO: This will be implemented when Booking module is created
    // For now, return empty array with pagination
    const trips: any[] = [];
    const total = 0;

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

    return this.driverProfileRepository.save(profile);
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

    return { message: 'Driver onboarded successfully', profile };
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
