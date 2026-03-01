import { Controller, Get, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { CoinService } from './coin.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Coins')
@Controller('coins')
@ApiBearerAuth()
export class CoinController {
  constructor(private readonly coinService: CoinService) {}

  @Get('balance')
  @Roles('customer')
  @ApiOperation({ summary: 'Get coin balance and rupee value' })
  @ApiResponse({ status: 200, description: 'Coin balance retrieved' })
  async getBalance(@GetUser() user: User) {
    return this.coinService.getBalance(user.id);
  }

  @Get('history')
  @Roles('customer')
  @ApiOperation({ summary: 'Get coin transaction history' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Coin history retrieved' })
  async getHistory(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.coinService.getHistory(user.id, page, limit);
  }
}
