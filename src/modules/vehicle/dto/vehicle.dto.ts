import { IsString, IsNotEmpty, IsEnum, IsNumber, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '../entities/vehicle.entity';

export class RegisterVehicleDto {
  @ApiProperty({ enum: VehicleType, example: VehicleType.TATA_ACE })
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  @ApiProperty({ example: 'OD-02-AB-1234' })
  @IsString()
  @IsNotEmpty()
  registration_number: string;

  @ApiPropertyOptional({ example: 750, description: 'Capacity in kg (deprecated)' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({ example: 'Tata Ace Gold' })
  @IsString()
  @IsOptional()
  vehicle_model?: string;

  @ApiPropertyOptional({ example: 'Policy #123456789, Valid till 2025-12-31' })
  @IsString()
  @IsOptional()
  insurance_details?: string;
}

export class UpdateVehicleDto {
  @ApiPropertyOptional({ example: 800, description: 'Capacity in kg' })
  @IsNumber()
  @Min(1)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({ example: 'Tata Ace Gold' })
  @IsString()
  @IsOptional()
  vehicle_model?: string;

  @ApiPropertyOptional({ example: 'Updated insurance details' })
  @IsString()
  @IsOptional()
  insurance_details?: string;

  @ApiPropertyOptional({ example: 'https://s3.amazonaws.com/skido/rc-doc.pdf' })
  @IsString()
  @IsOptional()
  rc_document_url?: string;

  @ApiPropertyOptional({ example: 'https://s3.amazonaws.com/skido/insurance.pdf' })
  @IsString()
  @IsOptional()
  insurance_document_url?: string;
}
