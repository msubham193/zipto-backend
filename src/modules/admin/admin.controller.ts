import { Controller, Get, Put, Post, Delete, Param, Query, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { BookingService } from '../booking/booking.service';
import { NotificationService } from '../notification/notification.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetBookingsDto } from './dto/get-bookings.dto';
import { PaginationDto } from './dto/pagination.dto';
import { ReportsQueryDto } from './dto/reports-query.dto';
import { CreatePricingRuleDto, UpdatePricingRuleDto } from './dto/pricing-rule.dto';
import { VehiclesQueryDto } from './dto/vehicles-query.dto';
import { SystemSettingsService } from '../settings/system-settings.service';

@ApiTags('Admin')
@Controller('admin')
@Roles('admin')
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly bookingService: BookingService,
    private readonly notificationService: NotificationService,
    private readonly systemSettings: SystemSettingsService,
  ) {}

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

  @Put('withdrawals/:id/approve')
  @ApiOperation({ summary: 'Approve a withdrawal request' })
  @ApiResponse({ status: 200, description: 'Withdrawal approved' })
  @ApiResponse({ status: 404, description: 'Withdrawal not found' })
  async approveWithdrawal(@Param('id') id: string, @Body('remarks') remarks?: string) {
    return this.adminService.approveWithdrawal(id, remarks);
  }

  @Put('withdrawals/:id/reject')
  @ApiOperation({ summary: 'Reject a withdrawal request (refunds wallet)' })
  @ApiResponse({ status: 200, description: 'Withdrawal rejected, wallet refunded' })
  @ApiResponse({ status: 404, description: 'Withdrawal not found' })
  async rejectWithdrawal(@Param('id') id: string, @Body('remarks') remarks?: string) {
    return this.adminService.rejectWithdrawal(id, remarks);
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
