import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CouponService } from './coupon.service';
import { Coupon } from './entities/coupon.entity';
import { CouponUsage } from './entities/coupon-usage.entity';
import { Booking } from '../booking/entities/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Coupon, CouponUsage, Booking]),
  ],
  providers: [CouponService],
  exports:   [CouponService],
})
export class CouponModule {}
