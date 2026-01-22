import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverProfile, AvailabilityStatus } from './entities/driver-profile.entity';
import { User } from '../auth/entities/user.entity';
import { UpdateDriverDto, UpdateAvailabilityDto, UpdateLocationDto } from './dto/driver.dto';
import { getPaginationMeta } from '../../common/utils/helpers.util';

@Injectable()
export class DriverService {
  constructor(
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
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
        ...(name && { name }),
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
   * Get trip history with pagination
   */
  async getTripHistory(
    userId: string,
    page: number = 1,
    limit: number = 10,
    status?: string,
  ) {
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
}
