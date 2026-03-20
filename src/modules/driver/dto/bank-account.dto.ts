import { IsString, IsNotEmpty, IsEnum, IsOptional, Matches, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType } from '../entities/bank-account.entity';

export class CreateBankAccountDto {
  @ApiProperty({ example: 'Rahul Kumar' })
  @IsString()
  @IsNotEmpty()
  account_holder_name: string;

  @ApiProperty({ example: 'State Bank of India' })
  @IsString()
  @IsNotEmpty()
  bank_name: string;

  @ApiProperty({ example: '123456789012' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{9,18}$/, { message: 'Account number must be 9–18 digits' })
  account_number: string;

  @ApiProperty({ example: 'SBIN0001234' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'Invalid IFSC code format' })
  ifsc_code: string;

  @ApiProperty({ example: 'MG Road, Bangalore' })
  @IsString()
  @IsNotEmpty()
  branch: string;

  @ApiPropertyOptional({ enum: AccountType, example: AccountType.SAVINGS })
  @IsEnum(AccountType)
  @IsOptional()
  account_type?: AccountType;
}

export class UpdateBankAccountDto {
  @ApiPropertyOptional({ example: 'Rahul Kumar' })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  account_holder_name?: string;

  @ApiPropertyOptional({ example: 'HDFC Bank' })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  bank_name?: string;

  @ApiPropertyOptional({ example: '987654321012' })
  @IsString()
  @Matches(/^\d{9,18}$/, { message: 'Account number must be 9–18 digits' })
  @IsOptional()
  account_number?: string;

  @ApiPropertyOptional({ example: 'HDFC0001234' })
  @IsString()
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'Invalid IFSC code format' })
  @IsOptional()
  ifsc_code?: string;

  @ApiPropertyOptional({ example: 'Koramangala, Bangalore' })
  @IsString()
  @IsOptional()
  branch?: string;

  @ApiPropertyOptional({ enum: AccountType, example: AccountType.CURRENT })
  @IsEnum(AccountType)
  @IsOptional()
  account_type?: AccountType;
}
