import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { Booking } from './entities/booking.entity';
import { PricingRule } from './entities/pricing-rule.entity';
import { AuthModule } from '../auth/auth.module';
import { CoinModule } from '../coin/coin.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, PricingRule]),
    AuthModule,
    CoinModule,
  ],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
