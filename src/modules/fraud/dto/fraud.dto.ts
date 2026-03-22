import { IsEnum, IsOptional, IsString, IsUUID, IsInt, IsIn, IsBoolean, MinLength } from 'class-validator';

export enum ReportReason {
  NO_SHOW = 'no_show',
  ABUSIVE_BEHAVIOR = 'abusive_behavior',
  FAKE_ADDRESS = 'fake_address',
  REPEATED_CANCELLATIONS = 'repeated_cancellations',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  OTHER = 'other',
}

export class ReportCustomerDto {
  @IsUUID()
  booking_id: string;

  @IsEnum(ReportReason)
  reason: ReportReason;

  @IsOptional()
  @IsString()
  description?: string;
}

export class BlockCustomerDto {
  @IsString()
  @MinLength(5)
  reason: string;

  @IsInt()
  @IsIn([1, 3, 7, 30])
  duration_days: number;
}

export class ProcessUnblockDto {
  @IsEnum(['approved', 'rejected'])
  status: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  admin_notes?: string;
}

export class SubmitUnblockRequestDto {
  @IsString()
  @MinLength(10)
  reason: string;
}

export class GetReportsQueryDto {
  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  report_type?: string;

  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  is_resolved?: string;
}

export class GetUnblockRequestsQueryDto {
  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsString()
  status?: string;
}
