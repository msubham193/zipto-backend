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
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '../../vehicle/entities/vehicle.entity';
import { BookingType } from '../entities/booking.entity';

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

  @ApiProperty({ enum: BookingType, example: BookingType.INSTANT })
  @IsEnum(BookingType)
  booking_type: BookingType;

  @ApiPropertyOptional({ example: '2024-01-20T10:00:00Z' })
  @IsDateString()
  @IsOptional()
  scheduled_time?: string;
}

export class CancelBookingDto {
  @ApiProperty({ example: 'Changed my mind' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class UpdateFinalFareDto {
  @ApiProperty({ example: 250.00 })
  @IsOptional()
  final_fare?: number;
}
