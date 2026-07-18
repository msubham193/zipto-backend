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
  Max,
  IsBoolean,
  IsArray,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VehicleType } from '../../vehicle/entities/vehicle.entity';
import { BookingType, PaidBy, ServiceCategory } from '../entities/booking.entity';

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
  @MaxLength(300)
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

  @ApiProperty({ enum: VehicleType, example: VehicleType.SCOOTY })
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  /** @deprecated labour/helper option has been removed */
  @IsOptional()
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
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '9876543210' })
  @IsString()
  @IsNotEmpty()
  @IsMobilePhone('en-IN')
  mobile_number: string;

  @ApiPropertyOptional({ example: 'Jane Doe', description: 'Receiver name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  receiver_name?: string;

  @ApiPropertyOptional({ example: '9876543211', description: 'Receiver phone number' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  receiver_phone?: string;

  @ApiPropertyOptional({ example: '9876543212', description: 'Alternative phone number' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  alternative_phone?: string;

  @ApiProperty({ example: 'Bhubaneswar' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city: string;

  @ApiProperty({
    enum: ServiceCategory,
    example: ServiceCategory.SEND_PACKAGES,
    description: 'Service category: food_delivery (From Restaurant), medicine (From Pharmacy), send_packages (Send Parcel), transport_goods (Move Goods)',
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

  @ApiProperty({ enum: VehicleType, example: VehicleType.SCOOTY })
  @IsEnum(VehicleType)
  vehicle_type: VehicleType;

  @ApiProperty({ enum: BookingType, example: BookingType.INSTANT })
  @IsEnum(BookingType)
  booking_type: BookingType;

  @ApiPropertyOptional({
    enum: PaidBy,
    example: PaidBy.SENDER,
    description: 'Who pays for the delivery: sender (at pickup) or receiver (at delivery)',
  })
  @IsOptional()
  @IsEnum(PaidBy)
  paid_by?: PaidBy;

  @ApiPropertyOptional({ example: '2024-01-20T10:00:00Z' })
  @IsDateString()
  @IsOptional()
  scheduled_time?: string;

  /** @deprecated labour/helper option has been removed */
  @IsOptional()
  number_of_helpers?: number;

  @ApiPropertyOptional({ example: 100, description: 'Zipto coins to redeem for discount (multiples of 100, 0 = no discount)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  coins_to_redeem?: number;

  @ApiPropertyOptional({ example: 'FIRST50', description: 'Promo / coupon code to apply' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  coupon_code?: string;

  @ApiPropertyOptional({ example: '22AAAAA0000A1Z5', description: 'Business GSTIN for a B2B tax invoice (Input Tax Credit). 15 chars.' })
  @IsOptional()
  @IsString()
  @MaxLength(15)
  gstin?: string;
}

export class StartTripDto {
  @ApiProperty({ example: '391847', description: 'Pickup OTP provided by customer to confirm package handover' })
  @IsString()
  @IsNotEmpty()
  pickup_otp: string;
}

export class CancelBookingDto {
  @ApiProperty({ example: 'Changed my mind' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class CompleteTripDto {
  @ApiProperty({ example: '482910', description: 'Delivery OTP provided by the sender to confirm delivery' })
  @IsString()
  @IsNotEmpty()
  delivery_otp: string;

  @ApiPropertyOptional({ example: 'cash', description: 'Payment method used at delivery: cash or online' })
  @IsOptional()
  @IsString()
  payment_method?: 'cash' | 'online';

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

export class HandoffRequestDto {
  @ApiProperty({ example: 'Vehicle breakdown — tyre puncture on highway' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class HandoffAcceptDto {
  @ApiProperty({ example: 'uuid-of-vehicle' })
  @IsUUID()
  @IsNotEmpty()
  vehicle_id: string;
}

export class GetHotspotsDto {
  @ApiProperty({ example: 20.2961, description: "Rider's current latitude" })
  @Type(() => Number)
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 85.8245, description: "Rider's current longitude" })
  @Type(() => Number)
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional({ example: 7, description: 'Search radius in km (1-20, default 7)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(20)
  radius_km?: number;

  @ApiPropertyOptional({ enum: VehicleType, description: 'Filter to a single vehicle type' })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicle_type?: VehicleType;
}

export class GetHotspotPeakTimeDto {
  @ApiProperty({ example: 20.2961 })
  @Type(() => Number)
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 85.8245 })
  @Type(() => Number)
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional({ example: 1, description: 'Radius in km around the point to analyze (default 1)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.2)
  @Max(10)
  radius_km?: number;
}

export class GetDemandHeatmapDto {
  @ApiPropertyOptional({ example: 14, description: 'Lookback window in days (1-90, default 14)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @ApiPropertyOptional({ enum: VehicleType, description: 'Filter demand points to a single vehicle type' })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicle_type?: VehicleType;
}
