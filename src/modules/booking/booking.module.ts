import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { Booking } from './entities/booking.entity';
import { PricingRule } from './entities/pricing-rule.entity';
import { User } from '../auth/entities/user.entity';
import { AuthModule } from '../auth/auth.module';
import { CoinModule } from '../coin/coin.module';
import { BullModule } from '@nestjs/bull';
import { BookingGateway } from './booking.gateway';
import { BookingProcessor } from './booking.processor';
import { Payment } from '../payment/entities/payment.entity';
import { FraudModule } from '../fraud/fraud.module';
import { SettingsModule } from '../settings/settings.module';
import { DriverFraudModule } from '../driver-fraud/driver-fraud.module';
import { NotificationModule } from '../notification/notification.module';
import { ZiptoShieldModule } from '../zipto-shield/zipto-shield.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, PricingRule, Payment, User]),
    AuthModule,
    CoinModule,
    BullModule.registerQueue({
      name: 'booking_assignment',
    }),
    forwardRef(() => FraudModule),
    SettingsModule,
    DriverFraudModule,
    NotificationModule,
    ZiptoShieldModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingGateway, BookingProcessor],
  exports: [BookingService, BookingGateway],
})
export class BookingModule {}