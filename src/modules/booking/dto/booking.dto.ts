import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsDateString,
  IsLatitude,
  IsLongitude,
  ValidateNested,
  IsMobilePhone,
  IsNumber,
  IsInt,
  Min,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '../../vehicle/entities/vehicle.entity';
import { BookingType, ServiceCategory } from '../entities/booking.entity';

export class LocationDto {
  @ApiProperty({ example: 20.2961 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 85.8245 })
  @IsLongitude()
  longitude: number;

  @ApiProperty({ example: 'Nayapalli, Bhubaneswar, Odisha' })
  @IsString()
  @IsNotEmpty()
  address: string;
}

export class EstimateFareDto {
  @ApiProperty({ type: LocationDto })
  @ValidateNested()
  @Type(() => LocationDto)
  pickup_location: LocationDto;

  @ApiProperty({ type: LocationDto })
  @ValidateNested()
  @Type(() => LocationDto)
  drop_location: LocationDto;

  @ApiProperty({ enum: VehicleType, example: VehicleType.TATA_ACE })
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  @ApiPropertyOptional({
    example: 0,
    description: 'Number of loading/unloading helpers (₹200 each)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  number_of_helpers?: number;

  @ApiPropertyOptional({ example: 0, description: 'Number of extra drop-off stops' })
  @IsOptional()
  @IsInt()
  @Min(0)
  extra_stops?: number;
}

export class CreateBookingDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '9876543210' })
  @IsString()
  @IsNotEmpty()
  @IsMobilePhone('en-IN')
  mobile_number: string;

  @ApiProperty({ example: 'Bhubaneswar' })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiProperty({
    enum: ServiceCategory,
    example: ServiceCategory.SEND_PACKAGES,
    description: 'Service type: send_packages, transport_goods, food_delivery, medicine',
  })
  @IsEnum(ServiceCategory)
  service_category: ServiceCategory;

  @ApiProperty({ type: LocationDto })
  @ValidateNested()
  @Type(() => LocationDto)
  pickup_location: LocationDto;

  @ApiProperty({ type: LocationDto })
  @ValidateNested()
  @Type(() => LocationDto)
  drop_location: LocationDto;

  @ApiPropertyOptional({
    type: [LocationDto],
    description: 'Additional drop-off locations for multi-stop',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LocationDto)
  extra_drop_locations?: LocationDto[];

  @ApiProperty({ enum: VehicleType, example: VehicleType.TATA_ACE })
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  @ApiProperty({ enum: BookingType, example: BookingType.INSTANT })
  @IsEnum(BookingType)
  booking_type: BookingType;

  @ApiPropertyOptional({ example: '2024-01-20T10:00:00Z' })
  @IsDateString()
  @IsOptional()
  scheduled_time?: string;

  @ApiPropertyOptional({
    example: 0,
    description: 'Number of loading/unloading helpers (₹200 each)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  number_of_helpers?: number;
}

export class CancelBookingDto {
  @ApiProperty({ example: 'Changed my mind' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class CompleteTripDto {
  @ApiPropertyOptional({ example: false, description: 'Whether toll was incurred during the trip' })
  @IsOptional()
  @IsBoolean()
  has_toll?: boolean;

  @ApiPropertyOptional({ example: 0, description: 'Toll amount in rupees' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  toll_amount?: number;

  @ApiPropertyOptional({ example: 0, description: 'Total waiting time in minutes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  waiting_time_minutes?: number;
}

// Keep for backward compatibility
export class UpdateFinalFareDto {
  @ApiProperty({ example: 250.0 })
  @IsOptional()
  final_fare?: number;
}
