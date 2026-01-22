import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly provider: string;
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly route: string;

  constructor(private configService: ConfigService) {
    this.provider = this.configService.get<string>('externalServices.sms.provider') || 'msg91';
    this.apiKey = this.configService.get<string>('externalServices.sms.apiKey') || '';
    this.senderId = this.configService.get<string>('externalServices.sms.senderId') || 'SKIDO';
    this.route = this.configService.get<string>('externalServices.sms.route') || '4';
  }

  /**
   * Send OTP via SMS
   */
  async sendOTP(phone: string, otp: string): Promise<boolean> {
    // Format phone number (remove +91 if present)
    const formattedPhone = phone.replace(/^\+91/, '');

    if (!this.apiKey) {
      this.logger.warn(`OTP not sent (SMS API not configured). Phone: ${formattedPhone}, OTP: ${otp}`);
      this.logger.log(`[MOCK SMS] Sending OTP ${otp} to ${formattedPhone}`);
      return true; // Mock success
    }

    try {
      if (this.provider === 'msg91') {
        return await this.sendMSG91OTP(formattedPhone, otp);
      } else {
        this.logger.warn(`Unknown SMS provider: ${this.provider}`);
        return false;
      }
    } catch (error: any) {
      this.logger.error(`SMS sending failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send OTP using MSG91 API
   */
  private async sendMSG91OTP(phone: string, otp: string): Promise<boolean> {
    try {
      const message = `Your SkiDO OTP is ${otp}. Valid for 10 minutes. Do not share with anyone.`;

      const response = await axios.get('https://api.msg91.com/api/sendhttp.php', {
        params: {
          authkey: this.apiKey,
          mobiles: phone,
          message,
          sender: this.senderId,
          route: this.route,
          country: '91',
        },
      });

      if (response.data.type === 'success') {
        this.logger.log(`OTP sent successfully via MSG91 to ${phone}`);
        return true;
      } else {
        this.logger.error(`MSG91 API error: ${response.data.message}`);
        return false;
      }
    } catch (error: any) {
      this.logger.error(`MSG91 request failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send custom SMS
   */
  async sendSMS(phone: string, message: string): Promise<boolean> {
    const formattedPhone = phone.replace(/^\+91/, '');

    if (!this.apiKey) {
      this.logger.log(`[MOCK SMS] Sending to ${formattedPhone}: ${message}`);
      return true;
    }

    try {
      if (this.provider === 'msg91') {
        const response = await axios.get('https://api.msg91.com/api/sendhttp.php', {
          params: {
            authkey: this.apiKey,
            mobiles: formattedPhone,
            message,
            sender: this.senderId,
            route: this.route,
            country: '91',
          },
        });

        return response.data.type === 'success';
      }

      return false;
    } catch (error: any) {
      this.logger.error(`SMS sending failed: ${error.message}`);
      return false;
    }
  }
}
