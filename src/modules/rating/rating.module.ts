import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RatingController } from './rating.controller';
import { RatingService } from './rating.service';
import { Rating } from './entities/rating.entity';
import { Booking } from '../booking/entities/booking.entity';
import { DriverProfile } from '../driver/entities/driver-profile.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Rating, Booking, DriverProfile])],
  controllers: [RatingController],
  providers: [RatingService],
  exports: [RatingService],
})
export class RatingModule {}
