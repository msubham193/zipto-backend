import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { AuthModule } from '../auth/auth.module';
import { BookingModule } from '../booking/booking.module';
import { Booking } from '../booking/entities/booking.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, DriverProfile]),
    AuthModule,
    BookingModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}