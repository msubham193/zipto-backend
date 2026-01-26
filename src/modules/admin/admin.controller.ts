import { Controller, Get, Put, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { BookingStatus } from '../booking/entities/booking.entity';

@ApiTags('Admin')
@Controller('admin')
@Roles('admin')
@ApiBearerAuth()
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

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
  @ApiQuery({ name: 'status', required: false, enum: BookingStatus })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Bookings retrieved' })
  async getAllBookings(
    @Query('status') status?: BookingStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getAllBookings(status, page, limit);
  }

  @Get('analytics')
  @ApiOperation({ summary: 'Get analytics data (last 30 days)' })
  @ApiResponse({ status: 200, description: 'Analytics retrieved' })
  async getAnalytics() {
    return this.adminService.getAnalytics();
  }
}
