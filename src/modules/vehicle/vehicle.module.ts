import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VehicleController } from './vehicle.controller';
import { VehicleService } from './vehicle.service';
import { Vehicle } from './entities/vehicle.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Vehicle, DriverProfile])],
  controllers: [VehicleController],
  providers: [VehicleService],
  exports: [VehicleService],
})
export class VehicleModule {}
