import { Controller, Get, Post, Put, Param, Query, Body, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FraudService } from './fraud.service';
import { BlockCustomerDto, GetReportsQueryDto, GetUnblockRequestsQueryDto, ProcessUnblockDto, SubmitUnblockRequestDto } from './dto/fraud.dto';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Fraud')
@ApiBearerAuth()
@Controller('admin')
export class FraudController {
  constructor(private readonly fraudService: FraudService) {}

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
}
