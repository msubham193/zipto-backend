import { IsOptional, IsEnum, IsString, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum ReportPeriod {
  TODAY = 'today',
  YESTERDAY = 'yesterday',
  LAST_7_DAYS = 'last7days',
  LAST_30_DAYS = 'last30days',
  THIS_MONTH = 'thisMonth',
  LAST_MONTH = 'lastMonth',
  CUSTOM = 'custom',
}

export enum ReportType {
  BOOKINGS = 'bookings',
  REVENUE = 'revenue',
  DRIVERS = 'drivers',
  CUSTOMERS = 'customers',
}

export enum ExportFormat {
  CSV = 'csv',
  PDF = 'pdf',
}

export class ReportsQueryDto {
  @ApiPropertyOptional({
    enum: ReportPeriod,
    description: 'Time period for the report',
    default: ReportPeriod.LAST_30_DAYS,
  })
  @IsOptional()
  @IsEnum(ReportPeriod)
  period?: ReportPeriod = ReportPeriod.LAST_30_DAYS;

  @ApiPropertyOptional({
    description: 'Start date (YYYY-MM-DD) if period is custom',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'End date (YYYY-MM-DD) if period is custom',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by state (derived from the booking city)',
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({
    enum: ReportType,
    description: 'Type of report to export',
  })
  @IsOptional()
  @IsEnum(ReportType)
  type?: ReportType;

  @ApiPropertyOptional({
    enum: ExportFormat,
    description: 'Format for export',
  })
  @IsOptional()
  @IsEnum(ExportFormat)
  format?: ExportFormat;
}
