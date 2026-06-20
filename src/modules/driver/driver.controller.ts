import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Query,
  Param,
  ParseIntPipe,
  DefaultValuePipe,
  UseInterceptors,
  UploadedFiles,
  ParseFloatPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { DriverService } from './driver.service';
import { DriverWalletService, WALLET_SUSPENSION_THRESHOLD } from './driver-wallet.service';
import { SystemSettingsService } from '../settings/system-settings.service';
import {
  UpdateDriverDto,
  UpdateAvailabilityDto,
  UpdateLocationDto,
  OnboardDriverDto,
} from './dto/driver.dto';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto/bank-account.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { VehicleType } from '../vehicle/entities/vehicle.entity';

@ApiTags('Driver')
@Controller('driver')
@Roles('driver')
@ApiBearerAuth()
export class DriverController {
  constructor(
    private readonly driverService: DriverService,
    private readonly driverWalletService: DriverWalletService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get driver profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@GetUser() user: User) {
    return this.driverService.getProfile(user.id);
  }

  @Get('verification-status')
  @ApiOperation({ summary: 'Get driver verification status' })
  @ApiResponse({ status: 200, description: 'Verification status retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getVerificationStatus(@GetUser() user: User) {
    return this.driverService.getVerificationStatus(user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update driver profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateProfile(@GetUser() user: User, @Body() updateDriverDto: UpdateDriverDto) {
    return this.driverService.updateProfile(user.id, updateDriverDto);
  }

  @Put('availability')
  @ApiOperation({ summary: 'Update driver availability status' })
  @ApiResponse({ status: 200, description: 'Availability updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateAvailability(
    @GetUser() user: User,
    @Body() updateAvailabilityDto: UpdateAvailabilityDto,
  ) {
    return this.driverService.updateAvailability(user.id, updateAvailabilityDto);
  }

  @Put('location')
  @ApiOperation({ summary: 'Update driver current location' })
  @ApiResponse({ status: 200, description: 'Location updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateLocation(@GetUser() user: User, @Body() updateLocationDto: UpdateLocationDto) {
    return this.driverService.updateLocation(user.id, updateLocationDto);
  }

  @Get('earnings')
  @ApiOperation({
    summary: 'Get driver earnings dashboard',
    description:
      'Returns total earnings, trip count, fare breakdown, and current wallet balance for the given period (today / week / month).',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month'],
    example: 'today',
  })
  @ApiResponse({
    status: 200,
    description: 'Earnings dashboard retrieved successfully',
    schema: {
      example: {
        period: 'today',
        wallet_balance: 4500.0,
        total_earnings: 2850.0,
        trip_count: 12,
        breakdown: {
          base_fare: 1800.0,
          distance_charge: 600.0,
          other_charges: 450.0,
          platform_fee: 570.0,
          gross_fare: 3420.0,
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getEarnings(
    @GetUser() user: User,
    @Query('period') period: string = 'today',
  ) {
    const resolved: 'today' | 'week' | 'month' | 'all' =
      period === 'week' ? 'week' : period === 'month' ? 'month' : period === 'all' ? 'all' : 'today';
    return this.driverService.getEarningsDashboard(user.id, resolved);
  }

  @Post('earnings/withdraw')
  @ApiOperation({
    summary: 'Request a wallet withdrawal',
    description:
      'Deducts the requested amount from the driver wallet balance and creates a pending withdrawal request. Minimum ₹100.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: { type: 'number', example: 1000 },
        bank_account_id: {
          type: 'string',
          format: 'uuid',
          description: 'Optional. Defaults to primary bank account.',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Withdrawal request created',
    schema: {
      example: {
        success: true,
        message: 'Withdrawal request submitted successfully',
        withdrawal_id: 'uuid',
        amount: 1000,
        remaining_balance: 3500.0,
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Insufficient balance or amount too low' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async requestWithdrawal(
    @GetUser() user: User,
    @Body('amount') amount: number,
    @Body('bank_account_id') bankAccountId?: string,
  ) {
    return this.driverService.requestWithdrawal(user.id, Number(amount), bankAccountId);
  }

  @Get('earnings/withdrawals')
  @ApiOperation({ summary: 'Get withdrawal request history' })
  @ApiResponse({ status: 200, description: 'Withdrawal history retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getWithdrawalHistory(@GetUser() user: User) {
    return this.driverService.getWithdrawalHistory(user.id);
  }

  @Get('daily-stats')
  @ApiOperation({ summary: 'Get driver daily statistics (earnings and orders)' })
  @ApiResponse({ status: 200, description: 'Daily stats retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getDailyStats(@GetUser() user: User) {
    return this.driverService.getDailyStats(user.id);
  }

  @Get('trips')
  @ApiOperation({ summary: 'Get driver trip history with pagination' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'status', required: false, type: String, example: 'completed' })
  @ApiResponse({ status: 200, description: 'Trip history retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getTripHistory(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.driverService.getTripHistory(user.id, page, limit, status);
  }

  @Get('calendar')
  @ApiOperation({
    summary: 'Get driver attendance calendar',
    description:
      'Returns per-day presence status, earnings, trip count, and hours worked for a given month or week. ' +
      'Use `period=month` with `year` + `month`, or `period=week` with optional `week_start` (YYYY-MM-DD, defaults to current Monday).',
  })
  @ApiQuery({ name: 'period', required: false, enum: ['month', 'week'], example: 'month' })
  @ApiQuery({ name: 'year', required: false, type: Number, example: 2024 })
  @ApiQuery({ name: 'month', required: false, type: Number, example: 3, description: '1–12' })
  @ApiQuery({
    name: 'week_start',
    required: false,
    type: String,
    example: '2024-03-04',
    description: 'ISO date (YYYY-MM-DD) of the Monday to start the week from (period=week only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Calendar data with per-day breakdown and summary',
    schema: {
      example: {
        period: 'month',
        year: 2024,
        month: 3,
        week_start: null,
        week_end: null,
        summary: {
          days_present: 18,
          total_days: 31,
          total_earnings: 45000,
          total_trips: 72,
          total_hours: 142.5,
        },
        days: [
          {
            date: '2024-03-01',
            day_of_week: 'Fri',
            is_present: true,
            earnings: 2850,
            trips: 4,
            hours_worked: 8.5,
            first_trip_at: '09:15',
            last_trip_at: '17:45',
          },
          {
            date: '2024-03-02',
            day_of_week: 'Sat',
            is_present: false,
            earnings: 0,
            trips: 0,
            hours_worked: 0,
            first_trip_at: null,
            last_trip_at: null,
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCalendar(
    @GetUser() user: User,
    @Query('period') period: string = 'month',
    @Query('year', new DefaultValuePipe(0), ParseIntPipe) year: number,
    @Query('month', new DefaultValuePipe(0), ParseIntPipe) month: number,
    @Query('week_start') weekStart?: string,
  ) {
    const now = new Date();
    const resolvedYear = year || now.getFullYear();
    const resolvedMonth = month || now.getMonth() + 1;
    const resolvedPeriod: 'month' | 'week' =
      period === 'week' ? 'week' : 'month';
    return this.driverService.getCalendar(
      user.id,
      resolvedPeriod,
      resolvedYear,
      resolvedMonth,
      weekStart,
    );
  }

  // ─── Bank Accounts ────────────────────────────────────────────────────────

  @Get('bank-accounts')
  @ApiOperation({ summary: '[Driver] Get all my bank accounts' })
  @ApiResponse({
    status: 200,
    description: 'List of bank accounts (primary first)',
    schema: {
      example: [
        {
          id: 'uuid',
          account_holder_name: 'Rahul Kumar',
          bank_name: 'State Bank of India',
          account_number: '123456789012',
          ifsc_code: 'SBIN0001234',
          branch: 'MG Road, Bangalore',
          account_type: 'savings',
          is_primary: true,
          is_verified: false,
          created_at: '2024-03-01T10:00:00.000Z',
        },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getBankAccounts(@GetUser() user: User) {
    return this.driverService.getBankAccounts(user.id);
  }

  @Post('bank-accounts')
  @ApiOperation({ summary: '[Driver] Add a bank account' })
  @ApiBody({ type: CreateBankAccountDto })
  @ApiResponse({
    status: 201,
    description: 'Bank account created. First account is auto-set as primary.',
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async addBankAccount(@GetUser() user: User, @Body() dto: CreateBankAccountDto) {
    return this.driverService.addBankAccount(user.id, dto);
  }

  @Put('bank-accounts/:id')
  @ApiOperation({ summary: '[Driver] Update a bank account' })
  @ApiBody({ type: UpdateBankAccountDto })
  @ApiResponse({ status: 200, description: 'Bank account updated' })
  @ApiResponse({ status: 404, description: 'Bank account not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateBankAccount(
    @GetUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.driverService.updateBankAccount(user.id, id, dto);
  }

  @Delete('bank-accounts/:id')
  @ApiOperation({ summary: '[Driver] Delete a bank account' })
  @ApiResponse({ status: 200, description: 'Bank account deleted' })
  @ApiResponse({ status: 404, description: 'Bank account not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async deleteBankAccount(@GetUser() user: User, @Param('id') id: string) {
    await this.driverService.deleteBankAccount(user.id, id);
    return { success: true };
  }

  @Put('bank-accounts/:id/primary')
  @ApiOperation({ summary: '[Driver] Set a bank account as primary' })
  @ApiResponse({ status: 200, description: 'Bank account set as primary' })
  @ApiResponse({ status: 404, description: 'Bank account not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async setPrimaryBankAccount(@GetUser() user: User, @Param('id') id: string) {
    return this.driverService.setPrimaryBankAccount(user.id, id);
  }

  @Post('onboard')
  @ApiOperation({ summary: 'Onboard driver with documents' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'John Driver' },
        email: { type: 'string', example: 'driver@example.com' },
        address: { type: 'string', example: '123 Main St, Bhubaneswar' },
        license_number: { type: 'string', example: 'OD02-20220001234' },
        license_expiry: { type: 'string', example: '2030-12-31' },
        vehicle_registration_number: { type: 'string', example: 'OD-02-A-1234' },
        vehicle_type: {
          type: 'string',
          example: VehicleType.SCOOTY,
          enum: Object.values(VehicleType),
        },
        vehicle_model: { type: 'string', example: 'Honda Activa' },
        vehicle_capacity: { type: 'number', example: 100 },
        aadhar_front: { type: 'string', format: 'binary' },
        aadhar_back: { type: 'string', format: 'binary' },
        driving_license: { type: 'string', format: 'binary' },
        vehicle_rc: { type: 'string', format: 'binary' },
        profile_photo: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'aadhar_front', maxCount: 1 },
      { name: 'aadhar_back', maxCount: 1 },
      { name: 'driving_license', maxCount: 1 },
      { name: 'vehicle_rc', maxCount: 1 },
      { name: 'profile_photo', maxCount: 1 },
    ]),
  )
  @ApiResponse({ status: 200, description: 'Driver onboarded successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async onboardDriver(
    @GetUser() user: User,
    @Body() onboardDriverDto: OnboardDriverDto,
    @UploadedFiles()
    files: {
      aadhar_front?: Express.Multer.File[];
      aadhar_back?: Express.Multer.File[];
      driving_license?: Express.Multer.File[];
      vehicle_rc?: Express.Multer.File[];
      profile_photo?: Express.Multer.File[];
    },
  ) {
    return this.driverService.onboardDriver(user.id, onboardDriverDto, files);
  }

  // ─── Wallet ───────────────────────────────────────────────────────────────

  // ─── Cashfree wallet top-up (native UPI-intent checkout, no fallback) ─────

  @Post('wallet/topup/cashfree/create-order')
  @ApiOperation({ summary: 'Create a Cashfree order for native wallet top-up (UPI intent)' })
  async createCashfreeTopupOrder(
    @GetUser() user: User,
    @Body('amount') amount: number,
  ) {
    if (!amount || amount < 10) throw new BadRequestException('Minimum top-up is ₹10');
    return this.driverService.createCashfreeTopupOrder(user.id, amount);
  }

  @Post('wallet/topup/cashfree/verify')
  @ApiOperation({ summary: 'Confirm a Cashfree top-up and credit the wallet (idempotent)' })
  async verifyCashfreeTopup(
    @GetUser() user: User,
    @Body('order_id') orderId: string,
  ) {
    if (!orderId) throw new BadRequestException('order_id is required');
    return this.driverService.verifyCashfreeTopup(user.id, orderId);
  }

  @Get('wallet/topup/requests')
  @ApiOperation({ summary: 'Get driver own topup request history' })
  async getMyTopupRequests(@GetUser() user: User) {
    return this.driverService.getDriverTopupRequests(user.id);
  }

  @Get('wallet')
  @ApiOperation({
    summary: '[Driver] Get wallet balance + recent transactions',
    description:
      'Returns current wallet balance and paginated transaction history. ' +
      'For cash trips, commission deductions will appear as negative entries. ' +
      'Top up if balance is low to avoid ride suspension.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({ status: 200, description: 'Wallet data' })
  async getWallet(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const { items, total, balance } =
      await this.driverWalletService.getTransactions(user.id, page, limit);
    return {
      balance,
      suspension_threshold: WALLET_SUSPENSION_THRESHOLD,
      low_balance_threshold: 100,
      is_suspended: balance < WALLET_SUSPENSION_THRESHOLD,
      transactions: {
        items,
        total,
        page,
        pages: Math.ceil(total / limit),
      },
    };
  }
}
