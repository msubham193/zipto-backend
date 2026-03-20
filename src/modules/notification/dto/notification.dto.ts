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

export class DriverNotificationDto {
  @ApiProperty({ example: 'c3a1b2d4-...' })
  id: string;

  @ApiProperty({
    example: 'approval',
    enum: ['approval', 'rejection', 'payment', 'weekly_earnings', 'general'],
  })
  type: string;

  @ApiProperty({ example: '🎉 Account Approved!' })
  title: string;

  @ApiProperty({ example: 'Your driver account has been verified.' })
  message: string;

  @ApiPropertyOptional({ example: { bookingId: 'uuid', amount: 250 } })
  data?: Record<string, unknown>;

  @ApiProperty({ example: 1710000000000, description: 'Unix timestamp (ms)' })
  createdAt: number;

  @ApiProperty({ example: false })
  read: boolean;
}
