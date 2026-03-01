import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomerProfile } from './entities/customer-profile.entity';
import { User } from '../auth/entities/user.entity';
import { UpdateCustomerDto, SavedLocationDto } from './dto/customer.dto';

@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(CustomerProfile)
    private customerProfileRepository: Repository<CustomerProfile>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  /**
   * Get customer profile (create if doesn't exist)
   */
  async getProfile(userId: string) {
    let profile = await this.customerProfileRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!profile) {
      // Auto-create profile if doesn't exist
      const newProfile = this.customerProfileRepository.create({
        user_id: userId,
        saved_locations: [],
      });
      await this.customerProfileRepository.save(newProfile);

      // Load the user relation
      profile = await this.customerProfileRepository.findOne({
        where: { user_id: userId },
        relations: ['user'],
      });

      if (!profile) {
        throw new NotFoundException('Unable to create customer profile');
      }
    }

    return profile;
  }

  /**
   * Update customer profile
   */
  async updateProfile(userId: string, updateCustomerDto: UpdateCustomerDto) {
    const profile = await this.getProfile(userId);

    // Update user fields
    const { name, email, language_preference } = updateCustomerDto;
    if (name || email || language_preference) {
      await this.userRepository.update(userId, {
        ...(name && { name }),
        ...(email && { email }),
        ...(language_preference && { language_preference }),
      });
    }

    // Update profile fields
    const { address } = updateCustomerDto;
    if (address !== undefined) {
      profile.address = address;
      await this.customerProfileRepository.save(profile);
    }

    // Return updated profile
    return this.getProfile(userId);
  }

  /**
   * Get saved locations
   */
  async getSavedLocations(userId: string) {
    const profile = await this.getProfile(userId);
    return profile.saved_locations || [];
  }

  /**
   * Add saved location
   */
  async addSavedLocation(userId: string, locationDto: SavedLocationDto) {
    const profile = await this.getProfile(userId);

    const locations = profile.saved_locations || [];
    locations.push(locationDto);

    profile.saved_locations = locations;
    await this.customerProfileRepository.save(profile);

    return profile.saved_locations;
  }

  /**
   * Remove saved location by index
   */
  async removeSavedLocation(userId: string, index: number) {
    const profile = await this.getProfile(userId);

    const locations = profile.saved_locations || [];

    if (index < 0 || index >= locations.length) {
      throw new NotFoundException('Location not found');
    }

    locations.splice(index, 1);
    profile.saved_locations = locations;
    await this.customerProfileRepository.save(profile);

    return profile.saved_locations;
  }
}
