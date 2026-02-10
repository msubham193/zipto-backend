import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const twilio = require('twilio');

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client: any;
  private readonly verifyServiceSid: string;

  constructor(private configService: ConfigService) {
    const accountSid =
      this.configService.get<string>('externalServices.twilio.accountSid') ||
      '';
    const authToken =
      this.configService.get<string>('externalServices.twilio.authToken') || '';
    this.verifyServiceSid =
      this.configService.get<string>(
        'externalServices.twilio.verifyServiceSid',
      ) || '';

    this.client = twilio(accountSid, authToken);
  }

  /**
   * Send OTP via Twilio Verify
   */
  async sendVerification(phone: string): Promise<boolean> {
    if (!this.verifyServiceSid) {
      this.logger.warn(
        `Twilio Verify not configured. Phone: ${phone}`,
      );
      return false;
    }

    try {
      const verification = await this.client.verify.v2
        .services(this.verifyServiceSid)
        .verifications.create({ to: phone, channel: 'sms' });

      this.logger.log(
        `OTP sent to ${phone} - status: ${verification.status}`,
      );
      return verification.status === 'pending';
    } catch (error: unknown) {
      const msg = (error as Error)?.message || error;
      this.logger.error(`Twilio send verification failed: ${msg}`);
      return false;
    }
  }

  /**
   * Verify OTP via Twilio Verify
   */
  async checkVerification(phone: string, code: string): Promise<boolean> {
    if (!this.verifyServiceSid) {
      this.logger.warn('Twilio Verify not configured');
      return false;
    }

    try {
      const check = await this.client.verify.v2
        .services(this.verifyServiceSid)
        .verificationChecks.create({ to: phone, code });

      this.logger.log(
        `OTP check for ${phone} - status: ${check.status}`,
      );
      return check.status === 'approved';
    } catch (error: unknown) {
      const msg = (error as Error)?.message || error;
      this.logger.error(`Twilio check verification failed: ${msg}`);
      return false;
    }
  }
}
