import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User, UserRole } from './entities/user.entity';
import { OTP } from './entities/otp.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  RegisterDto,
  VerifyOtpDto,
  LoginDto,
  AdminLoginDto,
  RefreshTokenDto,
  CustomerEmailLoginDto,
  CustomerEmailRegisterDto,
  DriverEmailLoginDto,
  DriverEmailRegisterDto,
  DeleteAccountDto,
} from './dto/auth.dto';
import { formatPhoneNumber, generateRandomUsername } from '../../common/utils/helpers.util';
import { SmsService } from '../../services/sms.service';
import { EmailService } from '../../services/email.service';
import { DriverProfile, AvailabilityStatus, VerificationStatus } from '../driver/entities/driver-profile.entity';
import { ReferralService } from '../referral/referral.service';
import { S3Service } from '../../services/s3.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(OTP)
    private readonly otpRepository: Repository<OTP>,
    @InjectRepository(DriverProfile)
    private readonly driverProfileRepository: Repository<DriverProfile>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly smsService: SmsService,
    private readonly emailService: EmailService,
    private readonly referralService: ReferralService,
    private readonly s3Service: S3Service,
  ) {}

  // ─── OTP Send Flows ──────────────────────────────────────────────────────────

  /**
   * Register a new driver — throws ConflictException if phone already registered.
   */
  async registerDriver(registerDto: RegisterDto) {
    const { phone } = registerDto;
    const formattedPhone = formatPhoneNumber(phone);

    const existingUser = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    if (existingUser) {
      if (!existingUser.is_active) {
        throw new UnauthorizedException('User account is deactivated');
      }
      throw new ConflictException(
        'An account with this number already exists. Please login instead.',
      );
    }

    await this.smsService.sendOTP(formattedPhone, 'driver');

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      isNewUser: true,
      expiresIn: `${process.env.OTP_EXPIRY_MINUTES ?? 5} minutes`,
    };
  }

  /**
   * Whether logging in as `requestedRole` would switch an existing account's
   * role (e.g. a Rider's number used on the Customer app). Admins are never
   * switchable via OTP. Returns the flag + the account's current role so the
   * client can ask the user to confirm before they get signed out of the
   * other app.
   */
  /** Map a UserRole to the SMS app bucket used to pick the OTP auto-read hash. */
  private smsRoleOf(role?: UserRole): 'driver' | 'customer' | undefined {
    if (role === UserRole.DRIVER) return 'driver';
    if (role === UserRole.CUSTOMER) return 'customer';
    return undefined;
  }

  private roleSwitchInfo(existingUser: User | null, requestedRole?: UserRole) {
    const requires =
      !!existingUser &&
      !!requestedRole &&
      existingUser.role !== requestedRole &&
      existingUser.role !== UserRole.ADMIN;
    return {
      requires_role_switch: requires,
      existing_role: requires ? existingUser!.role : undefined,
    };
  }

  /**
   * Register or login — send OTP (auto-detects new vs returning user).
   */
  async register(registerDto: RegisterDto) {
    const { phone } = registerDto;
    const formattedPhone = formatPhoneNumber(phone);

    const existingUser = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    if (existingUser && !existingUser.is_active) {
      throw new UnauthorizedException('User account is deactivated');
    }

    await this.smsService.sendOTP(formattedPhone, this.smsRoleOf(registerDto.role as UserRole | undefined));

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      isNewUser: !existingUser,
      expiresIn: `${process.env.OTP_EXPIRY_MINUTES ?? 5} minutes`,
      ...this.roleSwitchInfo(existingUser, registerDto.role as UserRole | undefined),
    };
  }

  /**
   * Login with phone — sends OTP. `requestedRole` is the role of the app the
   * user is logging in from (customer/driver), used to detect a role switch.
   */
  async login(loginDto: LoginDto, requestedRole?: UserRole) {
    const { phone } = loginDto;
    const formattedPhone = formatPhoneNumber(phone);

    const existingUser = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    if (existingUser && !existingUser.is_active) {
      throw new UnauthorizedException('User account is deactivated');
    }

    await this.smsService.sendOTP(formattedPhone, this.smsRoleOf(requestedRole));

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      isNewUser: !existingUser,
      expiresIn: `${process.env.OTP_EXPIRY_MINUTES ?? 5} minutes`,
      ...this.roleSwitchInfo(existingUser, requestedRole),
    };
  }

  // ─── OTP Verify ──────────────────────────────────────────────────────────────

  /**
   * Verify OTP and complete registration or login.
   * Fully Redis-backed — no DB OTP table involved.
   */
  async verifyOtp(verifyOtpDto: VerifyOtpDto) {
    const { phone, otp, role, referral_code, device_id, confirm_switch } = verifyOtpDto;
    const formattedPhone = formatPhoneNumber(phone);

    this.logger.log(`[verifyOtp] phone=${this.mask(formattedPhone)}`);

    // Demo/review accounts (Play Store & Cashfree app reviewers): the real OTP is
    // still sent, but a fixed code also logs them in. Config-driven via env, with
    // the known review numbers as a fallback. Keep this list tiny — anyone with the
    // number + demo code can sign in as that account.
    const demoPhones = (process.env.DEMO_LOGIN_PHONES || '6371171553,7735416582')
      .split(',')
      .map((p) => formatPhoneNumber(p.trim()))
      .filter(Boolean);
    const demoOtp = process.env.DEMO_LOGIN_OTP || '123456';
    const isDemoLogin = demoPhones.includes(formattedPhone) && otp === demoOtp;

    // Demo code short-circuits; the real OTP still validates normally otherwise.
    const isValid = isDemoLogin || (await this.smsService.verifyOTP(formattedPhone, otp));
    if (!isValid) {
      throw new BadRequestException('Invalid OTP. Please check the code and try again.');
    }
    if (isDemoLogin) {
      this.logger.log(`[verifyOtp] demo login accepted for ${this.mask(formattedPhone)}`);
    }

    // Find or create user
    let user = await this.userRepository.findOne({ where: { phone: formattedPhone } });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const userName    = generateRandomUsername();
      const assignedRole = role || UserRole.CUSTOMER;

      user = this.userRepository.create({
        phone: formattedPhone,
        name: userName,
        role: assignedRole,
        is_profile_complete: false,
        // Drivers are NOT auto-verified — admin verifies after onboarding
        is_verified: assignedRole !== UserRole.DRIVER,
      });

      await this.userRepository.save(user);
      this.logger.log(`New user registered: ${user.id} (${assignedRole})`);

      // Apply referral code for brand-new customers (best-effort, never blocks signup).
      if (assignedRole === UserRole.CUSTOMER && referral_code) {
        await this.referralService.applyCodeSafe(user.id, referral_code, device_id);
      }
    } else {
      if (!user.is_active) {
        throw new UnauthorizedException('User account is deactivated');
      }

      const previousRole = user.role;

      // Cross-role login: this number belongs to a different role than the app
      // requesting login (e.g. a Rider's number used on the Customer app).
      // Require explicit consent — confirming switches the active role and
      // signs the user out of the other app (its session is rotated below).
      if (role && user.role !== role && user.role !== UserRole.ADMIN) {
        if (!confirm_switch) {
          throw new ConflictException({
            message:
              `This number is registered as a ${this.roleLabel(user.role)}. ` +
              `Continue and you'll be signed out of the ${this.roleLabel(user.role)} app.`,
            code: 'ROLE_SWITCH_REQUIRED',
            existing_role: user.role,
          });
        }
        // Consent given — switch the active role. Both identities are preserved
        // (the driver profile, keyed by user_id, is NOT deleted), so the user
        // can switch back later from the other app.
        user.role = role as UserRole;
        // Explicitly sign the account out of every existing session (the other
        // app's included) — this is the one case where killing other sessions
        // is intentional, not a side effect of a generic login.
        await this.revokeAllSessions(user.id);
      }

      // Verification: customers are always verified; a driver is only verified
      // once their KYC is approved — never auto-verify a fresh role switch.
      if (user.role !== UserRole.DRIVER) {
        user.is_verified = true;
      } else if (previousRole !== UserRole.DRIVER) {
        const profile = await this.driverProfileRepository.findOne({ where: { user_id: user.id } });
        user.is_verified = profile?.verification_status === VerificationStatus.APPROVED;
      }

      await this.userRepository.save(user);

      // Switching AWAY from driver → take them offline so they stop receiving
      // ride offers while they use the customer side.
      if (previousRole === UserRole.DRIVER && user.role !== UserRole.DRIVER) {
        await this.driverProfileRepository.update(
          { user_id: user.id },
          { availability_status: AvailabilityStatus.OFFLINE },
        );
      }
    }

    // Force drivers offline on every login
    if (user.role === UserRole.DRIVER) {
      await this.driverProfileRepository.update(
        { user_id: user.id },
        { availability_status: AvailabilityStatus.OFFLINE },
      );
    }

    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      is_new_user: isNewUser,
      ...tokens,
    };
  }

  // ─── Resend OTP ──────────────────────────────────────────────────────────────

  async resendOtp(phone: string) {
    const formattedPhone = formatPhoneNumber(phone);

    const user = await this.userRepository.findOne({ where: { phone: formattedPhone } });
    if (user && !user.is_active) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // SmsService enforces resend cooldown — throws TooManyRequestsException if too soon
    await this.smsService.sendOTP(formattedPhone, this.smsRoleOf(user?.role));

    return {
      message: 'OTP resent successfully',
      phone: formattedPhone,
      expiresIn: `${process.env.OTP_EXPIRY_MINUTES ?? 5} minutes`,
    };
  }

  // ─── DEV helper ──────────────────────────────────────────────────────────────

  /**
   * DEV ONLY — return the current OTP stored in Redis for a phone number.
   */
  async getDevOtp(phone: string): Promise<{ otp: string; expires_at: Date }> {
    const formattedPhone = formatPhoneNumber(phone);
    const result = await this.smsService.getDevOTP(formattedPhone);

    if (!result) {
      throw new BadRequestException(
        'No valid OTP found for this number. Request a new OTP first.',
      );
    }

    return result;
  }

  // ─── Admin / Email auth ──────────────────────────────────────────────────────

  async adminLogin(adminLoginDto: AdminLoginDto) {
    const { email, password } = adminLoginDto;

    const user = await this.userRepository.findOne({
      where: { email, role: UserRole.ADMIN },
    });

    if (!user || !user.password_hash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) throw new UnauthorizedException('Invalid credentials');
    if (!user.is_active)  throw new UnauthorizedException('Account is deactivated');

    const tokens = await this.generateTokens(user);
    return { user: this.sanitizeUser(user), ...tokens };
  }

  /**
   * Customer email/password login (temporary — kept for backward compatibility
   * until all clients migrate to OTP flow).
   */
  async customerEmailLogin(dto: CustomerEmailLoginDto) {
    const { email, password } = dto;

    const user = await this.userRepository.findOne({
      where: { email, role: UserRole.CUSTOMER },
    });

    if (!user || !user.password_hash) throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) throw new UnauthorizedException('Invalid credentials');
    if (!user.is_active)  throw new UnauthorizedException('Account is deactivated');

    const tokens = await this.generateTokens(user);
    return { user: this.sanitizeUser(user), is_new_user: false, ...tokens };
  }

  /** Customer email/password registration (temporary). */
  async customerEmailRegister(dto: CustomerEmailRegisterDto) {
    const { email, password, name, referral_code, device_id } = dto;

    const existingUser = await this.userRepository.findOne({ where: { email } });
    if (existingUser) throw new ConflictException('An account with this email already exists.');

    const passwordHash = await bcrypt.hash(password, 10);
    const user = this.userRepository.create({
      email,
      name,
      password_hash: passwordHash,
      role: UserRole.CUSTOMER,
      is_verified: true,
      is_profile_complete: false,
    });

    await this.userRepository.save(user);

    // Apply referral code (best-effort, never blocks signup).
    if (referral_code) {
      await this.referralService.applyCodeSafe(user.id, referral_code, device_id);
    }

    const tokens = await this.generateTokens(user);
    return { user: this.sanitizeUser(user), is_new_user: true, ...tokens };
  }

  /** Driver email/password login (temporary). */
  async driverEmailLogin(dto: DriverEmailLoginDto) {
    const { email, password } = dto;

    const user = await this.userRepository.findOne({
      where: { email, role: UserRole.DRIVER },
    });

    if (!user || !user.password_hash) throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) throw new UnauthorizedException('Invalid credentials');
    if (!user.is_active)  throw new UnauthorizedException('Account is deactivated');

    await this.driverProfileRepository.update(
      { user_id: user.id },
      { availability_status: AvailabilityStatus.OFFLINE },
    );

    const tokens = await this.generateTokens(user);
    return { user: this.sanitizeUser(user), is_new_user: false, ...tokens };
  }

  /** Driver email/password registration (temporary). */
  async driverEmailRegister(dto: DriverEmailRegisterDto) {
    const { email, password, name } = dto;

    const existingUser = await this.userRepository.findOne({ where: { email } });
    if (existingUser) throw new ConflictException('An account with this email already exists.');

    const passwordHash = await bcrypt.hash(password, 10);
    const user = this.userRepository.create({
      email,
      name,
      password_hash: passwordHash,
      role: UserRole.DRIVER,
      is_verified: false,
      is_profile_complete: false,
    });

    await this.userRepository.save(user);

    const driverProfile = this.driverProfileRepository.create({
      user_id: user.id,
      verification_status: VerificationStatus.PENDING,
      availability_status: AvailabilityStatus.OFFLINE,
    });
    await this.driverProfileRepository.save(driverProfile);

    const tokens = await this.generateTokens(user);
    return { user: this.sanitizeUser(user), is_new_user: true, ...tokens };
  }

  // ─── Account Management ──────────────────────────────────────────────────────

  /**
   * Self-service account deletion for the authenticated user.
   *
   * Soft-deletes + anonymizes rather than hard-deleting: bookings, payments and
   * the transaction ledger reference this user and must be retained for
   * accounting/legal, so we scrub all PII, free the phone/email for re-use, and
   * mark the account deleted + inactive (which immediately invalidates any live
   * JWT, since JwtStrategy requires is_active=true). Driver KYC documents are
   * purged from R2. Blocked while a booking is in flight.
   */
  async deleteAccount(userId: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Account not found');
    if (user.is_deleted) return { message: 'Account already deleted' };

    // Block deletion while a trip is active (money/delivery in flight).
    const active: unknown[] = await this.userRepository.manager.query(
      `SELECT 1 FROM bookings
        WHERE (customer_id = $1 OR driver_id = $1)
          AND status IN ('pending','accepted','driver_assigned','ongoing')
        LIMIT 1`,
      [userId],
    );
    if (active.length) {
      throw new BadRequestException(
        'You have an active booking. Please complete or cancel it before deleting your account.',
      );
    }

    const originalPhone = user.phone;

    // Driver: purge KYC documents from R2 (best-effort) and scrub the profile.
    if (user.role === UserRole.DRIVER) {
      const profile = await this.driverProfileRepository.findOne({ where: { user_id: userId } });
      if (profile) {
        for (const ref of [
          profile.aadhar_front_image,
          profile.aadhar_back_image,
          profile.driving_license_image,
          profile.vehicle_rc_image,
          profile.profile_image,
        ]) {
          if (ref) await this.s3Service.deleteFile(ref).catch(() => {});
        }
        await this.driverProfileRepository.manager.query(
          `UPDATE driver_profiles
              SET availability_status = 'offline', license_number = NULL,
                  aadhar_front_image = NULL, aadhar_back_image = NULL,
                  driving_license_image = NULL, vehicle_rc_image = NULL, profile_image = NULL
            WHERE user_id = $1`,
          [userId],
        );
      }
    }

    // Customer: scrub saved locations / address PII (best-effort).
    await this.userRepository.manager
      .query(
        `UPDATE customer_profiles SET saved_locations = '[]'::jsonb, address = NULL WHERE user_id = $1`,
        [userId],
      )
      .catch(() => {});

    // Invalidate any pending OTPs for the freed number.
    if (originalPhone) await this.otpRepository.delete({ phone: originalPhone });

    // Anonymize the account: scrub PII, free phone/email/referral_code so the
    // person can sign up fresh later, kill sessions, and mark deleted+inactive.
    await this.userRepository.manager.query(
      `UPDATE users
          SET is_deleted = true, deleted_at = now(), is_active = false,
              phone = NULL, email = NULL, name = 'Deleted User',
              password_hash = NULL, fcm_token = NULL, refresh_token = NULL,
              referral_code = NULL
        WHERE id = $1`,
      [userId],
    );

    this.logger.log(`[deleteAccount] account ${userId} deleted & anonymized`);
    return { message: 'Account deleted successfully' };
  }

  /**
   * Update the authenticated user's own profile (name / phone / email).
   * Email changes are guarded for uniqueness so an admin can't collide with
   * another account.
   */
  async updateProfile(
    userId: string,
    dto: { name?: string; email?: string; phone?: string },
  ) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (dto.email && dto.email.trim().toLowerCase() !== (user.email || '').toLowerCase()) {
      const email = dto.email.trim().toLowerCase();
      const exists = await this.userRepository.findOne({ where: { email } });
      if (exists && exists.id !== userId) {
        throw new ConflictException('That email is already in use by another account.');
      }
      user.email = email;
    }
    if (typeof dto.name === 'string' && dto.name.trim()) {
      user.name = dto.name.trim();
    }
    if (typeof dto.phone === 'string' && dto.phone.trim()) {
      user.phone = dto.phone.trim();
    }

    await this.userRepository.save(user);
    return this.sanitizeUser(user);
  }

  async refreshToken(refreshTokenDto: RefreshTokenDto) {
    const { refresh_token } = refreshTokenDto;
    try {
      const payload = this.jwtService.verify(refresh_token, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      const user = await this.userRepository.findOne({ where: { id: payload.sub } });
      if (!user) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (!user.is_active) {
        throw new UnauthorizedException('Account is deactivated');
      }

      // Look up THIS specific session — other devices/app installs are separate
      // rows and are never affected by this request.
      const session = await this.refreshTokenRepository.findOne({
        where: { user_id: user.id, token_hash: this.hashToken(refresh_token) },
      });
      if (!session || session.expires_at < new Date()) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Issue a NEW access token only — keep the SAME refresh token. Rotating it
      // here caused random logouts: when several requests 401 at once (token just
      // expired), the first refresh rotated the token and the rest failed with
      // the now-stale one → forced logout. The refresh token stays valid for its
      // full lifetime, so concurrent refreshes are all idempotent.
      const accessToken = this.jwtService.sign(
        { sub: user.id, phone: user.phone, role: user.role },
        {
          secret: this.configService.get<string>('jwt.secret'),
          expiresIn: this.configService.get<string>('jwt.expiresIn'),
        },
      );

      // Best-effort — lets sessions be inspected/pruned by recency later.
      this.refreshTokenRepository.update(session.id, { last_used_at: new Date() }).catch(() => {});

      return { access_token: accessToken, refresh_token };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async logout(userId: string) {
    // Revoke every session (matches the prior single-column behavior — logout
    // has always signed the account out everywhere, not just one device).
    await this.revokeAllSessions(userId);
    // Clear the FCM token so no push booking-offer or notification can reach
    // the device after logout. Use null (not undefined — TypeORM skips
    // undefined columns, so the token would never actually be cleared).
    await this.userRepository.update(userId, {
      fcm_token: null,
    });
    // Take drivers offline on logout so dispatch immediately stops matching them.
    // (Affects 0 rows for non-drivers.) Without this a logged-out driver stays
    // 'online' with a stale location and keeps receiving booking offers.
    await this.driverProfileRepository.update(
      { user_id: userId },
      { availability_status: AvailabilityStatus.OFFLINE },
    );
    return { message: 'Logged out successfully' };
  }

  // ─── Admin forgot-password / OTP reset ──────────────────────────────────────

  async forgotAdminPassword(email: string) {
    const user = await this.userRepository.findOne({
      where: { email: email.trim().toLowerCase(), role: UserRole.ADMIN },
    });
    // Always respond with success to avoid leaking whether the email exists.
    if (user && user.is_active) {
      await this.emailService.sendOtp(user.email!, user.name || 'Admin', 'password_reset');
    }
    return { message: 'If that email belongs to an admin account, an OTP has been sent.' };
  }

  async verifyAdminResetOtp(email: string, otp: string) {
    const normalised = email.trim().toLowerCase();
    const valid = await this.emailService.verifyOtp(normalised, 'password_reset', otp);
    if (!valid) throw new BadRequestException('Invalid OTP. Please try again.');

    const user = await this.userRepository.findOne({
      where: { email: normalised, role: UserRole.ADMIN },
    });
    if (!user) throw new NotFoundException('Admin account not found.');

    // Issue a short-lived reset token (15 min).
    const resetToken = this.jwtService.sign(
      { sub: user.id, purpose: 'password_reset' },
      {
        secret: this.configService.get<string>('jwt.secret'),
        expiresIn: '15m',
      },
    );
    return { reset_token: resetToken };
  }

  async resetAdminPassword(token: string, password: string) {
    let payload: { sub: string; purpose: string };
    try {
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.secret'),
      });
    } catch {
      throw new BadRequestException('Reset token is invalid or expired.');
    }

    if (payload.purpose !== 'password_reset') {
      throw new BadRequestException('Invalid reset token.');
    }

    const user = await this.userRepository.findOne({ where: { id: payload.sub } });
    if (!user || user.role !== UserRole.ADMIN) {
      throw new NotFoundException('Admin account not found.');
    }

    user.password_hash = await bcrypt.hash(password, 10);
    await this.userRepository.save(user);
    // Security-sensitive action — sign the account out everywhere.
    await this.revokeAllSessions(user.id);

    return { message: 'Password reset successfully.' };
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Issue a new session (access + refresh token pair) for `user` without
   * touching any of their other active sessions — multiple devices/app
   * installs can stay logged in concurrently. `deviceId` is stored purely for
   * visibility/debugging, not used for lookup.
   */
  private async generateTokens(user: User, deviceId?: string) {
    const payload = { sub: user.id, phone: user.phone, role: user.role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.secret'),
      expiresIn: this.configService.get<string>('jwt.expiresIn'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      expiresIn: this.configService.get<string>('jwt.refreshExpiresIn'),
    });

    const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null;
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Opportunistic cleanup — bounds table growth without needing a cron job.
    await this.refreshTokenRepository.delete({ user_id: user.id, expires_at: LessThan(new Date()) });

    await this.refreshTokenRepository.save(
      this.refreshTokenRepository.create({
        user_id: user.id,
        token_hash: this.hashToken(refreshToken),
        device_id: deviceId ?? null,
        expires_at: expiresAt,
      }),
    );

    return { access_token: accessToken, refresh_token: refreshToken };
  }

  /** Revoke every active session for a user — used only for the explicit,
   * consented cross-role switch ("signs the user out of the other app"). */
  private async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokenRepository.delete({ user_id: userId });
  }

  private sanitizeUser(user: User) {
    const { password_hash, refresh_token, ...sanitized } = user;
    return sanitized;
  }

  private roleLabel(role: UserRole): string {
    if (role === UserRole.DRIVER) return 'Rider';
    if (role === UserRole.ADMIN) return 'Admin';
    return 'Customer';
  }

  private mask(phone: string): string {
    return phone.replace(/(\+\d{2})(\d{2})(\d{6})(\d{2})/, '$1$2******$4');
  }
}
