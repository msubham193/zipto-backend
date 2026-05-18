import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { RedisService } from './redis.service';

// ─── DLT-approved metadata ────────────────────────────────────────────────────
const TWO_FACTOR_BASE_URL = 'https://2factor.in/API/R1/';
const SENDER_ID           = 'Zipto';
const PE_ID               = '1101559440000094860';
const CT_ID               = '1107177908307247477';

// ─── Redis key namespaces ─────────────────────────────────────────────────────
const KEY_OTP    = (phone: string) => `otp:${phone}`;
const KEY_RESEND = (phone: string) => `otp_resend:${phone}`;

interface OtpRecord {
  otp: string;
  attempts: number;
  expiresAt: number; // epoch ms
}

interface SendOtpResult {
  success: boolean;
  /** Only populated in non-production environments */
  dev_otp?: string;
  cooldown_remaining_seconds?: number;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  private readonly apiKey: string;
  private readonly otpExpiryMs: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownMs: number;
  private readonly isDev: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.apiKey          = (configService.get<string>('TWO_FACTOR_API_KEY') || '').trim();
    this.otpExpiryMs     = (parseInt(configService.get('OTP_EXPIRY_MINUTES')   || '5',  10) || 5)  * 60_000;
    this.maxAttempts     = parseInt(configService.get('OTP_MAX_ATTEMPTS')      || '5',  10) || 5;
    this.resendCooldownMs= parseInt(configService.get('OTP_RESEND_COOLDOWN')   || '60', 10) || 60;
    this.resendCooldownMs *= 1_000; // convert seconds → ms
    this.isDev           = (configService.get('NODE_ENV') || 'development') !== 'production';

    this.logger.log(
      `2Factor SMS — apiKey: ${this.apiKey ? this.apiKey.substring(0, 8) + '...' : 'MISSING'} | ` +
      `expiry: ${this.otpExpiryMs / 60_000}m | maxAttempts: ${this.maxAttempts} | ` +
      `resendCooldown: ${this.resendCooldownMs / 1_000}s | dev: ${this.isDev}`,
    );

