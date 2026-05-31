import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from './entities/user.entity';
import { OTP } from './entities/otp.entity';
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
import { DriverProfile, AvailabilityStatus, VerificationStatus } from '../driver/entities/driver-profile.entity';
import { ReferralService } from '../referral/referral.service';

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
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly smsService: SmsService,
    private readonly referralService: ReferralService,
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

    await this.smsService.sendOTP(formattedPhone);

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

    await this.smsService.sendOTP(formattedPhone);

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

    await this.smsService.sendOTP(formattedPhone);

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

    // Delegates expiry/attempt tracking to SmsService; throws on failure
    const isValid = await this.smsService.verifyOTP(formattedPhone, otp);
    if (!isValid) {
      throw new BadRequestException('Invalid OTP. Please check the code and try again.');
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
    await this.smsService.sendOTP(formattedPhone);

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

  async deleteAccount(dto: DeleteAccountDto) {
    const { email } = dto;
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) throw new NotFoundException('No account found with this email address');

    if (user.phone) await this.otpRepository.delete({ phone: user.phone });
    if (user.role === UserRole.DRIVER) {
      await this.driverProfileRepository.delete({ user_id: user.id });
    }
    await this.userRepository.delete(user.id);

    return { message: 'Account deleted successfully' };
  }

  async refreshToken(refreshTokenDto: RefreshTokenDto) {
    const { refresh_token } = refreshTokenDto;
    try {
      const payload = this.jwtService.verify(refresh_token, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      const user = await this.userRepository.findOne({ where: { id: payload.sub } });
      if (!user || user.refresh_token !== refresh_token) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async logout(userId: string) {
    await this.userRepository.update(userId, { refresh_token: undefined });
    return { message: 'Logged out successfully' };
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async generateTokens(user: User) {
    const payload = { sub: user.id, phone: user.phone, role: user.role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.secret'),
      expiresIn: this.configService.get<string>('jwt.expiresIn'),
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      expiresIn: this.configService.get<string>('jwt.refreshExpiresIn'),
    });

    user.refresh_token = refreshToken;
    await this.userRepository.save(user);

    return { access_token: accessToken, refresh_token: refreshToken };
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
