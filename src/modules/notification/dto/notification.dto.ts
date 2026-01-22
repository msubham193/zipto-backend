import { IsString, IsNotEmpty, IsUUID, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendNotificationDto {
  @ApiProperty({ example: 'uuid-of-user' })
  @IsUUID()
  user_id: string;

  @ApiProperty({ example: 'Booking Confirmed' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'Your booking has been confirmed. Driver will arrive soon.' })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({ example: { booking_id: 'uuid', type: 'booking_update' } })
  @IsOptional()
  data?: any;
}
