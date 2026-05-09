import { Controller, Get, Post, Put, Param, Query, Body, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FraudService } from './fraud.service';
import { BlockCustomerDto, GetReportsQueryDto, GetUnblockRequestsQueryDto, ProcessUnblockDto, SubmitUnblockRequestDto } from './dto/fraud.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { DriverFraudService } from '../driver-fraud/driver-fraud.service';
import { DriverFraudStatus } from '../driver-fraud/entities/driver-fraud-incident.entity';

@ApiTags('Fraud')
@ApiBearerAuth()
@Controller('admin')
export class FraudController {
  constructor(
    private readonly fraudService: FraudService,
    private readonly driverFraudService: DriverFraudService,
  ) {}

  // ─── Admin: Reports ──────────────────────────────────────────────────────────

  @Get('fraud/reports')
  @Roles('admin')
  @ApiOperation({ summary: 'Get all fraud reports' })
  async getReports(@Query() query: GetReportsQueryDto) {
    return this.fraudService.getReports(query);
  }

  @Put('fraud/reports/:id/resolve')
  @Roles('admin')
  @ApiOperation({ summary: 'Resolve a fraud report' })
  async resolveReport(@Param('id') id: string, @Request() req: any) {
    return this.fraudService.resolveReport(id, req.user?.sub || req.user?.id);
  }

  @Get('customers/:id/reports')
  @Roles('admin')
  @ApiOperation({ summary: 'Get reports for a specific customer' })
  async getCustomerReports(@Param('id') customerId: string) {
    return this.fraudService.getReports({ customer_id: customerId, limit: 50 });
  }

  @Get('customers/:id/blocks')
  @Roles('admin')
  @ApiOperation({ summary: 'Get block history for a customer' })
  async getBlockHistory(@Param('id') customerId: string) {
    return this.fraudService.getBlockHistory(customerId);
  }

  @Post('customers/:id/block')
  @Roles('admin')
  @ApiOperation({ summary: 'Temporarily block a customer' })
  async blockCustomer(
    @Param('id') customerId: string,
    @Body() dto: BlockCustomerDto,
    @Request() req: any,
  ) {
    return this.fraudService.blockCustomer(req.user?.sub || req.user?.id, customerId, dto);
  }

  @Put('customers/:id/unblock')
  @Roles('admin')
  @ApiOperation({ summary: 'Unblock a customer immediately' })
  async unblockCustomer(@Param('id') customerId: string, @Request() req: any) {
    await this.fraudService.unblockCustomer(req.user?.sub || req.user?.id, customerId);
    return { message: 'Customer unblocked successfully' };
  }

  // ─── Admin: Unblock Requests ─────────────────────────────────────────────────

  @Get('fraud/unblock-requests')
  @Roles('admin')
  @ApiOperation({ summary: 'Get unblock requests' })
  async getUnblockRequests(@Query() query: GetUnblockRequestsQueryDto) {
    return this.fraudService.getUnblockRequests(query);
  }

  @Put('fraud/unblock-requests/:blockId/process')
  @Roles('admin')
  @ApiOperation({ summary: 'Approve or reject an unblock request' })
  async processUnblockRequest(
    @Param('blockId') blockId: string,
    @Body() dto: ProcessUnblockDto,
    @Request() req: any,
  ) {
    return this.fraudService.processUnblockRequest(blockId, req.user?.sub || req.user?.id, dto);
  }

  // ─── Admin: Intelligent Fraud Detection ──────────────────────────────────────

  @Get('fraud/intelligence/overview')
  @Roles('admin')
  @ApiOperation({ summary: 'Fraud intelligence overview — aggregate stats + recent incidents' })
  async getFraudIntelligenceOverview() {
    return this.driverFraudService.getIntelligenceOverview();
  }

  @Get('fraud/intelligence/driver-risk')
  @Roles('admin')
  @ApiOperation({ summary: 'Driver risk scores — ranked by computed risk score 0–100' })
  async getDriverRiskScores(@Query('limit') limit?: number) {
    return this.driverFraudService.getDriverRiskScores(limit ? Number(limit) : 20);
  }

  @Get('fraud/intelligence/flagged-bookings')
  @Roles('admin')
  @ApiOperation({ summary: 'Active deliveries currently flagged by a fraud guard' })
  async getFlaggedActiveBookings() {
    return this.driverFraudService.getFlaggedActiveBookings();
  }

  // ─── Admin: Driver Fraud Incidents ───────────────────────────────────────────

  @Get('fraud/driver-incidents')
  @Roles('admin')
  @ApiOperation({ summary: 'List driver fraud incidents (abandoned deliveries)' })
  async listDriverIncidents(
    @Query('status') status?: DriverFraudStatus,
    @Query('driver_id') driver_id?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.driverFraudService.listIncidents({ status, driver_id, limit, offset });
  }

  @Get('fraud/driver-incidents/:id')
  @Roles('admin')
  @ApiOperation({ summary: 'Get a single driver fraud incident' })
  async getDriverIncident(@Param('id') id: string) {
    return this.driverFraudService.getIncident(id);
  }

  @Post('fraud/driver-incidents/:id/confirm')
  @Roles('admin')
  @ApiOperation({ summary: 'Confirm driver fraud — bans driver and cancels booking' })
  async confirmDriverFraud(
    @Param('id') id: string,
    @Body('notes') notes: string,
    @Request() req: any,
  ) {
    return this.driverFraudService.confirmFraud(id, req.user?.sub || req.user?.id, notes);
  }

  @Post('fraud/driver-incidents/:id/clear')
  @Roles('admin')
  @ApiOperation({ summary: 'Clear driver fraud incident (false positive) — unfreezes wallet' })
  async clearDriverIncident(
    @Param('id') id: string,
    @Body('notes') notes: string,
    @Request() req: any,
  ) {
    return this.driverFraudService.clearIncident(id, req.user?.sub || req.user?.id, notes);
  }
}
