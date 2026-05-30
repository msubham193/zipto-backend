import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsEmail,
  MinLength,
  MaxLength,
  IsOptional,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../entities/user.entity';

/** Indian mobile number — 10 digits, optionally prefixed with +91 or 91 */
const INDIAN_PHONE_REGEX = /^(\+91|91)?[6-9]\d{9}$/;

export class RegisterDto {
  @ApiProperty({ example: '9876543210', description: 'Indian mobile number (10 digits or +91 prefix)' })
  @IsString()
  @IsNotEmpty()
  @Matches(INDIAN_PHONE_REGEX, { message: 'Phone must be a valid 10-digit Indian mobile number' })
  phone: string;

  @ApiProperty({ enum: UserRole, example: UserRole.CUSTOMER })
  @IsEnum(UserRole)
  role: UserRole;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '9876543210', description: 'Indian mobile number (10 digits or +91 prefix)' })
  @IsString()
  @IsNotEmpty()
  @Matches(INDIAN_PHONE_REGEX, { message: 'Phone must be a valid 10-digit Indian mobile number' })
  phone: string;

  @ApiProperty({ example: '482916', description: '6-digit OTP received via SMS (use 1234 in dev)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(4, { message: 'OTP must be at least 4 characters' })
  @MaxLength(6, { message: 'OTP must be at most 6 characters' })
  otp: string;

  @ApiProperty({ enum: UserRole, required: false, example: UserRole.DRIVER })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @ApiProperty({ required: false, example: 'AB12CD', description: 'Referral code (new users only)' })
  @IsString()
  @IsOptional()
  @MaxLength(12)
  referral_code?: string;
}

export class LoginDto {
  @ApiProperty({ example: '9876543210', description: 'Indian mobile number (10 digits or +91 prefix)' })
  @IsString()
  @IsNotEmpty()
  @Matches(INDIAN_PHONE_REGEX, { message: 'Phone must be a valid 10-digit Indian mobile number' })
  phone: string;
}

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@zipto.in' })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Admin@123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}

export class ResendOTPDto {
  @ApiProperty({ example: '9876543210', description: 'Indian mobile number (10 digits or +91 prefix)' })
  @IsString()
  @IsNotEmpty()
  @Matches(INDIAN_PHONE_REGEX, { message: 'Phone must be a valid 10-digit Indian mobile number' })
  phone: string;
}

export class CustomerEmailLoginDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Password@123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;
}

export class CustomerEmailRegisterDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Password@123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @ApiProperty({ required: false, example: 'AB12CD', description: 'Referral code (optional)' })
  @IsString()
  @IsOptional()
  @MaxLength(12)
  referral_code?: string;
}

export class DriverEmailLoginDto {
  @ApiProperty({ example: 'driver@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Password@123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;
}

export class DriverEmailRegisterDto {
  @ApiProperty({ example: 'John Driver' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'driver@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Password@123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;
}

export class DeleteAccountDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
