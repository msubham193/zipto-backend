import { IsString, IsOptional, IsEmail, IsNumber, IsLatitude, IsLongitude } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'John Doe' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'john@example.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: '123 Main St, Bhubaneswar, Odisha' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsString()
  @IsOptional()
  language_preference?: string;
}

export class UpdateCustomerPresenceDto {
  @ApiProperty({ example: 20.2961 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 85.8245 })
  @IsLongitude()
  longitude: number;
}

export class SavedLocationDto {
  @ApiProperty({ example: 'Home' })
  @IsString()
  label: string;

  @ApiProperty({ example: 'Plot 123, Nayapalli, Bhubaneswar' })
  @IsString()
  address: string;

  @ApiProperty({ example: 20.2961 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 85.8245 })
  @IsLongitude()
  longitude: number;
}
