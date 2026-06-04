import { Module, Global } from '@nestjs/common';
import { MapboxService } from './mapbox.service';
import { RazorpayService } from './razorpay.service';
import { RazorpayXService } from './razorpayx.service';
import { HdfcPaymentService } from './hdfc-payment.service';
import { CashfreeService } from './cashfree.service';
import { SmsService } from './sms.service';
import { FcmService } from './fcm.service';
import { S3Service } from './s3.service';
import { RedisService } from './redis.service';
import { ExotelService } from './exotel.service';

@Global()
@Module({
  providers: [MapboxService, RazorpayService, RazorpayXService, HdfcPaymentService, CashfreeService, SmsService, FcmService, S3Service, RedisService, ExotelService],
  exports: [MapboxService, RazorpayService, RazorpayXService, HdfcPaymentService, CashfreeService, SmsService, FcmService, S3Service, RedisService, ExotelService],
})
export class ServicesModule {}
