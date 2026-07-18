import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiProperty,
} from '@nestjs/swagger';
import { IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { CustomerService } from './customer.service';
import { UpdateCustomerDto, SavedLocationDto, UpdateCustomerPresenceDto } from './dto/customer.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

class InitiateAddMoneyDto {
  @ApiProperty({ example: 500, description: 'Amount in INR (min ₹10, max ₹50,000)' })
  @IsNumber()
  @Min(10)
  @Max(50000)
  @Type(() => Number)
  amount: number;
}


@ApiTags('Customer')
@Controller('customer')
@Roles('customer')
@ApiBearerAuth()
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────────────────────────────────

  @Get('profile')
  @ApiOperation({ summary: 'Get customer profile' })
  @ApiResponse({ status: 200 })
  async getProfile(@GetUser() user: User) {
    return this.customerService.getProfile(user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update customer profile' })
  @ApiResponse({ status: 200 })
  async updateProfile(
    @GetUser() user: User,
    @Body() updateCustomerDto: UpdateCustomerDto,
  ) {
    return this.customerService.updateProfile(user.id, updateCustomerDto);
  }

  @Get('saved-locations')
  @ApiOperation({ summary: 'Get all saved locations' })
  async getSavedLocations(@GetUser() user: User) {
    return this.customerService.getSavedLocations(user.id);
  }

  @Post('saved-locations')
  @ApiOperation({ summary: 'Add saved location' })
  async addSavedLocation(
    @GetUser() user: User,
    @Body() locationDto: SavedLocationDto,
  ) {
    return this.customerService.addSavedLocation(user.id, locationDto);
  }

  @Delete('saved-locations/:index')
  @ApiOperation({ summary: 'Delete saved location by index' })
  async removeSavedLocation(
    @GetUser() user: User,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.customerService.removeSavedLocation(user.id, index);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Live presence — real-time "app is open here" signal for the driver-facing
  // live heatmap. Ephemeral (2 min TTL in Redis), never persisted to Postgres.
  // ─────────────────────────────────────────────────────────────────────────

  @Put('presence')
  @ApiOperation({
    summary: 'Ping current location while the app is open (foreground only)',
    description:
      'Powers the driver-facing live demand heatmap. The app should call this periodically ' +
      'only while in the foreground — presence expires automatically 2 minutes after the last ping.',
  })
  async updatePresence(@GetUser() user: User, @Body() dto: UpdateCustomerPresenceDto) {
    return this.customerService.updatePresence(user.id, dto.latitude, dto.longitude);
  }

  @Get('live-heatmap')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Live heatmap of customers currently using the app',
    description:
      'Aggregates real-time customer presence pings into anonymous grid cells — no individual ' +
      'identity or exact location is exposed, only per-area counts.',
  })
  async getLiveHeatmap() {
    return this.customerService.getLiveHeatmap();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wallet
  // ─────────────────────────────────────────────────────────────────────────

  @Get('wallet')
  @ApiOperation({ summary: 'Get wallet balance + recent 20 transactions' })
  async getWallet(@GetUser() user: User) {
    const data = await this.customerService.getWallet(user.id);
    return { success: true, data };
  }

  @Get('wallet/transactions')
  @ApiOperation({ summary: 'Full wallet transaction history (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getTransactions(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const data = await this.customerService.getWalletTransactions(
      user.id,
      page,
      limit,
    );
    return { success: true, data };
  }

  @Post('wallet/add-money/initiate')
  @ApiOperation({ summary: 'Create Razorpay order for wallet top-up' })
  async initiateAddMoney(
    @GetUser() user: User,
    @Body() dto: InitiateAddMoneyDto,
  ) {
    const data = await this.customerService.initiateAddMoney(user.id, dto.amount);
    return { success: true, data };
  }

}
