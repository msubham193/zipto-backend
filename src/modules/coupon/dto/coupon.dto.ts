import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  IsBoolean,
  IsArray,
  IsDateString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CouponType } from '../entities/coupon.entity';

export class CreateCouponDto {
  @ApiProperty({ example: 'FIRST50' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code: string;

  @ApiProperty({ example: 'Get ₹50 off your first ride' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiPropertyOptional({ example: 'Valid on all vehicle types' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: CouponType, example: CouponType.FLAT })
  @IsEnum(CouponType)
  type: CouponType;

  @ApiProperty({ example: 50, description: '₹ for flat, % for percentage, ignored for free_delivery' })
  @IsNumber()
  @Min(0)
  value: number;

  @ApiPropertyOptional({ example: 100, description: 'Max discount cap for percentage coupons' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  max_discount?: number;

  @ApiPropertyOptional({ example: 0, description: 'Minimum booking fare to use coupon' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  min_order_value?: number;

  @ApiPropertyOptional({ example: 200, description: 'Total uses across all users (null = unlimited)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_total?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_per_user?: number;

  @ApiProperty({ example: '2026-01-01T00:00:00Z' })
  @IsDateString()
  valid_from: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59Z', description: 'null = never expires' })
  @IsOptional()
  @IsDateString()
  valid_until?: string;

  @ApiPropertyOptional({ example: ['bike', 'scooty'], description: 'null = all types' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applicable_vehicle_types?: string[];

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_first_ride_only?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateCouponDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  max_discount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  min_order_value?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_total?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_per_user?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  valid_from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  valid_until?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applicable_vehicle_types?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_first_ride_only?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ValidateCouponDto {
  @ApiProperty({ example: 'FIRST50' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ example: 150.0 })
  @IsNumber()
  @Min(0)
  order_value: number;

  @ApiPropertyOptional({ example: 'bike' })
  @IsOptional()
  @IsString()
  vehicle_type?: string;
}
