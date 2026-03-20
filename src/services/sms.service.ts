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
    const accountSid = (this.configService.get<string>('externalServices.twilio.accountSid') || '').trim();
    const authToken = (this.configService.get<string>('externalServices.twilio.authToken') || '').trim();
    this.verifyServiceSid =
      (this.configService.get<string>('externalServices.twilio.verifyServiceSid') || '').trim();

    this.logger.log(
      `Twilio config — accountSid: ${accountSid ? accountSid.substring(0, 10) + '...' : 'MISSING'} (len=${accountSid.length}), authToken len=${authToken.length}, verifyServiceSid: ${this.verifyServiceSid || 'MISSING'}`,
    );
    this.client = twilio(accountSid, authToken);
  }

  /**
   * Send a plain SMS message via Twilio Messaging
   */
  async sendSms(to: string, message: string): Promise<boolean> {
    const fromNumber = this.configService.get<string>('externalServices.twilio.fromNumber') || '';
    if (!fromNumber) {
      this.logger.warn(`Twilio fromNumber not configured. Cannot send SMS to ${to}`);
      return false;
    }

    // Ensure E.164 format for Indian numbers
    const formattedTo = to.startsWith('+') ? to : `+91${to.replace(/\D/g, '').slice(-10)}`;

    try {
      const msg = await this.client.messages.create({
        body: message,
        from: fromNumber,
        to: formattedTo,
      });
      this.logger.log(`SMS sent to ${formattedTo} - SID: ${msg.sid}`);
      return true;
    } catch (error: unknown) {
      const msg = (error as Error)?.message || JSON.stringify(error);
      this.logger.error(`Twilio sendSms failed to ${formattedTo}: ${msg}`);
      return false;
    }
  }

  /**
   * Send OTP via Twilio Verify.
   * In development mode, skips Twilio and returns true immediately
   * (use the static dev OTP "1234" to verify).
   */
  async sendVerification(phone: string): Promise<boolean> {
    this.logger.log(
      `sendVerification called - phone: ${phone}, serviceSid: ${this.verifyServiceSid}`,
    );

    if (!this.verifyServiceSid) {
      this.logger.warn(`Twilio Verify not configured. Phone: ${phone}`);
      return false;
    }

    try {
      const verification = await this.client.verify.v2
        .services(this.verifyServiceSid)
        .verifications.create({ to: phone, channel: 'sms' });

      this.logger.log(`OTP sent to ${phone} - status: ${verification.status}`);
      return verification.status === 'pending';
    } catch (error: unknown) {
      const msg = (error as Error)?.message || JSON.stringify(error);
      const code = (error as any)?.code;
      const status = (error as any)?.status;
      this.logger.error(
        `Twilio send verification failed - code: ${code}, status: ${status}, message: ${msg}`,
      );
      return false;
    }
  }

  /**
   * Verify OTP via Twilio Verify.
   * In development mode, accepts the static dev OTP "1234".
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

      this.logger.log(`OTP check for ${phone} - status: ${check.status}`);
      return check.status === 'approved';
    } catch (error: unknown) {
      const msg = (error as Error)?.message || error;
      this.logger.error(`Twilio check verification failed: ${msg}`);
      return false;
    }
  }
}
