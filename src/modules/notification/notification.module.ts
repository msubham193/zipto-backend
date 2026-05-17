import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { AuthModule } from '../auth/auth.module';
import { Booking } from '../booking/entities/booking.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { User } from '../auth/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, DriverProfile, User]),
    AuthModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
