import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  IsEnum,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendNotificationDto {
  @ApiProperty({ example: 'uuid-of-user' })
  @IsUUID()
  user_id: string;

  @ApiProperty({ example: 'Booking Confirmed' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'Your booking has been confirmed.' })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({ example: { booking_id: 'uuid', type: 'booking_update' } })
  @IsOptional()
  data?: any;
}

export class BroadcastNotificationDto {
  @ApiProperty({
    example: 'drivers',
    enum: ['all', 'drivers', 'customers', 'user'],
    description:
      '"all" = every user, "drivers" = all drivers, "customers" = all customers, "user" = specific user (requires user_id)',
  })
  @IsIn(['all', 'drivers', 'customers', 'user'])
  target: 'all' | 'drivers' | 'customers' | 'user';

  @ApiPropertyOptional({ example: 'uuid-of-user', description: 'Required when target = "user"' })
  @IsUUID()
  @IsOptional()
  user_id?: string;

  @ApiProperty({ example: 'Scheduled Maintenance' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'The app will be under maintenance from 2–3 AM.' })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({ example: { type: 'maintenance' } })
  @IsOptional()
  data?: any;
}

export class RegisterFcmTokenDto {
  @ApiProperty({ example: 'fcm-token-string-from-device' })
  @IsString()
  @IsNotEmpty()
  token: string;
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
