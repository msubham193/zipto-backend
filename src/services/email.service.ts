import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { RedisService } from './redis.service';

// ─── Email OTP config ─────────────────────────────────────────────────────────
// OTPs for sensitive admin actions (password change, etc). Stored in Redis,
// scoped by purpose + email so two flows can't collide.
const OTP_TTL_MS         = 10 * 60_000; // 10 minutes
const OTP_MAX_ATTEMPTS   = 5;
const OTP_RESEND_COOLDOWN_MS = 60_000;  // 60s between sends

const KEY_OTP    = (purpose: string, email: string) => `email_otp:${purpose}:${email}`;
const KEY_RESEND = (purpose: string, email: string) => `email_otp_resend:${purpose}:${email}`;

interface EmailOtpRecord {
  otp: string;
  attempts: number;
  expiresAt: number; // epoch ms
}

export type OtpPurpose = 'password_change' | 'admin_verify' | 'password_reset';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly from: string;
  private readonly enabled: boolean;
  private readonly isDev: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    const smtp = this.configService.get<any>('externalServices.smtp') || {};
    this.from = smtp.from || 'Zipto <ride.zipto@gmail.com>';
    this.isDev = process.env.NODE_ENV !== 'production';
    this.enabled = Boolean(smtp.user && smtp.pass);

    if (this.enabled) {
      this.transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
      });
      this.logger.log(
        `SMTP configured — host=${smtp.host}:${smtp.port} secure=${smtp.secure} user=${smtp.user}`,
      );
    } else {
      this.logger.warn(
        'SMTP not configured (SMTP_USER / SMTP_PASS missing). Emails will be logged instead of sent.',
      );
    }
  }

  // ─── Low-level send ───────────────────────────────────────────────────────

  /**
   * Send a transactional email. In dev / when SMTP is unconfigured, the email
   * is logged instead of dispatched so flows still work end-to-end locally.
   */
  async sendMail(
    to: string,
    subject: string,
    html: string,
    text?: string,
    attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>,
  ): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(`[EMAIL:LOGGED] to=${to} subject="${subject}"${attachments?.length ? ` (+${attachments.length} attachment)` : ''}`);
      if (this.isDev) this.logger.debug(text || this.stripHtml(html));
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        html,
        text: text || this.stripHtml(html),
        ...(attachments?.length ? { attachments } : {}),
      });
      this.logger.log(`Email sent to ${this.maskEmail(to)} — "${subject}"`);
    } catch (err: any) {
      this.logger.error(`Failed to send email to ${this.maskEmail(to)}: ${err?.message ?? err}`);
      throw new BadRequestException('Could not send email. Please try again shortly.');
    }
  }

  // ─── Email OTP ────────────────────────────────────────────────────────────

  /**
   * Generate, store (Redis) and email a 6-digit OTP for a sensitive action.
   * Enforces a per-purpose+email resend cooldown.
   */
  async sendOtp(to: string, name: string, purpose: OtpPurpose): Promise<void> {
    const email = this.normaliseEmail(to);

    const onCooldown = await this.redisService.get<string>(KEY_RESEND(purpose, email));
    if (onCooldown) {
      throw new HttpException(
        'Please wait a minute before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const otp = this.generateOtp();
    const record: EmailOtpRecord = { otp, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS };
    await this.redisService.set(KEY_OTP(purpose, email), record, OTP_TTL_MS);
    await this.redisService.set(KEY_RESEND(purpose, email), '1', OTP_RESEND_COOLDOWN_MS);

    const { subject, intro } = this.otpCopy(purpose);
    await this.sendMail(email, subject, this.otpTemplate(name, otp, intro));

    if (this.isDev) this.logger.warn(`[DEV] ${purpose} OTP for ${this.maskEmail(email)}: ${otp}`);
  }

  /**
   * Verify an OTP. Deletes the record on success; counts attempts and throws
   * on expiry / exhaustion so the caller surfaces a clear error.
   */
  async verifyOtp(to: string, purpose: OtpPurpose, code: string): Promise<boolean> {
    const email = this.normaliseEmail(to);
    const record = await this.redisService.get<EmailOtpRecord>(KEY_OTP(purpose, email));

    if (!record) {
      throw new BadRequestException('Code not found or expired. Please request a new one.');
    }
    if (Date.now() > record.expiresAt) {
      await this.redisService.del(KEY_OTP(purpose, email));
      throw new BadRequestException('Code expired. Please request a new one.');
    }
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await this.redisService.del(KEY_OTP(purpose, email));
      throw new BadRequestException('Too many incorrect attempts. Please request a new code.');
    }
    if (record.otp !== code) {
      const remainingMs = record.expiresAt - Date.now();
      await this.redisService.set(
        KEY_OTP(purpose, email),
        { ...record, attempts: record.attempts + 1 },
        remainingMs,
      );
      return false;
    }

    await this.redisService.del(KEY_OTP(purpose, email), KEY_RESEND(purpose, email));
    return true;
  }

  // ─── Higher-level emails ────────────────────────────────────────────────────

  /** Welcome email to a newly-created admin, carrying their temporary password. */
  async sendAdminInvite(
    to: string,
    name: string,
    tempPassword: string,
    invitedBy: string,
  ): Promise<void> {
    const panelUrl = this.configService.get<string>('externalServices.admin.panelUrl')
      || 'https://admin.ridezipto.com';

    const body = `
      <p style="margin:0 0 16px">Hi ${this.esc(name)},</p>
      <p style="margin:0 0 16px">
        ${this.esc(invitedBy)} has created an administrator account for you on the
        <strong>Zipto Admin Panel</strong>. Use the temporary password below to sign in.
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin:0 0 16px">
        <div style="font-size:13px;color:#64748b;margin-bottom:6px">Your login email</div>
        <div style="font-size:16px;font-weight:600;color:#0f172a;margin-bottom:14px">${this.esc(to)}</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:6px">Temporary password</div>
        <div style="font-size:22px;font-weight:700;letter-spacing:1px;color:#0f172a;font-family:monospace">${this.esc(tempPassword)}</div>
      </div>
      <p style="margin:0 0 24px">
        For your security you'll be asked to set a new password (verified with an email code)
        the first time you sign in.
      </p>
      <a href="${panelUrl}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;
        padding:12px 28px;border-radius:10px;font-weight:600;font-size:15px">Sign in to Admin Panel</a>
      <p style="margin:24px 0 0;font-size:13px;color:#64748b">
        If you weren't expecting this email, please ignore it or contact your administrator.
      </p>`;

    await this.sendMail(to, 'Your Zipto Admin account is ready', this.shell('Welcome to Zipto Admin', body));
  }

  /** Sent to a driver when the admin APPROVES their KYC. */
  async sendDriverApproved(to: string, name: string): Promise<void> {
    const body = `
      <p style="margin:0 0 16px">Hi ${this.esc(name || 'there')},</p>
      <p style="margin:0 0 16px">
        Great news — your Zipto delivery-partner application has been
        <strong>approved</strong>! Your profile and vehicle have been verified by our team.
      </p>
      <p style="margin:0 0 16px">
        You can now open the <strong>Zipto Partner</strong> app, go online, and start
        accepting delivery requests. Welcome to the Zipto fleet 🚀
      </p>
      <p style="margin:24px 0 0;font-size:13px;color:#64748b">
        Questions? Just reply to this email or contact support.
      </p>`;
    await this.sendMail(
      to,
      'Your Zipto partner account is approved 🎉',
      this.shell('Application Approved', body),
    );
  }

  /** Sent to a driver when the admin REJECTS their KYC (with an optional reason). */
  async sendDriverRejected(to: string, name: string, reason?: string): Promise<void> {
    const cleanReason = (reason || '').trim();
    const reasonBlock = cleanReason
      ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;margin:0 0 16px">
           <div style="font-size:13px;color:#b91c1c;margin-bottom:6px;font-weight:600">Reason</div>
           <div style="font-size:15px;color:#7f1d1d">${this.esc(cleanReason)}</div>
         </div>`
      : '';
    const body = `
      <p style="margin:0 0 16px">Hi ${this.esc(name || 'there')},</p>
      <p style="margin:0 0 16px">
        Thank you for applying to become a Zipto delivery partner. Unfortunately your
        application could not be approved at this time.
      </p>
      ${reasonBlock}
      <p style="margin:0 0 16px">
        You can correct the issue and re-submit directly in the <strong>Zipto Partner</strong>
        app — open it and tap <strong>Re-upload Documents</strong> on the verification screen.
        Our team will review your updated application.
      </p>
      <p style="margin:24px 0 0;font-size:13px;color:#64748b">
        If you believe this was a mistake, reply to this email or contact support.
      </p>`;
    await this.sendMail(
      to,
      'Update on your Zipto partner application',
      this.shell('Application Update', body),
    );
  }

  /** Sent to a driver when the admin SUSPENDS their account (with optional reason). */
  async sendDriverSuspended(to: string, name: string, reason?: string): Promise<void> {
    const cleanReason = (reason || '').trim();
    const reasonBlock = cleanReason
      ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;margin:0 0 16px">
           <div style="font-size:13px;color:#b91c1c;margin-bottom:6px;font-weight:600">Reason</div>
           <div style="font-size:15px;color:#7f1d1d">${this.esc(cleanReason)}</div>
         </div>`
      : '';
    const body = `
      <p style="margin:0 0 16px">Hi ${this.esc(name || 'there')},</p>
      <p style="margin:0 0 16px">
        Your <strong>Zipto Partner</strong> account has been <strong>suspended</strong> by our team,
        so you won't be able to go online or accept deliveries for now.
      </p>
      ${reasonBlock}
      <p style="margin:0 0 16px">
        If you think this is a mistake or want to appeal, please reply to this email or
        contact Zipto support and we'll review your account.
      </p>`;
    await this.sendMail(
      to,
      'Your Zipto partner account has been suspended',
      this.shell('Account Suspended', body),
    );
  }

  // ─── Templates ──────────────────────────────────────────────────────────────

  private otpCopy(purpose: OtpPurpose): { subject: string; intro: string } {
    switch (purpose) {
      case 'password_change':
        return {
          subject: 'Your Zipto password change code',
          intro: 'Use the code below to confirm your password change. It expires in 10 minutes.',
        };
      case 'admin_verify':
        return {
          subject: 'Verify your Zipto Admin email',
          intro: 'Use the code below to verify your email address. It expires in 10 minutes.',
        };
      case 'password_reset':
        return {
          subject: 'Reset your Zipto Admin password',
          intro: 'Use the code below to reset your admin password. It expires in 10 minutes.',
        };
    }
  }

  private otpTemplate(name: string, otp: string, intro: string): string {
    const body = `
      <p style="margin:0 0 16px">Hi ${this.esc(name || 'there')},</p>
      <p style="margin:0 0 20px">${this.esc(intro)}</p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:22px;text-align:center;margin:0 0 20px">
        <div style="font-size:13px;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px">Verification code</div>
        <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#0f172a;font-family:monospace">${this.esc(otp)}</div>
      </div>
      <p style="margin:0;font-size:13px;color:#64748b">
        Never share this code with anyone — Zipto staff will never ask for it.
        If you didn't request this, you can safely ignore this email.
      </p>`;
    return this.shell('Verification code', body);
  }

  /** Shared branded wrapper for all emails. */
  private shell(title: string, innerHtml: string): string {
    return `<!doctype html>
<html>
  <body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
    <div style="max-width:520px;margin:0 auto;padding:32px 16px">
      <div style="text-align:center;margin-bottom:24px">
        <span style="font-size:24px;font-weight:800;color:#16a34a;letter-spacing:-0.5px">ZIPTO</span>
      </div>
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:32px">
        <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#0f172a">${this.esc(title)}</h1>
        ${innerHtml}
      </div>
      <p style="text-align:center;margin:20px 0 0;font-size:12px;color:#94a3b8">
        © ${new Date().getFullYear()} Zipto Hyperlogistics Pvt. Ltd. · This is an automated message.
      </p>
    </div>
  </body>
</html>`;
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private generateOtp(): string {
    return (Math.floor(Math.random() * 900_000) + 100_000).toString();
  }

  private normaliseEmail(email: string): string {
    return (email || '').trim().toLowerCase();
  }

  private esc(s: string): string {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private maskEmail(email: string): string {
    const [u, d] = (email || '').split('@');
    if (!d) return email;
    const head = u.length <= 2 ? u[0] || '' : u.slice(0, 2);
    return `${head}***@${d}`;
  }
}
