import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class ApplyReferralDto {
  @ApiProperty({ example: 'AB12CD', description: "The referrer's code to apply" })
  @IsString()
  @Length(4, 12)
  code: string;

  @ApiProperty({ required: false, description: 'Stable device install id (anti-abuse)' })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  device_id?: string;
}
