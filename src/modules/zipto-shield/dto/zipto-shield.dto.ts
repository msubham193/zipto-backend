import { IsNumber, IsPositive, IsOptional, IsString, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class WithdrawShieldDto {
  @ApiProperty({ example: 500, description: 'Amount to withdraw in rupees' })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  amount: number;

  @ApiPropertyOptional({ example: 'Emergency payout for claim #123' })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class GetTransactionsQueryDto {
  @ApiPropertyOptional({ enum: ['contribution', 'withdrawal'] })
  @IsOptional()
  @IsIn(['contribution', 'withdrawal'])
  type?: 'contribution' | 'withdrawal';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}