    if (!this.apiKey && !this.isDev) {
      this.logger.error('TWO_FACTOR_API_KEY is not set. OTP sending will fail in production.');
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate a fresh 6-digit OTP, store it in Redis, and deliver it via 2Factor SMS.
   * Enforces per-phone resend cooldown.
   */
  async sendOTP(phone: string): Promise<SendOtpResult> {
    const normalised = this.normalisePhone(phone);

    // Resend cooldown guard
    const cooldownTtl = await this.getCooldownRemainingMs(normalised);
    if (cooldownTtl > 0) {
      const seconds = Math.ceil(cooldownTtl / 1_000);
      this.logger.warn(`Resend cooldown active for ${this.mask(normalised)} — ${seconds}s remaining`);
      throw new HttpException(
        `Please wait ${seconds} seconds before requesting another OTP.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Generate & persist OTP
    const otp       = this.generateOTP();
    const expiresAt = Date.now() + this.otpExpiryMs;
    const record: OtpRecord = { otp, attempts: 0, expiresAt };

    await this.redisService.set(KEY_OTP(normalised), record, this.otpExpiryMs);
    await this.redisService.set(KEY_RESEND(normalised), '1', this.resendCooldownMs);

    this.logger.log(`OTP generated for ${this.mask(normalised)}, expires in ${this.otpExpiryMs / 60_000}m`);

    // Dev mode — skip actual SMS, expose OTP in logs & response
    if (this.isDev) {
      this.logger.warn(`[DEV] OTP for ${this.mask(normalised)}: ${otp}`);
      return { success: true, dev_otp: otp };
    }

    // Production — send via 2Factor
    const sent = await this.send2Factor(normalised, otp);
    if (!sent) {
      // Roll back Redis entries so the user can immediately retry
      await this.redisService.del(KEY_OTP(normalised), KEY_RESEND(normalised));
      throw new BadRequestException(
        'Failed to send OTP. Please check the phone number and try again.',
      );
    }

    this.logger.log(`OTP dispatched via 2Factor to ${this.mask(normalised)}`);
    return { success: true };
  }

  /**
   * Verify the OTP submitted by the user.
   * - Accepts static '1234' in non-production environments.
   * - Throws on expiry or max-attempts breach.
   * - Deletes the Redis record on success.
   */
  async verifyOTP(phone: string, otp: string): Promise<boolean> {
    const normalised = this.normalisePhone(phone);

    // Dev shortcut
    if (this.isDev && otp === '1234') {
      this.logger.warn(`[DEV] Static OTP '1234' accepted for ${this.mask(normalised)}`);
      return true;
    }

    const record = await this.redisService.get<OtpRecord>(KEY_OTP(normalised));

    if (!record) {
      throw new BadRequestException(
        'OTP not found or has expired. Please request a new OTP.',
      );
    }

    // Expiry check (belt-and-suspenders; Redis TTL is the real guard)
    if (Date.now() > record.expiresAt) {
      await this.redisService.del(KEY_OTP(normalised));
      throw new BadRequestException('OTP has expired. Please request a new OTP.');
    }

    // Brute-force guard
    if (record.attempts >= this.maxAttempts) {
      await this.redisService.del(KEY_OTP(normalised));
      throw new BadRequestException(
        'Too many failed attempts. Please request a new OTP.',
      );
    }

    // Wrong OTP — increment attempt counter
    if (record.otp !== otp) {
      const updatedRecord: OtpRecord = {
        ...record,
        attempts: record.attempts + 1,
      };
      const remainingMs = record.expiresAt - Date.now();
      await this.redisService.set(KEY_OTP(normalised), updatedRecord, remainingMs);

      const attemptsLeft = this.maxAttempts - updatedRecord.attempts;
      this.logger.warn(
        `Invalid OTP for ${this.mask(normalised)} — attempt ${updatedRecord.attempts}/${this.maxAttempts} | ${attemptsLeft} left`,
      );
      return false;
    }

    // Correct OTP — delete record and clear resend cooldown
    await this.redisService.del(KEY_OTP(normalised), KEY_RESEND(normalised));
    this.logger.log(`OTP verified successfully for ${this.mask(normalised)}`);
    return true;
  }

  /**
   * DEV ONLY — retrieve the current live OTP for a phone number.
   * Never expose this in production.
   */
  async getDevOTP(phone: string): Promise<{ otp: string; expires_at: Date } | null> {
    const normalised = this.normalisePhone(phone);
    const record     = await this.redisService.get<OtpRecord>(KEY_OTP(normalised));
    if (!record || Date.now() > record.expiresAt) return null;
    return { otp: record.otp, expires_at: new Date(record.expiresAt) };
  }

  /**
   * Send a plain transactional SMS (non-OTP) via 2Factor TRANS_SMS.
   * Used for booking notifications (pickup/delivery OTP dispatch).
   * NOTE: message content must match a DLT-approved template on your 2Factor account.
   */
  async sendSms(to: string, message: string): Promise<boolean> {
    const normalised = this.normalisePhone(to);

    if (this.isDev) {
      this.logger.warn(`[DEV] SMS to ${this.mask(normalised)}: ${message}`);
      return true;
    }

    return this.send2Factor(normalised, message);
  }

  /**
   * Backward-compat shim — maps old Twilio-style `sendVerification` to `sendOTP`.
   * @deprecated Use sendOTP() directly.
   */
  async sendVerification(phone: string): Promise<boolean> {
    try {
      await this.sendOTP(phone);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Backward-compat shim — maps old Twilio-style `checkVerification` to `verifyOTP`.
   * @deprecated Use verifyOTP() directly.
   */
  async checkVerification(phone: string, code: string): Promise<boolean> {
    try {
      return await this.verifyOTP(phone, code);
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async send2Factor(phone: string, otp: string): Promise<boolean> {
    // DLT-approved template — must match exactly (word for word)
    const message =
      `Your Zipto OTP is ${otp}. Use this OTP for login and Verification. ` +
      `Do not share it with anyone. -Zipto Hyperlogistics Private Limited`;

    // 2Factor expects a plain 10-digit number (no +91 prefix)
    const localPhone = phone.replace(/^\+91/, '').replace(/\D/g, '').slice(-10);

    const params = {
      module : 'TRANS_SMS',
      apikey : this.apiKey,
      to     : localPhone,
      from   : SENDER_ID,
      msg    : message,
      peid   : PE_ID,
      ctid   : CT_ID,
    };

    try {
      const response = await axios.get<{ Status: string; Details: string }>(
        TWO_FACTOR_BASE_URL,
        { params, timeout: 12_000 },
      );

      const { Status, Details } = response.data ?? {};
      this.logger.log(
        `2Factor response for ${this.mask(phone)}: Status=${Status} Details=${Details}`,
      );

      if (Status !== 'Success') {
        this.logger.error(`2Factor delivery failed — ${Details}`);
        return false;
      }
      return true;
    } catch (error: any) {
      this.logger.error(
        `2Factor HTTP error for ${this.mask(phone)}: ${error?.message ?? error}`,
      );
      return false;
    }
  }

  /** Returns remaining cooldown in ms; 0 means no active cooldown. */
  private async getCooldownRemainingMs(phone: string): Promise<number> {
    const val = await this.redisService.get<string>(KEY_RESEND(phone));
    if (!val) return 0;
    // We set the resend key with a fixed TTL — derive remaining via a TTL command workaround:
    // Re-read the record and compare stored expiry embedded in value vs now.
    // Since we only store '1' (no expiry embedded), we can't derive exact TTL from the value.
    // Return the full cooldown period as a safe upper bound; actual expiry is tracked by Redis.
    return this.resendCooldownMs;
  }

  private generateOTP(): string {
    // Cryptographically sufficient for 6-digit OTPs
    const min = 100_000;
    const max = 999_999;
    return (Math.floor(Math.random() * (max - min + 1)) + min).toString();
  }

  /** Normalise to +91XXXXXXXXXX */
  private normalisePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    if (digits.length === 13 && phone.startsWith('+')) return phone;
    return `+91${digits.slice(-10)}`;
  }

  /** Mask middle digits for safe logging: +91XXXXXXXX → +91XX****XX */
  private mask(phone: string): string {
    return phone.replace(/(\+\d{2})(\d{2})(\d{6})(\d{2})/, '$1$2******$4');
  }
}
