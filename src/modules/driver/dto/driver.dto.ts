import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsDateString,
  IsLatitude,
  IsLongitude,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvailabilityStatus } from '../entities/driver-profile.entity';

export class UpdateDriverDto {
  @ApiPropertyOptional({ example: 'John Driver' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'driver@example.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: 'OD02-20220001234' })
  @IsString()
  @IsOptional()
  license_number?: string;

  @ApiPropertyOptional({ example: '2030-12-31' })
  @IsDateString()
  @IsOptional()
  license_expiry?: string;
}

export class UpdateAvailabilityDto {
  @ApiProperty({ enum: AvailabilityStatus, example: AvailabilityStatus.ONLINE })
  @IsEnum(AvailabilityStatus)
  availability_status: AvailabilityStatus;
}

export class UpdateLocationDto {
  @ApiProperty({ example: 20.2961 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 85.8245 })
  @IsLongitude()
  longitude: number;
}

export class OnboardDriverDto {
  @ApiProperty({ example: 'John Driver' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: 'driver@example.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ example: '123 Main St, Bhubaneswar' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiProperty({ example: 'OD02-20220001234' })
  @IsString()
  @IsOptional()
  license_number?: string;

  @ApiProperty({ example: '2030-12-31' })
  @IsDateString()
  @IsOptional()
  license_expiry?: string;
}
