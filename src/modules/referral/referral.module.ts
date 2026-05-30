import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReferralController } from './referral.controller';
import { ReferralLandingController } from './referral-landing.controller';
import { ReferralService } from './referral.service';
import { Referral } from './entities/referral.entity';
import { User } from '../auth/entities/user.entity';
import { Booking } from '../booking/entities/booking.entity';
import { CoinModule } from '../coin/coin.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Referral, User, Booking]),
    CoinModule,
    SettingsModule,
  ],
  controllers: [ReferralController, ReferralLandingController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
