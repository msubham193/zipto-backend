import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from './entities/user.entity';
import { OTP, OTPPurpose } from './entities/otp.entity';
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
} from './dto/auth.dto';
import {
  generateOTP,
  formatPhoneNumber,
  generateRandomUsername,
} from '../../common/utils/helpers.util';
import { SmsService } from '../../services/sms.service';
import { DriverProfile, AvailabilityStatus, VerificationStatus } from '../driver/entities/driver-profile.entity';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(OTP)
    private otpRepository: Repository<OTP>,
    @InjectRepository(DriverProfile)
    private driverProfileRepository: Repository<DriverProfile>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private smsService: SmsService,
  ) {}

  /**
   * Register a new driver — throws ConflictException if phone already registered.
   * Use this for the driver registration endpoint (strict new-user only).
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

    const otpCode = await this.createOTP(formattedPhone, OTPPurpose.REGISTRATION);

    const sent = await this.smsService.sendVerification(formattedPhone);
    if (!sent) {
      const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
      if (isDev) {
        this.logger.warn(
          `[DEV] Twilio failed. OTP for ${formattedPhone}: ${otpCode} — use this to register`,
        );
      } else {
        throw new BadRequestException('Failed to send OTP. Please try again.');
      }
    }

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      isNewUser: true,
      expiresIn: '10 minutes',
    };
  }

  /**
   * Register or login user - send OTP
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

    const purpose = existingUser ? OTPPurpose.LOGIN : OTPPurpose.REGISTRATION;
    const otpCode = await this.createOTP(formattedPhone, purpose);

    // Send OTP via Twilio Verify
    const sent = await this.smsService.sendVerification(formattedPhone);
    if (!sent) {
      const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
      if (isDev) {
        this.logger.warn(
          `[DEV] Twilio failed. OTP for ${formattedPhone}: ${otpCode} — use this to ${purpose === OTPPurpose.LOGIN ? 'login' : 'register'}`,
        );
      } else {
        throw new BadRequestException('Failed to send OTP. Please try again.');
      }
    }

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      isNewUser: !existingUser,
      expiresIn: '10 minutes',
    };
  }

  /**
   * Verify OTP and complete registration or login
   */
  async verifyOtp(verifyOtpDto: VerifyOtpDto) {
    const { phone, otp, role } = verifyOtpDto;
    const formattedPhone = formatPhoneNumber(phone);

    const isDev = process.env.NODE_ENV !== 'production';
    this.logger.log(`[verifyOtp] phone=${formattedPhone} otp=${otp} isDev=${isDev}`);

    // In dev mode: static OTP '1234' is always accepted — no Twilio or DB check needed
    let isValid = isDev && otp === '1234';

    if (!isValid) {
      // Verify via Twilio Verify
      this.logger.log(`[verifyOtp] calling Twilio checkVerification...`);
      isValid = await this.smsService.checkVerification(formattedPhone, otp);
      this.logger.log(`[verifyOtp] Twilio checkVerification result: ${isValid}`);

      if (!isValid && isDev) {
        // Dev fallback: check DB OTP for non-static codes
        const dbOtp = await this.otpRepository.findOne({
          where: { phone: formattedPhone, otp_code: otp, is_used: false },
        });
        if (dbOtp && dbOtp.expires_at > new Date()) {
          this.logger.warn(`[DEV] Accepted via DB OTP for ${formattedPhone}`);
          isValid = true;
        }
      }
    } else {
      this.logger.warn(`[DEV] Static OTP '1234' accepted for ${formattedPhone}`);
    }

    if (!isValid) {
      this.logger.error(`[verifyOtp] FAILED — invalid OTP for ${formattedPhone}`);
      throw new BadRequestException('Invalid or expired OTP');
    }

    this.logger.log(`[verifyOtp] OTP valid — proceeding to user lookup/creation`);

    // Mark DB OTP records as used
    await this.otpRepository.update({ phone: formattedPhone, is_used: false }, { is_used: true });

    // Check if user exists
    let user = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    this.logger.log(`[verifyOtp] user lookup result: ${user ? `found id=${user.id}` : 'NOT FOUND — will create'}`);

    let isNewUser = false;

    // Create new user if doesn't exist (registration)
    if (!user) {
      isNewUser = true;
      // Auto-generate username if not provided (user can edit later)
      const userName = generateRandomUsername();

      const assignedRole = role || UserRole.CUSTOMER;
      user = this.userRepository.create({
        phone: formattedPhone,
        name: userName,
        role: assignedRole,
        is_profile_complete: false,
        // Drivers are NOT auto-verified — admin will verify after onboarding
        is_verified: assignedRole !== UserRole.DRIVER,
      });

      await this.userRepository.save(user);
      this.logger.log(`New user registered: ${user.id} with name: ${userName}`);
    } else {
      // Update verification status — but don't auto-verify drivers
      if (user.role !== UserRole.DRIVER || user.is_verified) {
        user.is_verified = true;
      }
      if (role && user.role !== role) {
        this.logger.log(`Updating user role from ${user.role} to ${role}`);
        user.role = role as UserRole;
      }
      await this.userRepository.save(user);
    }



    // Force driver offline on every login — they must manually go online
    if (user.role === UserRole.DRIVER) {
      await this.driverProfileRepository.update(
        { user_id: user.id },
        { availability_status: AvailabilityStatus.OFFLINE },
      );
    }

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      is_new_user: isNewUser,
      ...tokens,
    };
  }

  /**
   * Login with phone (sends OTP)
   */
  async login(loginDto: LoginDto) {
    const { phone } = loginDto;
    const formattedPhone = formatPhoneNumber(phone);

    const existingUser = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    if (existingUser && !existingUser.is_active) {
      throw new UnauthorizedException('User account is deactivated');
    }

    const purpose = existingUser ? OTPPurpose.LOGIN : OTPPurpose.REGISTRATION;
    const otpCode = await this.createOTP(formattedPhone, purpose);

    // Send OTP via Twilio Verify
    const sent = await this.smsService.sendVerification(formattedPhone);
    if (!sent) {
      const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
      if (isDev) {
        this.logger.warn(
          `[DEV] Twilio failed. OTP for ${formattedPhone}: ${otpCode} — use this to ${purpose === OTPPurpose.LOGIN ? 'login' : 'register'}`,
        );
      } else {
        throw new BadRequestException('Failed to send OTP. Please try again.');
      }
    }

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      isNewUser: !existingUser,
      expiresIn: '10 minutes',
    };
  }

  /**
   * Admin login with email and password
   */
  async adminLogin(adminLoginDto: AdminLoginDto) {
    const { email, password } = adminLoginDto;

    const user = await this.userRepository.findOne({
      where: { email, role: UserRole.ADMIN },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.password_hash) {
      throw new UnauthorizedException('Password not set for this account');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Account is deactivated');
    }

    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  /**
   * Customer login with email and password (temporary — replaces OTP while Twilio is not production-ready)
   */
  async customerEmailLogin(dto: CustomerEmailLoginDto) {
    const { email, password } = dto;

    const user = await this.userRepository.findOne({
      where: { email, role: UserRole.CUSTOMER },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.password_hash) {
      throw new UnauthorizedException('Password not set for this account');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Account is deactivated');
    }

    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      is_new_user: false,
      ...tokens,
    };
  }

  /**
   * Customer registration with email and password (temporary — replaces OTP while Twilio is not production-ready)
   */
  async customerEmailRegister(dto: CustomerEmailRegisterDto) {
    const { email, password, name } = dto;

    const existingUser = await this.userRepository.findOne({ where: { email } });
    if (existingUser) {
      throw new ConflictException('An account with this email already exists.');
    }

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

    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      is_new_user: true,
      ...tokens,
    };
  }

  /**
   * Driver login with email and password (temporary — replaces OTP while Twilio is not production-ready)
   */
  async driverEmailLogin(dto: DriverEmailLoginDto) {
    const { email, password } = dto;

    const user = await this.userRepository.findOne({
      where: { email, role: UserRole.DRIVER },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.password_hash) {
      throw new UnauthorizedException('Password not set for this account');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Account is deactivated');
    }

    await this.driverProfileRepository.update(
      { user_id: user.id },
      { availability_status: AvailabilityStatus.OFFLINE },
    );

    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      is_new_user: false,
      ...tokens,
    };
  }

  /**
   * Driver registration with email and password (temporary — replaces OTP while Twilio is not production-ready)
   */
  async driverEmailRegister(dto: DriverEmailRegisterDto) {
    const { email, password, name } = dto;

    const existingUser = await this.userRepository.findOne({ where: { email } });
    if (existingUser) {
      throw new ConflictException('An account with this email already exists.');
    }

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

    // Create a pending driver profile so the driver appears in the admin panel
    const driverProfile = this.driverProfileRepository.create({
      user_id: user.id,
      verification_status: VerificationStatus.PENDING,
      availability_status: AvailabilityStatus.OFFLINE,
    });
    await this.driverProfileRepository.save(driverProfile);

    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
      is_new_user: true,
      ...tokens,
    };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshTokenDto: RefreshTokenDto) {
    const { refresh_token } = refreshTokenDto;

    try {
      const payload = this.jwtService.verify(refresh_token, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
      });

      if (!user || user.refresh_token !== refresh_token) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const tokens = await this.generateTokens(user);

      return tokens;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  /**
   * Logout user
   */
  async logout(userId: string) {
    await this.userRepository.update(userId, { refresh_token: undefined });
    return { message: 'Logged out successfully' };
  }

  /**
   * Resend OTP
   */
  async resendOtp(phone: string) {
    const formattedPhone = formatPhoneNumber(phone);

    const user = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    const purpose = user ? OTPPurpose.LOGIN : OTPPurpose.REGISTRATION;
    const otpCode = await this.createOTP(formattedPhone, purpose);

    // Send OTP via Twilio Verify
    const sent = await this.smsService.sendVerification(formattedPhone);
    if (!sent) {
      const isDev = this.configService.get<string>('NODE_ENV') !== 'production';
      if (isDev) {
        this.logger.warn(
          `[DEV] Twilio failed. OTP for ${formattedPhone}: ${otpCode} — use this to ${purpose === OTPPurpose.LOGIN ? 'login' : 'register'}`,
        );
      } else {
        throw new BadRequestException('Failed to send OTP. Please try again.');
      }
    }

    return {
      message: 'OTP resent successfully',
      phone: formattedPhone,
      expiresIn: '10 minutes',
    };
  }

  /**
   * DEV ONLY — return the latest valid OTP for a phone number.
   * Never call this in production.
   */
  async getDevOtp(phone: string): Promise<{ otp: string; expires_at: Date }> {
    const formattedPhone = formatPhoneNumber(phone);
    const otp = await this.otpRepository.findOne({
      where: { phone: formattedPhone, is_used: false },
      order: { created_at: 'DESC' },
    });

    if (!otp || otp.expires_at < new Date()) {
      throw new BadRequestException('No valid OTP found for this number. Request a new OTP first.');
    }

    return { otp: otp.otp_code, expires_at: otp.expires_at };
  }

  /**
   * Create OTP record
   */
  private async createOTP(phone: string, purpose: OTPPurpose): Promise<string> {
    const otpLength = this.configService.get<number>('externalServices.otp.length') || 6;
    const expiryMinutes =
      this.configService.get<number>('externalServices.otp.expiryMinutes') || 10;

    const otpCode = generateOTP(otpLength);
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + expiryMinutes);

    const otp = this.otpRepository.create({
      phone,
      otp_code: otpCode,
      purpose,
      expires_at: expiresAt,
    });

    await this.otpRepository.save(otp);

    // Clean up old OTPs
    await this.otpRepository.delete({
      created_at: LessThan(new Date(Date.now() - 24 * 60 * 60 * 1000)), // 24 hours ago
    });

    return otpCode;
  }

  /**
   * Generate JWT tokens
   */
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

    // Save refresh token in DB
    user.refresh_token = refreshToken;
    await this.userRepository.save(user);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  /**
   * Sanitize user object (remove sensitive fields)
   */
  private sanitizeUser(user: User) {
    const { password_hash, refresh_token, ...sanitized } = user;
    return sanitized;
  }
}
