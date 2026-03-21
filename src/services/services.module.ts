import { Module, Global } from '@nestjs/common';
import { MapboxService } from './mapbox.service';
import { RazorpayService } from './razorpay.service';
import { SmsService } from './sms.service';
import { FcmService } from './fcm.service';
import { S3Service } from './s3.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [MapboxService, RazorpayService, SmsService, FcmService, S3Service, RedisService],
  exports: [MapboxService, RazorpayService, SmsService, FcmService, S3Service, RedisService],
})
export class ServicesModule {}
