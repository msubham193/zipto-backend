import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { Booking } from './entities/booking.entity';
import { PricingRule } from './entities/pricing-rule.entity';
import { AuthModule } from '../auth/auth.module';
import { CoinModule } from '../coin/coin.module';
import { BullModule } from '@nestjs/bull';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { caching } from 'cache-manager';
import { BookingGateway } from './booking.gateway';
import { BookingProcessor } from './booking.processor';
import { Payment } from '../payment/entities/payment.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, PricingRule, Payment]),
    AuthModule,
    CoinModule,
    BullModule.registerQueue({
      name: 'booking_assignment',
    }),
  ],
  controllers: [BookingController],
  providers: [
    BookingService,
    BookingGateway,
    BookingProcessor,
    {
      provide: CACHE_MANAGER,
      useFactory: async () => caching('memory', { max: 500, ttl: 0 }),
    },
  ],
  exports: [BookingService, BookingGateway],
})
export class BookingModule {}