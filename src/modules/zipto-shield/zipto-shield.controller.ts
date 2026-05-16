import { Controller, Get, Post, Body, Query, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ZiptoShieldService } from './zipto-shield.service';
import { WithdrawShieldDto, GetTransactionsQueryDto } from './dto/zipto-shield.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { ShieldTransactionType } from './entities/zipto-shield-transaction.entity';

@ApiTags('Zipto Shield')
@ApiBearerAuth()
@Controller('admin/zipto-shield')
@Roles('admin')
export class ZiptoShieldController {
  constructor(private readonly shieldService: ZiptoShieldService) {}

  @Get('balance')
  @ApiOperation({ summary: 'Get current shield fund balance and totals' })
  async getBalance() {
    return this.shieldService.getBalance();
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Get shield fund transaction history' })
  async getTransactions(@Query() query: GetTransactionsQueryDto) {
    return this.shieldService.getTransactions({
      type: query.type as ShieldTransactionType | undefined,
      page: query.page,
      limit: query.limit,
    });
  }

  @Post('withdraw')
  @ApiOperation({ summary: 'Withdraw from the shield fund (admin only)' })
  async withdraw(@Body() dto: WithdrawShieldDto, @Request() req: any) {
    const adminId = req.user?.sub || req.user?.id;
    return this.shieldService.withdraw(adminId, dto.amount, dto.notes);
  }
}