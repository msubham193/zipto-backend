import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import * as multer from 'multer';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';
import { DriverWalletService } from './driver-wallet.service';
import { DriverProfile } from './entities/driver-profile.entity';
import { BankAccount } from './entities/bank-account.entity';
import { WithdrawalRequest } from './entities/withdrawal-request.entity';
import { DriverWalletTransaction } from './entities/driver-wallet-transaction.entity';
import { Vehicle } from '../vehicle/entities/vehicle.entity';
import { User } from '../auth/entities/user.entity';
import { AuthModule } from '../auth/auth.module';
import { Booking } from '../booking/entities/booking.entity';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DriverProfile,
      BankAccount,
      WithdrawalRequest,
      DriverWalletTransaction,
      User,
      Vehicle,
      Booking,
    ]),
    AuthModule,
    NotificationModule,
    MulterModule.register({
      storage: multer.memoryStorage(),
    }),
  ],
  controllers: [DriverController],
  providers: [DriverService, DriverWalletService],
  exports: [DriverService, DriverWalletService],
})
export class DriverModule {}
