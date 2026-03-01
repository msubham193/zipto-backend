import { Controller, Get, Put, Post, Delete, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { BookingService } from '../booking/booking.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetBookingsDto } from './dto/get-bookings.dto';
import { PaginationDto } from './dto/pagination.dto';
import { ReportsQueryDto } from './dto/reports-query.dto';
import { PricingRule } from '../booking/entities/pricing-rule.entity';

@ApiTags('Admin')
@Controller('admin')
@Roles('admin')
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly bookingService: BookingService,
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

  @Get('vehicles/pending')
  @ApiOperation({ summary: 'Get pending vehicle verifications' })
  @ApiResponse({ status: 200, description: 'Pending vehicles retrieved' })
  async getPendingVehicles() {
    return this.adminService.getPendingVehicleVerifications();
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

  @Get('pricing-rules')
  @ApiOperation({ summary: 'Get all pricing rules' })
  @ApiResponse({ status: 200, description: 'Pricing rules retrieved' })
  async getPricingRules() {
    return this.bookingService.getAllPricingRules();
  }

  @Post('pricing-rules')
  @ApiOperation({ summary: 'Create a pricing rule' })
  @ApiResponse({ status: 201, description: 'Pricing rule created' })
  async createPricingRule(@Body() data: Partial<PricingRule>) {
    return this.bookingService.createPricingRule(data);
  }

  @Put('pricing-rules/:id')
  @ApiOperation({ summary: 'Update a pricing rule' })
  @ApiResponse({ status: 200, description: 'Pricing rule updated' })
  async updatePricingRule(@Param('id') id: string, @Body() data: Partial<PricingRule>) {
    return this.bookingService.updatePricingRule(id, data);
  }

  @Delete('pricing-rules/:id')
  @ApiOperation({ summary: 'Delete a pricing rule' })
  @ApiResponse({ status: 200, description: 'Pricing rule deleted' })
  async deletePricingRule(@Param('id') id: string) {
    return this.bookingService.deletePricingRule(id);
  }
}
