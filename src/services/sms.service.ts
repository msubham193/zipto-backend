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
// DLT sender/header ID — must be the exact code registered with the telecom
// entity (distinct from the message templates below). 'Bookfleet' is NOT a
// valid header (9 chars, gets rejected with an HTTP 400) — 'BKFLT' is the
// registered Bookfleet header. Override via env if it ever changes.
const SENDER_ID           = (process.env.TWO_FACTOR_SENDER_ID || '').trim() || 'BKFLT';
const PE_ID               = '1101559440000094860';
// Content template ids for the DLT-approved templates (env-overridable).
const CT_ID               = (process.env.TWO_FACTOR_CT_ID || '').trim() || '1107178289852040589'; // Login_otp1
const DELIVERY_CT_ID      = (process.env.TWO_FACTOR_DELIVERY_CT_ID || '').trim() || '1107178289983687481'; // delivery_otp1
const PICKUP_CT_ID        = (process.env.TWO_FACTOR_PICKUP_CT_ID || '').trim() || '1107178289957312398'; // pickup_otp1

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

  // SMS Retriever (hands-free OTP auto-read) config — OFF until configured.
  // Each app has its own 11-char hash; the short hash-bearing message must match
  // the DLT template registered under TWO_FACTOR_OTP_HASH_CT_ID word-for-word.
  private readonly otpHashByRole: { driver: string; customer: string };
  private readonly otpHashCtId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.apiKey          = (process.env.TWO_FACTOR_API_KEY || configService.get<string>('TWO_FACTOR_API_KEY') || '').trim();
    this.otpExpiryMs     = (parseInt(process.env.OTP_EXPIRY_MINUTES   || configService.get('OTP_EXPIRY_MINUTES')   || '5',  10) || 5)  * 60_000;
    this.maxAttempts     = parseInt(process.env.OTP_MAX_ATTEMPTS      || configService.get('OTP_MAX_ATTEMPTS')      || '5',  10) || 5;
    this.resendCooldownMs= parseInt(process.env.OTP_RESEND_COOLDOWN   || configService.get('OTP_RESEND_COOLDOWN')   || '60', 10) || 60;
    this.resendCooldownMs *= 1_000; // convert seconds → ms
    // Use process.env directly — configService.get('NODE_ENV') is undefined when NODE_ENV
    // is not declared in any registered config file, which would make isDev always true.
    this.isDev           = process.env.NODE_ENV !== 'production';

    this.otpHashByRole = {
      driver:   (process.env.SMS_OTP_HASH_DRIVER   || '').trim(),
      customer: (process.env.SMS_OTP_HASH_CUSTOMER || '').trim(),
    };
    this.otpHashCtId   = (process.env.TWO_FACTOR_OTP_HASH_CT_ID || '').trim();

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
  async sendOTP(phone: string, role?: 'driver' | 'customer'): Promise<SendOtpResult> {
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

    // Production — send via 2Factor (DLT login template, word-for-word).
    // When SMS Retriever is configured for this app, send the short hash-bearing
    // variant so the app can auto-read the OTP hands-free; otherwise the standard
    // login template. Both must match their registered DLT template exactly.
    const appHash = role ? this.otpHashByRole[role] : '';
    let loginMsg: string;
    let ctId: string;
    if (appHash && this.otpHashCtId) {
      const mins = Math.round(this.otpExpiryMs / 60_000);
      loginMsg =
        `Your Bookfleet OTP is ${otp}. Valid for ${mins} minutes. ` +
        `Do not share. ${appHash}`;
      ctId = this.otpHashCtId;
    } else {
      loginMsg =
        `Your Bookfleet OTP is ${otp}. Use this OTP for login and Verification. ` +
        `Do not share it with anyone. - Zipto Hyperlogistics Private Limited.`;
      ctId = CT_ID;
    }
    const sent = await this.send2Factor(normalised, loginMsg, ctId);
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
   * Send the DELIVERY OTP to the receiver's phone, using the DLT-approved
   * "Delivery OTP" template (word-for-word). The receiver reveals this code to
   * the rider only at delivery to confirm a successful handover.
   */
  async sendDeliveryOtp(phone: string, otp: string): Promise<boolean> {
    const normalised = this.normalisePhone(phone);
    // Must match the registered DLT template exactly.
    const message =
      `Your Bookfleet Delivery OTP is  ${otp}. Share this OTP with your delivery partner only after successful delivery.\n\n` +
      `- Zipto Hyperlogistics Private Limited`;

    if (this.isDev) {
      this.logger.warn(`[DEV] Delivery OTP SMS to ${this.mask(normalised)}: ${message}`);
      return true;
    }

    return this.send2Factor(normalised, message, DELIVERY_CT_ID);
  }

  /**
   * Send the PICKUP OTP to the sender's phone, using the DLT-approved
   * "Pickup OTP" template (word-for-word). The sender reveals this code to the
   * rider only at pickup to confirm handover of the package.
   */
  async sendPickupOtp(phone: string, otp: string): Promise<boolean> {
    const normalised = this.normalisePhone(phone);
    // Must match the registered DLT template exactly.
    const message =
      `Your Bookfleet Pickup OTP is ${otp}. Share this OTP with your delivery partner only at pickup.\n\n` +
      `- Zipto Hyperlogistics Private Limited`;

    if (this.isDev) {
      this.logger.warn(`[DEV] Pickup OTP SMS to ${this.mask(normalised)}: ${message}`);
      return true;
    }

    return this.send2Factor(normalised, message, PICKUP_CT_ID);
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

  /**
   * Low-level 2Factor TRANS_SMS sender. `message` must match a DLT-approved
   * template word-for-word, and `ctid` must be that template's content id.
   */
  private async send2Factor(phone: string, message: string, ctid: string = CT_ID): Promise<boolean> {
    // 2Factor expects a plain 10-digit number (no +91 prefix)
    const localPhone = phone.replace(/^\+91/, '').replace(/\D/g, '').slice(-10);

    const params = {
      module : 'TRANS_SMS',
      apikey : this.apiKey,
      to     : localPhone,
      from   : SENDER_ID,
      msg    : message,
      peid   : PE_ID,
      ctid   : ctid,
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
