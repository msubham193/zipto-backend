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
import { generateOTP, formatPhoneNumber, generateRandomUsername } from '../../common/utils/helpers.util';

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
  ) {}

  /**
   * Register new user and send OTP
   */
  async register(registerDto: RegisterDto) {
    const { phone, role } = registerDto;
    const formattedPhone = formatPhoneNumber(phone);

    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    if (existingUser) {
      throw new ConflictException('User with this phone number already exists');
    }

    // Generate and save OTP
    const otpCode = await this.createOTP(formattedPhone, OTPPurpose.REGISTRATION);

    // TODO: Send OTP via SMS
    this.logger.log(`OTP for ${formattedPhone}: ${otpCode}`);

    const expiryMinutes = this.configService.get<number>('externalServices.otp.expiryMinutes') || 10;

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      expiresIn: `${expiryMinutes} minutes`,
    };
  }

  /**
   * Verify OTP and complete registration or login
   */
  async verifyOtp(verifyOtpDto: VerifyOtpDto) {
    const { phone, otp } = verifyOtpDto;
    const formattedPhone = formatPhoneNumber(phone);

    // Validate OTP
    const otpRecord = await this.otpRepository.findOne({
      where: {
        phone: formattedPhone,
        otp_code: otp,
        is_used: false,
      },
      order: { created_at: 'DESC' },
    });

    if (!otpRecord) {
      throw new BadRequestException('Invalid OTP');
    }

    if (new Date() > otpRecord.expires_at) {
      throw new BadRequestException('OTP has expired');
    }

    // Mark OTP as used
    otpRecord.is_used = true;
    await this.otpRepository.save(otpRecord);

    // Check if user exists
    let user = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    // Create new user if doesn't exist (registration)
    if (!user) {
      // Auto-generate username if not provided (user can edit later)
      const userName = generateRandomUsername();

      user = this.userRepository.create({
        phone: formattedPhone,
        name: userName,
        role: otpRecord.purpose === OTPPurpose.REGISTRATION ? UserRole.CUSTOMER : UserRole.CUSTOMER,
        is_verified: true,
      });

      await this.userRepository.save(user);
      this.logger.log(`New user registered: ${user.id} with name: ${userName}`);
    } else {
      // Update verification status
      user.is_verified = true;
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

    // Check if user exists
    const user = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('User account is deactivated');
    }

    // Generate and save OTP
    const otpCode = await this.createOTP(formattedPhone, OTPPurpose.LOGIN);

    // TODO: Send OTP via SMS
    this.logger.log(`OTP for ${formattedPhone}: ${otpCode}`);

    const expiryMinutes = this.configService.get<number>('externalServices.otp.expiryMinutes') || 10;

    return {
      message: 'OTP sent successfully',
      phone: formattedPhone,
      expiresIn: `${expiryMinutes} minutes`,
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

    const user = await this.userRepository.findOne({
      where: { phone: formattedPhone },
    });

    const purpose = user ? OTPPurpose.LOGIN : OTPPurpose.REGISTRATION;
    const otpCode = await this.createOTP(formattedPhone, purpose);

    // TODO: Send OTP via SMS
    this.logger.log(`OTP for ${formattedPhone}: ${otpCode}`);

    const expiryMinutes = this.configService.get<number>('externalServices.otp.expiryMinutes') || 10;

    return {
      message: 'OTP resent successfully',
      phone: formattedPhone,
      expiresIn: `${expiryMinutes} minutes`,
    };
  }

  /**
   * Create OTP record
   */
  private async createOTP(phone: string, purpose: OTPPurpose): Promise<string> {
    const otpLength = this.configService.get<number>('externalServices.otp.length') || 6;
    const expiryMinutes = this.configService.get<number>('externalServices.otp.expiryMinutes') || 10;

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
