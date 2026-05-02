import { Controller, Post, Body, Get, Param, HttpCode, HttpStatus, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import {
  RegisterDto,
  VerifyOtpDto,
  LoginDto,
  AdminLoginDto,
  RefreshTokenDto,
  ResendOTPDto,
  CustomerEmailLoginDto,
  CustomerEmailRegisterDto,
  DriverEmailLoginDto,
  DriverEmailRegisterDto,
} from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from './entities/user.entity';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('customer/register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register customer and send OTP' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  async customerRegister(@Body() registerDto: RegisterDto) {
    return this.authService.register({ ...registerDto, role: 'customer' as any });
  }

  @Public()
  @Post('driver/register')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register driver and send OTP' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  async driverRegister(@Body() registerDto: RegisterDto) {
    return this.authService.registerDriver({ ...registerDto, role: 'driver' as any });
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and complete registration/login' })
  @ApiResponse({ status: 200, description: 'OTP verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
  async verifyOtp(@Body() verifyOtpDto: VerifyOtpDto) {
    return this.authService.verifyOtp(verifyOtpDto);
  }

  @Public()
  @Post('customer/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Customer login - sends OTP' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({ status: 401, description: 'User not found' })
  async customerLogin(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Public()
  @Post('driver/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Driver login - sends OTP' })
  @ApiResponse({ status: 200, description: 'OTP sent successfully' })
  @ApiResponse({ status: 401, description: 'User not found' })
  async driverLogin(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Public()
  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async adminLogin(@Body() adminLoginDto: AdminLoginDto) {
    return this.authService.adminLogin(adminLoginDto);
  }

  @Public()
  @Post('customer/email-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Customer login with email and password (temporary)' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async customerEmailLogin(@Body() dto: CustomerEmailLoginDto) {
    return this.authService.customerEmailLogin(dto);
  }

  @Public()
  @Post('customer/email-register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Customer registration with email and password (temporary)' })
  @ApiResponse({ status: 201, description: 'Account created successfully' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async customerEmailRegister(@Body() dto: CustomerEmailRegisterDto) {
    return this.authService.customerEmailRegister(dto);
  }

  @Public()
  @Post('driver/email-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Driver login with email and password (temporary)' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async driverEmailLogin(@Body() dto: DriverEmailLoginDto) {
    return this.authService.driverEmailLogin(dto);
  }

  @Public()
  @Post('driver/email-register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Driver registration with email and password (temporary)' })
  @ApiResponse({ status: 201, description: 'Account created successfully' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async driverEmailRegister(@Body() dto: DriverEmailRegisterDto) {
    return this.authService.driverEmailRegister(dto);
  }

  @Public()
  @Post('refresh-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get new access token using refresh token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refreshToken(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshToken(refreshTokenDto);
  }

  @Public()
  @Post('resend-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend OTP' })
  @ApiResponse({ status: 200, description: 'OTP resent successfully' })
  async resendOtp(@Body() resendOTPDto: ResendOTPDto) {
    return this.authService.resendOtp(resendOTPDto.phone);
  }

  @Public()
  @Get('dev/otp/:phone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[DEV ONLY] Get current OTP for a phone number' })
  async getDevOtp(@Param('phone') phone: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Not available in production');
    }
    return this.authService.getDevOtp(phone);
  }

  @Post('logout')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@GetUser() user: User) {
    return this.authService.logout(user.id);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user details' })
  @ApiResponse({ status: 200, description: 'User details retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@GetUser() user: User) {
    const { password_hash, refresh_token, ...sanitizedUser } = user;
    return sanitizedUser;
  }
}
