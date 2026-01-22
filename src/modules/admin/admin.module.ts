import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { User } from '../auth/entities/user.entity';
import { Booking } from '../booking/entities/booking.entity';
import { Payment } from '../payment/entities/payment.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { Vehicle } from '../vehicle/entities/vehicle.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Booking, Payment, DriverProfile, Vehicle])],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
