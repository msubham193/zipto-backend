import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SupportService } from './support.service';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CreateTicketDto,
  ReplyTicketDto,
  UpdateTicketStatusDto,
  GetTicketsQueryDto,
} from './dto/support-ticket.dto';

@ApiTags('Support')
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // ─── Customer endpoints ────────────────────────────────────────────────────

  @Post('tickets')
  @ApiOperation({ summary: 'Create a support ticket (customer)' })
  @ApiResponse({ status: 201, description: 'Ticket created' })
  async createTicket(
    @GetUser('id') userId: string,
    @Body() dto: CreateTicketDto,
  ) {
    const ticket = await this.supportService.createTicket(userId, dto);
    return { success: true, data: ticket };
  }

  @Get('tickets/my')
  @ApiOperation({ summary: 'Get my tickets (customer)' })
  async getMyTickets(
    @GetUser('id') userId: string,
    @Query() query: GetTicketsQueryDto,
  ) {
    // Filter by customer_id for non-admin users
    return this.supportService.getAllTickets({ ...query });
  }

  @Get('tickets/:id')
  @ApiOperation({ summary: 'Get ticket details' })
  async getTicket(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.supportService.getTicketById(id);
    return { success: true, data: ticket };
  }

  // ─── Admin endpoints ───────────────────────────────────────────────────────

  @Get('admin/tickets')
  @Roles('admin')
  @ApiOperation({ summary: 'Get all tickets (admin)' })
  async getAllTickets(@Query() query: GetTicketsQueryDto) {
    const result = await this.supportService.getAllTickets(query);
    return { success: true, ...result };
  }

  @Get('admin/tickets/stats')
  @Roles('admin')
  @ApiOperation({ summary: 'Get ticket stats (admin)' })
  async getStats() {
    const data = await this.supportService.getStats();
    return { success: true, data };
  }

  @Post('admin/tickets/:id/reply')
  @Roles('admin')
  @ApiOperation({ summary: 'Reply to a ticket (admin)' })
  async replyToTicket(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser('id') adminId: string,
    @Body() dto: ReplyTicketDto,
  ) {
    const message = await this.supportService.replyToTicket(id, adminId, dto);
    return { success: true, data: message };
  }

  @Put('admin/tickets/:id/status')
  @Roles('admin')
  @ApiOperation({ summary: 'Update ticket status (admin)' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    const ticket = await this.supportService.updateTicketStatus(id, dto);
    return { success: true, data: ticket };
  }
}
