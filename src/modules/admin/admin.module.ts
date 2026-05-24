import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { User } from '../auth/entities/user.entity';
import { Booking } from '../booking/entities/booking.entity';
import { PricingRule } from '../booking/entities/pricing-rule.entity';
import { Payment } from '../payment/entities/payment.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';
import { WithdrawalRequest } from '../driver/entities/withdrawal-request.entity';
import { BankAccount } from '../driver/entities/bank-account.entity';
import { Vehicle } from '../vehicle/entities/vehicle.entity';
import { AuthModule } from '../auth/auth.module';
import { BookingModule } from '../booking/booking.module';
import { DriverModule } from '../driver/driver.module';
import { NotificationModule } from '../notification/notification.module';
import { FraudModule } from '../fraud/fraud.module';
import { SettingsModule } from '../settings/settings.module';
import { CouponModule } from '../coupon/coupon.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Booking, PricingRule, Payment, DriverProfile, Vehicle, WithdrawalRequest, BankAccount]),
    AuthModule,
    BookingModule,
    DriverModule,
    NotificationModule,
    FraudModule,
    SettingsModule,
    CouponModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
