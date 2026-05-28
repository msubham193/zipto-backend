import { IsString, IsNotEmpty, IsNumber, IsUUID, IsEnum, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '../entities/payment.entity';

export class InitiatePaymentDto {
  @ApiProperty({ example: 'uuid-of-booking' })
  @IsUUID()
  booking_id: string;

  @ApiProperty({ example: 250.5, description: 'Amount in INR' })
  @IsNumber()
  @Min(1)
  amount: number;
}

export class InitiateWalletPaymentDto {
  @ApiProperty({ example: 500, description: 'Amount to add to wallet in INR (min ₹10, max ₹50,000)' })
  @IsNumber()
  @Min(10)
  amount: number;
}

export class CashPaymentDto {
  @ApiProperty({ example: 'uuid-of-booking' })
  @IsUUID()
  booking_id: string;

  @ApiProperty({ example: 250.0 })
  @IsNumber()
  amount: number;
}

// Legacy — kept so existing imports don't break; not used for new HDFC flow
export class CreateOrderDto {
  @ApiPropertyOptional({ example: 'uuid-of-booking' })
  @IsOptional()
  @IsUUID()
  booking_id?: string;

  @ApiProperty({ example: 250.5 })
  @IsNumber()
  amount: number;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  booking_id?: string;
}

export class CreatePaymentLinkDto {
  @ApiProperty({ example: 'uuid-of-booking' })
  @IsUUID()
  booking_id: string;

  @ApiProperty({ example: 250.0 })
  @IsNumber()
  amount: number;
}
