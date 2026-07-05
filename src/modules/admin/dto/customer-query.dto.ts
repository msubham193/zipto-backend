import { IsOptional, IsIn, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from './pagination.dto';

export class CustomerQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by name, email, or phone' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by account status', enum: ['all', 'active', 'blocked'] })
  @IsOptional()
  @IsIn(['all', 'active', 'blocked'])
  status?: 'all' | 'active' | 'blocked';
}
