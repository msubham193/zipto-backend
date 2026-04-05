import { IsEnum, IsNumber, IsOptional, IsString, IsBoolean, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '../../vehicle/entities/vehicle.entity';

export class CreatePricingRuleDto {
  @ApiProperty({ enum: VehicleType })
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  @ApiProperty({ example: 35 })
  @IsNumber()
  @Min(0)
  base_fare: number;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(0)
  base_distance_km: number;

  @ApiProperty({ example: 7 })
  @IsNumber()
  @Min(0)
  per_km_rate: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  per_minute_rate?: number;

  @ApiPropertyOptional({ example: 40 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minimum_fare?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  surge_multiplier?: number;

  @ApiPropertyOptional({ example: 70 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  free_waiting_minutes?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  waiting_charge_per_minute?: number;

  @ApiPropertyOptional({ example: 'Documents, food, medicines' })
  @IsOptional()
  @IsString()
  best_for?: string;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  night_surcharge_percent?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  multi_stop_fee?: number;

  @ApiPropertyOptional({ example: 25 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  commission_percent?: number;

  @ApiPropertyOptional({ example: 'Bhubaneswar' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdatePricingRuleDto {
  @ApiPropertyOptional({ example: 35 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  base_fare?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  base_distance_km?: number;

  @ApiPropertyOptional({ example: 7 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  per_km_rate?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  per_minute_rate?: number;

  @ApiPropertyOptional({ example: 40 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minimum_fare?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  surge_multiplier?: number;

  @ApiPropertyOptional({ example: 70 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  free_waiting_minutes?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  waiting_charge_per_minute?: number;

  @ApiPropertyOptional({ example: 'Documents, food, medicines' })
  @IsOptional()
  @IsString()
  best_for?: string;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  night_surcharge_percent?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  multi_stop_fee?: number;

  @ApiPropertyOptional({ example: 25 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  commission_percent?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}