import { IsString, IsNotEmpty, IsNumber, IsUUID, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '../entities/payment.entity';

export class CreateOrderDto {
  @ApiProperty({ example: 'uuid-of-booking' })
  @IsUUID()
  booking_id: string;

  @ApiProperty({ example: 250.50 })
  @IsNumber()
  amount: number;

  @ApiPropertyOptional({ enum: PaymentMethod, example: PaymentMethod.UPI, description: 'Payment method: upi, card, or wallet' })
  @IsOptional()
  @IsEnum(PaymentMethod, { message: 'payment_method must be one of: upi, card, wallet' })
  payment_method?: PaymentMethod;
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
