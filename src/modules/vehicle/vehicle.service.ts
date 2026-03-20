import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vehicle, VehicleType } from './entities/vehicle.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { RegisterVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class VehicleService {
  constructor(
    @InjectRepository(Vehicle)
    private vehicleRepository: Repository<Vehicle>,
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Register new vehicle
   */
  async register(userId: string, registerVehicleDto: RegisterVehicleDto) {
    // Get driver profile
    const driverProfile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
    });

    if (!driverProfile) {
      throw new NotFoundException('Driver profile not found');
    }

    // Check if registration number already exists
    const existingVehicle = await this.vehicleRepository.findOne({
      where: { registration_number: registerVehicleDto.registration_number },
    });

    if (existingVehicle) {
      throw new ConflictException('Vehicle with this registration number already exists');
    }

    const vehicle = this.vehicleRepository.create({
      ...registerVehicleDto,
      driver_id: driverProfile.id,
    });

    const savedVehicle = await this.vehicleRepository.save(vehicle);

    // Update driver profile with vehicle_id
    await this.driverProfileRepository.update(driverProfile.id, {
      vehicle_id: savedVehicle.id,
    });

    // Notify admin about new vehicle submission
    await this.notificationService.pushAdmin(
      'vehicle_submitted',
      'New Vehicle Submitted for Approval',
      `Vehicle ${savedVehicle.registration_number} (${savedVehicle.vehicle_type ?? 'unknown'}) has been submitted and is pending verification.`,
      { vehicleId: savedVehicle.id, driverProfileId: driverProfile.id },
    );

    return savedVehicle;
  }

  /**
   * Get vehicle by ID
   */
  async getById(vehicleId: string, userId: string) {
    const vehicle = await this.vehicleRepository.findOne({
      where: { id: vehicleId },
      relations: ['driver'],
    });

    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }

    // Check if the vehicle belongs to the driver
    const driverProfile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
    });

    if (vehicle.driver_id !== driverProfile?.id) {
      throw new ForbiddenException('You do not have access to this vehicle');
    }

    return vehicle;
  }

  /**
   * Update vehicle
   */
  async update(vehicleId: string, userId: string, updateVehicleDto: UpdateVehicleDto) {
    const vehicle = await this.getById(vehicleId, userId);

    Object.assign(vehicle, updateVehicleDto);
    return this.vehicleRepository.save(vehicle);
  }

  /**
   * Get vehicle types with metadata (public endpoint)
   */
  getVehicleTypes() {
    return [
      {
        type: VehicleType.BIKE,
        name: 'Bike',
        capacity_range: '10-50 kg',
        base_fare: 30,
      },
      {
        type: VehicleType.THREE_WHEELER,
        name: 'Three Wheeler',
        capacity_range: '100-300 kg',
        base_fare: 50,
      },
      {
        type: VehicleType.TATA_ACE,
        name: 'Tata Ace',
        capacity_range: '500-750 kg',
        base_fare: 120,
      },
      {
        type: VehicleType.PICKUP_8FT,
        name: 'Pickup 8ft',
        capacity_range: '1000-1500 kg',
        base_fare: 200,
      },
      {
        type: VehicleType.TATA_407,
        name: 'Tata 407',
        capacity_range: '2000-3000 kg',
        base_fare: 350,
      },
    ];
  }

  /**
   * Get driver's vehicles
   */
  async getDriverVehicles(userId: string) {
    const driverProfile = await this.driverProfileRepository.findOne({
      where: { user_id: userId },
    });

    if (!driverProfile) {
      throw new NotFoundException('Driver profile not found');
    }

    return this.vehicleRepository.find({
      where: { driver_id: driverProfile.id },
    });
  }
}
