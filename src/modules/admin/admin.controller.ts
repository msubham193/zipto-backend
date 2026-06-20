import { Controller, Get, Put, Post, Delete, Param, Query, Body, BadRequestException, Req, Headers } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { AdminService } from './admin.service';
import { AdminAccountService } from './admin-account.service';
import { ChangePasswordDto, CreateAdminDto, UpdateAdminStatusDto } from './dto/admin-account.dto';
import { BookingService } from '../booking/booking.service';
import { NotificationService } from '../notification/notification.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetBookingsDto } from './dto/get-bookings.dto';
import { PaginationDto } from './dto/pagination.dto';
import { ReportsQueryDto } from './dto/reports-query.dto';
import { CreatePricingRuleDto, UpdatePricingRuleDto } from './dto/pricing-rule.dto';
import { VehiclesQueryDto } from './dto/vehicles-query.dto';
import { SystemSettingsService } from '../settings/system-settings.service';
import { CouponService } from '../coupon/coupon.service';
import { CreateCouponDto, UpdateCouponDto } from '../coupon/dto/coupon.dto';
import { ReferralService } from '../referral/referral.service';
import { TransactionLogService } from '../transaction-log/transaction-log.service';

@ApiTags('Admin')
@Controller('admin')
@Roles('admin')
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly adminAccountService: AdminAccountService,
    private readonly bookingService: BookingService,
    private readonly notificationService: NotificationService,
    private readonly systemSettings: SystemSettingsService,
    private readonly couponService: CouponService,
    private readonly referralService: ReferralService,
    private readonly transactionLog: TransactionLogService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Account & team management (profile password change + super-admin team mgmt)
  // ─────────────────────────────────────────────────────────────────────────

  @Post('profile/change-password/send-otp')
  @ApiOperation({ summary: 'Email a verification code to confirm a password change' })
  async sendPasswordChangeOtp(@GetUser() user: User) {
    return this.adminAccountService.requestPasswordChangeOtp(user);
  }

  @Post('profile/change-password')
  @ApiOperation({ summary: 'Change own password (current password + email OTP)' })
  async changePassword(@GetUser() user: User, @Body() dto: ChangePasswordDto) {
    return this.adminAccountService.changePassword(user.id, dto);
  }

  @Get('team')
  @ApiOperation({ summary: 'List admin team members (super-admin only)' })
  async listAdmins(@GetUser() user: User) {
    return this.adminAccountService.listAdmins(user);
  }

  @Post('team')
  @ApiOperation({ summary: 'Create a new admin and email a temp password (super-admin only)' })
  async createAdmin(@GetUser() user: User, @Body() dto: CreateAdminDto) {
    return this.adminAccountService.createAdmin(user, dto);
  }

  @Put('team/:id/status')
  @ApiOperation({ summary: 'Enable/disable an admin (super-admin only)' })
  async setAdminStatus(
    @GetUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateAdminStatusDto,
  ) {
    return this.adminAccountService.setAdminStatus(user, id, dto.is_active);
  }

  @Post('team/:id/reset-password')
  @ApiOperation({ summary: 'Reset an admin password and email a new temp one (super-admin only)' })
  async resetAdminPassword(@GetUser() user: User, @Param('id') id: string) {
    return this.adminAccountService.resetAdminPassword(user, id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transaction ledger (unified audit log of every money/coin movement)
  // ─────────────────────────────────────────────────────────────────────────

  @Get('transactions')
  @ApiOperation({ summary: 'List all transactions (paginated, filterable)' })
  @ApiResponse({ status: 200, description: 'Transactions retrieved' })
  async getTransactions(
    @Query('userId') userId?: string,
    @Query('category') category?: string,
    @Query('gateway') gateway?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.transactionLog.adminList({
      userId,
      category,
      gateway,
      status,
      from,
      to,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('transactions/stats')
  @ApiOperation({ summary: 'Transaction totals grouped by category/direction' })
  @ApiResponse({ status: 200, description: 'Transaction stats retrieved' })
  async getTransactionStats(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.transactionLog.adminSummary({ from, to });
  }

  @Get('dashboard/stats')
  @ApiOperation({ summary: 'Get dashboard statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  @Get('drivers/pending')
  @ApiOperation({ summary: 'Get pending driver verifications' })
  @ApiResponse({ status: 200, description: 'Pending drivers retrieved' })
  async getPendingDrivers() {
    return this.adminService.getPendingDriverVerifications();
  }

  @Put('drivers/:id/approve')
  @ApiOperation({ summary: 'Approve driver verification' })
  @ApiResponse({ status: 200, description: 'Driver approved' })
  async approveDriver(@Param('id') id: string) {
    return this.adminService.approveDriver(id);
  }

  @Put('drivers/:id/reject')
  @ApiOperation({ summary: 'Reject driver verification' })
  @ApiResponse({ status: 200, description: 'Driver rejected' })
  async rejectDriver(@Param('id') id: string) {
    return this.adminService.rejectDriver(id);
  }

  @Put('drivers/:id/suspend')
  @ApiOperation({ summary: 'Suspend a driver' })
  @ApiResponse({ status: 200, description: 'Driver suspended' })
  async suspendDriver(@Param('id') id: string, @Body('reason') reason?: string) {
    return this.adminService.suspendDriver(id, reason);
  }

  @Put('drivers/:id/activate')
  @ApiOperation({ summary: 'Activate a suspended driver' })
  @ApiResponse({ status: 200, description: 'Driver activated' })
  async activateDriver(@Param('id') id: string) {
    return this.adminService.activateDriver(id);
  }

  @Get('vehicles/pending')
  @ApiOperation({ summary: 'Get pending vehicle verifications' })
  @ApiResponse({ status: 200, description: 'Pending vehicles retrieved' })
  async getPendingVehicles() {
    return this.adminService.getPendingVehicleVerifications();
  }

  @Get('vehicles')
  @ApiOperation({ summary: 'Get all vehicles with pagination, optional status/search filter' })
  @ApiResponse({ status: 200, description: 'Vehicles retrieved' })
  async getAllVehicles(@Query() query: VehiclesQueryDto) {
    return this.adminService.getAllVehicles(query);
  }

  @Get('vehicles/:id')
  @ApiOperation({ summary: 'Get vehicle complete details by ID' })
  @ApiResponse({ status: 200, description: 'Vehicle details retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Vehicle not found' })
  async getVehicleById(@Param('id') id: string) {
    return this.adminService.getVehicleById(id);
  }

  @Put('vehicles/:id/approve')
  @ApiOperation({ summary: 'Approve vehicle' })
  @ApiResponse({ status: 200, description: 'Vehicle approved' })
  async approveVehicle(@Param('id') id: string) {
    return this.adminService.approveVehicle(id);
  }

  @Put('vehicles/:id/reject')
  @ApiOperation({ summary: 'Reject vehicle' })
  @ApiResponse({ status: 200, description: 'Vehicle rejected' })
  async rejectVehicle(@Param('id') id: string) {
    return this.adminService.rejectVehicle(id);
  }

  @Get('bookings')
  @ApiOperation({ summary: 'Get all bookings with filters' })
  @ApiResponse({ status: 200, description: 'Bookings retrieved' })
  async getAllBookings(@Query() query: GetBookingsDto) {
    return this.adminService.getAllBookings(query);
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'Get booking details by ID' })
  @ApiResponse({ status: 200, description: 'Booking retrieved' })
  async getBookingById(@Param('id') id: string) {
    return this.adminService.getBookingById(id);
  }

  @Get('bookings/:id/tracking')
  @ApiOperation({ summary: 'Get booking live tracking info' })
  @ApiResponse({ status: 200, description: 'Tracking info retrieved' })
  @ApiResponse({ status: 404, description: 'Booking not found' })
  async getBookingTracking(@Param('id') id: string) {
    return this.adminService.getBookingTracking(id);
  }

  @Put('bookings/:id/cancel')
  @ApiOperation({ summary: 'Cancel booking as admin' })
  @ApiResponse({ status: 200, description: 'Booking cancelled' })
  async cancelBooking(@Param('id') id: string, @Body('reason') reason: string) {
    return this.adminService.cancelBooking(id, reason || 'Cancelled by admin');
  }

  @Put('bookings/:id/reassign')
  @ApiOperation({ summary: 'Reassign booking to a different driver' })
  @ApiResponse({ status: 200, description: 'Booking reassigned' })
  async reassignBooking(@Param('id') id: string, @Body('driverId') driverId: string) {
    return this.adminService.reassignBooking(id, driverId);
  }

  @Get('analytics')
  @ApiOperation({ summary: 'Get analytics data (last 30 days)' })
  @ApiResponse({ status: 200, description: 'Analytics retrieved' })
  async getAnalytics() {
    return this.adminService.getAnalytics();
  }

  @Get('customers')
  @ApiOperation({ summary: 'Get all customers with pagination' })
  @ApiResponse({ status: 200, description: 'Customers retrieved' })
  async getAllCustomers(@Query() query: PaginationDto) {
    return this.adminService.getAllCustomers(query);
  }

  @Get('customers/:id')
  @ApiOperation({ summary: 'Get customer by ID with stats' })
  @ApiResponse({ status: 200, description: 'Customer retrieved' })
  async getCustomerById(@Param('id') id: string) {
    return this.adminService.getCustomerById(id);
  }

  @Get('customers/:id/bookings')
  @ApiOperation({ summary: 'Get customer booking history' })
  @ApiResponse({ status: 200, description: 'Bookings retrieved' })
  async getCustomerBookings(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getCustomerBookings(id, { page, limit });
  }

  @Get('customers/:id/payments')
  @ApiOperation({ summary: 'Get customer payment history' })
  @ApiResponse({ status: 200, description: 'Payments retrieved' })
  async getCustomerPayments(
    @Param('id') id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getCustomerPayments(id, { page, limit });
  }

  @Get('drivers')
  @ApiOperation({ summary: 'Get all drivers with pagination' })
  @ApiResponse({ status: 200, description: 'Drivers retrieved' })
  async getAllDrivers(@Query() query: PaginationDto) {
    return this.adminService.getAllDrivers(query);
  }

  // NOTE: must be declared before 'drivers/:id' so 'live' isn't matched as an id.
  @Get('drivers/live')
  @ApiOperation({ summary: 'Live feed of online/busy drivers with GPS location' })
  @ApiResponse({ status: 200, description: 'Live drivers retrieved' })
  async getLiveDrivers() {
    return this.adminService.getLiveDrivers();
  }

  @Get('drivers/:id')
  @ApiOperation({ summary: 'Get driver details by ID' })
  @ApiResponse({ status: 200, description: 'Driver details retrieved' })
  @ApiResponse({ status: 404, description: 'Driver not found' })
  async getDriverById(@Param('id') id: string) {
    return this.adminService.getDriverById(id);
  }

  @Get('drivers/:id/kyc')
  @ApiOperation({ summary: 'Get driver KYC documents' })
  @ApiResponse({ status: 200, description: 'KYC documents retrieved' })
  @ApiResponse({ status: 404, description: 'Driver not found' })
  async getDriverKyc(@Param('id') id: string) {
    return this.adminService.getDriverKyc(id);
  }

  @Get('reports/bookings')
  @ApiOperation({ summary: 'Get booking reports' })
  @ApiResponse({ status: 200, description: 'Booking reports retrieved' })
  async getBookingReports(@Query() query: ReportsQueryDto) {
    return this.adminService.getBookingReports(query);
  }

  @Get('reports/revenue')
  @ApiOperation({ summary: 'Get revenue reports' })
  @ApiResponse({ status: 200, description: 'Revenue reports retrieved' })
  async getRevenueReports(@Query() query: ReportsQueryDto) {
    return this.adminService.getRevenueReports(query);
  }

  @Get('reports/gst')
  @ApiOperation({ summary: 'GST collected report — per-booking GST mapped to GSTIN + customer' })
  @ApiResponse({ status: 200, description: 'GST report retrieved' })
  async getGstReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('gstin') gstin?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getGstReport({
      from,
      to,
      gstin,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('reports/gst/invoice/:bookingId')
  @ApiOperation({ summary: 'Generate the GST/tax invoice for a single booking' })
  @ApiResponse({ status: 200, description: 'Invoice generated' })
  async getGstInvoice(@Param('bookingId') bookingId: string) {
    return this.adminService.getGstInvoice(bookingId);
  }

  @Get('reports/drivers')
  @ApiOperation({ summary: 'Get driver performance reports' })
  @ApiResponse({ status: 200, description: 'Driver reports retrieved' })
  async getDriverReports(@Query() query: ReportsQueryDto) {
    return this.adminService.getDriverReports(query);
  }

  @Get('reports/customers')
  @ApiOperation({ summary: 'Get customer analytics' })
  @ApiResponse({ status: 200, description: 'Customer reports retrieved' })
  async getCustomerReports(@Query() query: ReportsQueryDto) {
    return this.adminService.getCustomerReports(query);
  }

  @Get('reports/export')
  @ApiOperation({ summary: 'Export reports' })
  @ApiResponse({ status: 200, description: 'Report exported' })
  async exportReports(@Query() query: ReportsQueryDto) {
    return this.adminService.exportReports(query);
  }

  // --- Pricing Rules CRUD ---

  @Post('pricing-rules/seed')
  @ApiOperation({ summary: 'Seed default pricing rules' })
  @ApiResponse({ status: 201, description: 'Pricing rules seeded' })
  async seedPricingRules() {
    return this.adminService.seedPricingRules();
  }

  @Get('pricing-rules')
  @ApiOperation({ summary: 'Get all pricing rules' })
  @ApiResponse({ status: 200, description: 'Pricing rules retrieved' })
  async getPricingRules() {
    return this.bookingService.getAllPricingRules();
  }

  @Post('pricing-rules')
  @ApiOperation({ summary: 'Create a pricing rule' })
  @ApiResponse({ status: 201, description: 'Pricing rule created' })
  async createPricingRule(@Body() data: CreatePricingRuleDto) {
    return this.bookingService.createPricingRule(data);
  }

  @Put('pricing-rules/:id')
  @ApiOperation({ summary: 'Update a pricing rule' })
  @ApiResponse({ status: 200, description: 'Pricing rule updated' })
  async updatePricingRule(@Param('id') id: string, @Body() data: UpdatePricingRuleDto) {
    return this.bookingService.updatePricingRule(id, data);
  }

  @Delete('pricing-rules/:id')
  @ApiOperation({ summary: 'Delete a pricing rule' })
  @ApiResponse({ status: 200, description: 'Pricing rule deleted' })
  async deletePricingRule(@Param('id') id: string) {
    return this.bookingService.deletePricingRule(id);
  }

  // ─── Admin Notifications ───────────────────────────────────────────────────

  @Get('notifications')
  @ApiOperation({ summary: 'Get admin notifications' })
  @ApiResponse({ status: 200, description: 'Notifications retrieved' })
  async getAdminNotifications() {
    const data = await this.notificationService.getAdminNotifications();
    return { success: true, data };
  }

  @Post('notifications/read-all')
  @ApiOperation({ summary: 'Mark all admin notifications as read' })
  @ApiResponse({ status: 201, description: 'Marked as read' })
  async markAdminNotificationsRead() {
    await this.notificationService.markAdminNotificationsRead();
    return { success: true };
  }

  @Delete('notifications/clear')
  @ApiOperation({ summary: 'Clear all admin notifications' })
  @ApiResponse({ status: 200, description: 'Notifications cleared' })
  async clearAdminNotifications() {
    await this.notificationService.clearAdminNotifications();
    return { success: true };
  }

  @Get('payments')
  @ApiOperation({ summary: 'Get all payments with pagination' })
  @ApiResponse({ status: 200, description: 'Payments retrieved' })
  async getAllPayments(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
  ) {
    return this.adminService.getAllPayments({ page, limit, status });
  }

  // ─── Withdrawal Management ────────────────────────────────────────────────

  @Get('withdrawals')
  @ApiOperation({ summary: 'Get all withdrawal requests' })
  @ApiResponse({ status: 200, description: 'Withdrawal requests retrieved' })
  async getWithdrawals(@Query('status') status?: string) {
    return this.adminService.getWithdrawals(status);
  }

  @Get('driver-earnings')
  @ApiOperation({ summary: 'Per-driver earnings overview (earnings, wallet, withdrawals)' })
  @ApiResponse({ status: 200, description: 'Driver earnings retrieved' })
  async getDriverEarnings(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getDriverEarnings({
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Put('withdrawals/:id/approve')
  @ApiOperation({ summary: 'Approve a withdrawal request' })
  @ApiResponse({ status: 200, description: 'Withdrawal approved' })
  @ApiResponse({ status: 404, description: 'Withdrawal not found' })
  async approveWithdrawal(
    @Param('id') id: string,
    @Body('remarks') remarks?: string,
    @Body('payout_reference') payoutReference?: string,
  ) {
    return this.adminService.approveWithdrawal(id, remarks, payoutReference);
  }

  @Put('withdrawals/:id/reject')
  @ApiOperation({ summary: 'Reject a withdrawal request (refunds wallet)' })
  @ApiResponse({ status: 200, description: 'Withdrawal rejected, wallet refunded' })
  @ApiResponse({ status: 404, description: 'Withdrawal not found' })
  async rejectWithdrawal(@Param('id') id: string, @Body('remarks') remarks?: string) {
    return this.adminService.rejectWithdrawal(id, remarks);
  }

  // ─── Cashfree Payouts Webhook (no auth — verified by HMAC) ──────────────

  @Public()
  @Post('webhooks/cashfree-payout')
  @ApiOperation({ summary: 'Cashfree Payouts webhook — do not call manually' })
  async cashfreePayoutWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature: string,
    @Headers('x-webhook-timestamp') timestamp: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    await this.adminService.handlePayoutWebhook(rawBody, signature ?? '', timestamp ?? '');
    return { received: true };
  }

  // ─── System Settings ──────────────────────────────────────────────────────

  @Get('settings')
  @ApiOperation({ summary: 'Get all system settings' })
  @ApiResponse({ status: 200, description: 'Settings retrieved' })
  async getSettings() {
    const rows = await this.systemSettings.getAll();
    return { success: true, data: rows };
  }

  @Put('settings/:key')
  @ApiOperation({ summary: 'Update a system setting by key' })
  @ApiResponse({ status: 200, description: 'Setting updated' })
  async updateSetting(
    @Param('key') key: string,
    @Body('value') value: string,
  ) {
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new BadRequestException('value is required');
    }
    const updated = await this.systemSettings.update(key, String(value));
    return { success: true, data: updated };
  }

  // ─── UPI Topup Requests ───────────────────────────────────────────────────

  @Get('topup-requests')
  @ApiOperation({ summary: 'List driver UPI top-up requests' })
  async getTopupRequests(@Query('status') status?: string) {
    return this.adminService.getTopupRequests(status);
  }

  @Put('topup-requests/:id/approve')
  @ApiOperation({ summary: 'Approve top-up request and credit driver wallet' })
  async approveTopupRequest(@Param('id') id: string) {
    return this.adminService.approveTopupRequest(id);
  }

  @Put('topup-requests/:id/reject')
  @ApiOperation({ summary: 'Reject top-up request' })
  async rejectTopupRequest(@Param('id') id: string, @Body('remarks') remarks?: string) {
    return this.adminService.rejectTopupRequest(id, remarks);
  }

  // ─── Driver Wallet Manual Credit ─────────────────────────────────────────

  @Put('drivers/:id/wallet/credit')
  @ApiOperation({ summary: 'Manually credit a driver wallet (e.g. after cash top-up receipt)' })
  @ApiResponse({ status: 200, description: 'Wallet credited' })
  async creditDriverWallet(
    @Param('id') driverId: string,
    @Body('amount') amount: number,
    @Body('note') note?: string,
  ) {
    if (!amount || amount <= 0) throw new BadRequestException('amount must be > 0');
    return this.adminService.adminCreditDriverWallet(driverId, amount, note ?? 'Admin credit');
  }

  // ─── Coupon / Promo Code Management ──────────────────────────────────────

  @Get('coupons')
  @ApiOperation({ summary: 'List all coupons (active + inactive)' })
  @ApiResponse({ status: 200, description: 'Coupons retrieved' })
  async getCoupons() {
    return this.couponService.findAll(true);
  }

  @Post('coupons')
  @ApiOperation({ summary: 'Create a new coupon' })
  @ApiResponse({ status: 201, description: 'Coupon created' })
  async createCoupon(@Body() dto: CreateCouponDto) {
    return this.couponService.create(dto);
  }

  @Put('coupons/:id')
  @ApiOperation({ summary: 'Update coupon by ID' })
  @ApiResponse({ status: 200, description: 'Coupon updated' })
  async updateCoupon(@Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.couponService.update(id, dto);
  }

  @Delete('coupons/:id')
  @ApiOperation({ summary: 'Delete coupon by ID' })
  @ApiResponse({ status: 200, description: 'Coupon deleted' })
  async deleteCoupon(@Param('id') id: string) {
    return this.couponService.remove(id);
  }

  @Get('coupons/:id/stats')
  @ApiOperation({ summary: 'Get coupon usage stats' })
  @ApiResponse({ status: 200, description: 'Stats retrieved' })
  async getCouponStats(@Param('id') id: string) {
    return this.couponService.getUsageStats(id);
  }

  // ─── Referral Management ─────────────────────────────────────────────────────

  @Get('referrals')
  @ApiOperation({ summary: 'List referrals (referrer, referee, status, coins)' })
  @ApiResponse({ status: 200, description: 'Referrals retrieved' })
  async getReferrals(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.referralService.adminList({
      status,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('referrals/stats')
  @ApiOperation({ summary: 'Referral program summary stats' })
  @ApiResponse({ status: 200, description: 'Stats retrieved' })
  async getReferralStats() {
    return this.referralService.adminStats();
  }

  @Delete('drivers/:id/reset-data')
  @ApiOperation({ summary: 'Reset a single driver — clears earnings, wallet, trips and ride history' })
  @ApiResponse({ status: 200, description: 'Driver data cleared' })
  async resetDriverData(
    @Param('id') id: string,
    @Body('confirm') confirm: string,
  ) {
    if (confirm !== 'RESET_DRIVER') {
      throw new BadRequestException('Pass { "confirm": "RESET_DRIVER" } in body to proceed');
    }
    return this.adminService.resetDriverData(id);
  }

  // ─── Data Reset (dev/test only) ───────────────────────────────────────────

  @Delete('data/reset')
  @ApiOperation({ summary: 'Delete all trips, earnings, wallet data and reset driver counters' })
  @ApiResponse({ status: 200, description: 'All data cleared' })
  async resetAllData(@Body('confirm') confirm: string) {
    if (confirm !== 'RESET_ALL_DATA') {
      throw new BadRequestException('Pass { "confirm": "RESET_ALL_DATA" } in body to proceed');
    }
    return this.adminService.resetAllData();
  }
}
