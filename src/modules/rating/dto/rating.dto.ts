import { IsNumber, IsString, IsOptional, IsUUID, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitRatingDto {
  @ApiProperty({ example: 'uuid-of-booking' })
  @IsUUID()
  booking_id: string;

  @ApiProperty({ example: 4.5, minimum: 1, maximum: 5 })
  @IsNumber()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ example: 'Great service! Very professional driver.' })
  @IsString()
  @IsOptional()
  comment?: string;
}
