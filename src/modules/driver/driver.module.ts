import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import * as multer from 'multer';
import { DriverController } from './driver.controller';
import { DriverService } from './driver.service';
import { DriverProfile } from './entities/driver-profile.entity';
import { Vehicle } from '../vehicle/entities/vehicle.entity';
import { User } from '../auth/entities/user.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DriverProfile, User, Vehicle]),
    AuthModule,
    MulterModule.register({
      storage: multer.memoryStorage(),
    }),
  ],
  controllers: [DriverController],
  providers: [DriverService],
  exports: [DriverService],
})
export class DriverModule {}
