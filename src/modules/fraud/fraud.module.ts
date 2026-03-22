import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FraudService } from './fraud.service';
import { FraudController } from './fraud.controller';
import { CustomerReport } from './entities/customer-report.entity';
import { UserBlock } from './entities/user-block.entity';
import { User } from '../auth/entities/user.entity';
import { Booking } from '../booking/entities/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerReport, UserBlock, User, Booking]),
  ],
  controllers: [FraudController],
  providers: [FraudService],
  exports: [FraudService],
})
export class FraudModule {}
