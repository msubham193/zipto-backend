import { IsString, IsNotEmpty, IsNumber, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrderDto {
  @ApiProperty({ example: 'uuid-of-booking' })
  @IsUUID()
  booking_id: string;

  @ApiProperty({ example: 250.50 })
  @IsNumber()
  amount: number;
}

export class VerifyPaymentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  razorpay_order_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  razorpay_payment_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  razorpay_signature: string;

  @ApiProperty()
  @IsUUID()
  booking_id: string;
}

export class CashPaymentDto {
  @ApiProperty({ example: 'uuid-of-booking' })
  @IsUUID()
  booking_id: string;

  @ApiProperty({ example: 250.00 })
  @IsNumber()
  amount: number;
}
