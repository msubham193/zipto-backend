import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class ApplyReferralDto {
  @ApiProperty({ example: 'AB12CD', description: "The referrer's code to apply" })
  @IsString()
  @Length(4, 12)
  code: string;
}
