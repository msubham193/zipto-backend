import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { Booking } from './entities/booking.entity';
import { PricingRule } from './entities/pricing-rule.entity';
import { AuthModule } from '../auth/auth.module';
import { CoinModule } from '../coin/coin.module';
import { BullModule } from '@nestjs/bull';
import { CacheModule } from '@nestjs/cache-manager';
import { BookingGateway } from './booking.gateway';
import { BookingProcessor } from './booking.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, PricingRule]),
    AuthModule,
    CoinModule,
    BullModule.registerQueue({
      name: 'booking_assignment',
    }),
    CacheModule.register(),
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingGateway, BookingProcessor],
  exports: [BookingService],
})
export class BookingModule {}
