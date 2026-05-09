import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriverFraudService } from './driver-fraud.service';
import { DriverFraudIncident } from './entities/driver-fraud-incident.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { User } from '../auth/entities/user.entity';
import { Booking } from '../booking/entities/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([DriverFraudIncident, DriverProfile, User, Booking]),
  ],
  providers: [DriverFraudService],
  exports: [DriverFraudService],
})
export class DriverFraudModule {}