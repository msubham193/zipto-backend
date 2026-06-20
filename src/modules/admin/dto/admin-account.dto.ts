import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// Shared password policy: 8–72 chars (bcrypt limit), at least one letter and
// one number. Kept deliberately simple but non-trivial.
const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;
const PASSWORD_MSG =
  'Password must be at least 8 characters and include a letter and a number';

export class ChangePasswordDto {
  @ApiProperty({ example: 'CurrentPass1', description: 'Current password' })
  @IsString()
  @MinLength(1, { message: 'Current password is required' })
  currentPassword: string;

  @ApiProperty({ example: '123456', description: '6-digit email OTP' })
  @IsString()
  @Length(6, 6, { message: 'Enter the 6-digit code sent to your email' })
  otp: string;

  @ApiProperty({ example: 'NewSecurePass1', description: 'New password' })
  @IsString()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  newPassword: string;
}

export class CreateAdminDto {
  @ApiProperty({ example: 'Priya Sharma' })
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'priya@ridezipto.com' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(100)
  email: string;
}

export class UpdateAdminStatusDto {
  @ApiProperty({ example: false, description: 'Enable/disable the admin account' })
  @IsBoolean()
  is_active: boolean;
}
