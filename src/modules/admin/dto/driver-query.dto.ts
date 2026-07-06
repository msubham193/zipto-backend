import { IsOptional, IsIn, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from './pagination.dto';
import { VerificationStatus } from '../../driver/entities/driver-profile.entity';
import { VehicleType } from '../../vehicle/entities/vehicle.entity';

export class DriverQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search by driver name, phone, or vehicle registration number' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by driver account status',
    enum: ['all', 'active', 'suspended', 'pending_approval'],
  })
  @IsOptional()
  @IsIn(['all', 'active', 'suspended', 'pending_approval'])
  status?: 'all' | 'active' | 'suspended' | 'pending_approval';

  @ApiPropertyOptional({ enum: VerificationStatus, description: 'Filter by KYC verification status' })
  @IsOptional()
  @IsEnum(VerificationStatus)
  kycStatus?: VerificationStatus;

  @ApiPropertyOptional({ enum: VehicleType, description: 'Filter by vehicle type' })
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;
}
