import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { ServeStaticModule } from '@nestjs/serve-static';
import { APP_GUARD } from '@nestjs/core';
import { join } from 'path';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import redisConfig from './config/redis.config';
import awsConfig from './config/aws.config';
import externalServicesConfig from './config/external-services.config';
import { ServicesModule } from './services/services.module';
import { AuthModule } from './modules/auth/auth.module';
import { CustomerModule } from './modules/customer/customer.module';
import { DriverModule } from './modules/driver/driver.module';
import { VehicleModule } from './modules/vehicle/vehicle.module';
import { BookingModule } from './modules/booking/booking.module';
import { PaymentModule } from './modules/payment/payment.module';
import { RatingModule } from './modules/rating/rating.module';
import { AdminModule } from './modules/admin/admin.module';
import { NotificationModule } from './modules/notification/notification.module';
import { CoinModule } from './modules/coin/coin.module';
import { FraudModule } from './modules/fraud/fraud.module';
import { DriverFraudModule } from './modules/driver-fraud/driver-fraud.module';
import { SupportModule } from './modules/support/support.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ZiptoShieldModule } from './modules/zipto-shield/zipto-shield.module';
import { CouponModule } from './modules/coupon/coupon.module';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, jwtConfig, redisConfig, awsConfig, externalServicesConfig],
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        ...configService.get('database'),
      }),
    }),

    // Rate Limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: configService.get<number>('externalServices.rateLimit.ttl') || 60,
            limit: configService.get<number>('externalServices.rateLimit.limit') || 100,
          },
        ],
      }),
    }),

    // Queue Configuration
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const host = configService.get('redis.host') || 'localhost';
        const port = configService.get('redis.port') || 6379;
        const password = configService.get('redis.password') || undefined;
        console.log(`[BullModule] Connecting to Redis at ${host}:${port}`);
        return {
          redis: {
            host,
            port,
            password,
          },
        };
      },
    }),

    // Scheduling
    ScheduleModule.forRoot(),

    // Global Services
    ServicesModule,

    // Feature Modules
    AuthModule,
    CustomerModule,
    DriverModule,
    VehicleModule,
    BookingModule,
    PaymentModule,
    RatingModule,
    AdminModule,
    NotificationModule,
    CoinModule,
    FraudModule,
    DriverFraudModule,
    SupportModule,
    SettingsModule,
    ZiptoShieldModule,
    CouponModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads',
    }),
  ],
  controllers: [],
  providers: [
    // Global guards - JwtAuthGuard runs first, then RolesGuard
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
