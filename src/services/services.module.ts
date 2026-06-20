import { Module, Global } from '@nestjs/common';
import { MapboxService } from './mapbox.service';
import { RazorpayService } from './razorpay.service';
import { RazorpayXService } from './razorpayx.service';
import { HdfcPaymentService } from './hdfc-payment.service';
import { CashfreeService } from './cashfree.service';
import { CashfreePayoutService } from './cashfree-payout.service';
import { SmsService } from './sms.service';
import { FcmService } from './fcm.service';
import { S3Service } from './s3.service';
import { RedisService } from './redis.service';
import { ExotelService } from './exotel.service';
import { EmailService } from './email.service';

@Global()
@Module({
  providers: [MapboxService, RazorpayService, RazorpayXService, HdfcPaymentService, CashfreeService, CashfreePayoutService, SmsService, FcmService, S3Service, RedisService, ExotelService, EmailService],
  exports: [MapboxService, RazorpayService, RazorpayXService, HdfcPaymentService, CashfreeService, CashfreePayoutService, SmsService, FcmService, S3Service, RedisService, ExotelService, EmailService],
})
export class ServicesModule {}
