import { Module, Global } from '@nestjs/common';
import { MapboxService } from './mapbox.service';
import { RazorpayService } from './razorpay.service';
import { SmsService } from './sms.service';
import { FcmService } from './fcm.service';
import { S3Service } from './s3.service';

@Global()
@Module({
  providers: [
    MapboxService,
    RazorpayService,
    SmsService,
    FcmService,
    S3Service,
  ],
  exports: [
    MapboxService,
    RazorpayService,
    SmsService,
    FcmService,
    S3Service,
  ],
})
export class ServicesModule {}
