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
} from './dto/auth.dto';
import {
  generateOTP,
  formatPhoneNumber,
  generateRandomUsername,
} from '../../common/utils/helpers.util';
import { SmsService } from '../../services/sms.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(OTP)
    private otpRepository: Repository<OTP>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private smsService: SmsService,
  ) {}

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

    // Send OTP via Twilio Verify
    const sent = await this.smsService.sendVerification(formattedPhone);
    if (!sent) {
      throw new BadRequestException('Failed to send OTP. Please try again.');
    }

    const purpose = existingUser ? OTPPurpose.LOGIN : OTPPurpose.REGISTRATION;
    await this.createOTP(formattedPhone, purpose);

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

    // Verify OTP via Twilio Verify
    const isValid = await this.smsService.checkVerification(formattedPhone, otp);
    if (!isValid) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    // Mark DB OTP records as used
    await this.otpRepository.update({ phone: formattedPhone, is_used: false }, { is_used: true });

    // Check if user exists
    let user = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    // Create new user if doesn't exist (registration)
    if (!user) {
      // Auto-generate username if not provided (user can edit later)
      const userName = generateRandomUsername();

      const assignedRole = role || UserRole.CUSTOMER;
      user = this.userRepository.create({
        phone: formattedPhone,
        name: userName,
        role: assignedRole,
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

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      user: this.sanitizeUser(user),
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

    // Send OTP via Twilio Verify
    const sent = await this.smsService.sendVerification(formattedPhone);
    if (!sent) {
      throw new BadRequestException('Failed to send OTP. Please try again.');
    }

    const purpose = existingUser ? OTPPurpose.LOGIN : OTPPurpose.REGISTRATION;
    await this.createOTP(formattedPhone, purpose);

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

    // Send OTP via Twilio Verify
    const sent = await this.smsService.sendVerification(formattedPhone);
    if (!sent) {
      throw new BadRequestException('Failed to send OTP. Please try again.');
    }

    const user = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    const purpose = user ? OTPPurpose.LOGIN : OTPPurpose.REGISTRATION;
    await this.createOTP(formattedPhone, purpose);

    return {
      message: 'OTP resent successfully',
      phone: formattedPhone,
      expiresIn: '10 minutes',
    };
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

    // Save refresh token
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
