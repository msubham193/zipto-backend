import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { Payment } from './entities/payment.entity';
import { Booking } from '../booking/entities/booking.entity';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { BookingModule } from '../booking/booking.module';
import { SettingsModule } from '../settings/settings.module';
import { DriverModule } from '../driver/driver.module';

@Module({
  imports: [TypeOrmModule.forFeature([Payment, Booking]), AuthModule, NotificationModule, forwardRef(() => BookingModule), SettingsModule, DriverModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
