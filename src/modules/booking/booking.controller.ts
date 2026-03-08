import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  ParseIntPipe,
  ParseFloatPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { BookingService } from './booking.service';
import {
  EstimateFareDto,
  CreateBookingDto,
  CancelBookingDto,
  CompleteTripDto,
} from './dto/booking.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Booking')
@Controller('booking')
@ApiBearerAuth()
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  // Public/Customer Endpoints

  @Public()
  @Get('vehicles/pricing')
  @ApiOperation({ summary: 'Get all active vehicle pricing rules' })
  @ApiResponse({ status: 200, description: 'Vehicle pricing details retrieved successfully' })
  async getVehiclePricing() {
    return this.bookingService.getPublicPricingRules();
  }

  @Post('estimate-fare')
  @Roles('customer')
  @ApiOperation({ summary: 'Estimate fare for a trip' })
  @ApiResponse({ status: 200, description: 'Fare estimated successfully' })
  async estimateFare(@Body() estimateFareDto: EstimateFareDto) {
    return this.bookingService.estimateFare(estimateFareDto);
  }

  @Post('create')
  @Roles('customer')
  @ApiOperation({ summary: 'Create new booking' })
  @ApiResponse({ status: 201, description: 'Booking created successfully' })
  async create(@GetUser() user: User, @Body() createBookingDto: CreateBookingDto) {
    return this.bookingService.create(user.id, createBookingDto);
  }

  @Get(':id')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Get booking details by ID' })
  @ApiResponse({ status: 200, description: 'Booking retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Booking not found' })
  async getById(@Param('id') id: string, @GetUser() user: User) {
    return this.bookingService.getById(id, user.id);
  }

  @Put(':id/cancel')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Cancel booking' })
  @ApiResponse({ status: 200, description: 'Booking cancelled successfully' })
  async cancel(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body() cancelDto: CancelBookingDto,
  ) {
    return this.bookingService.cancel(id, user.id, cancelDto);
  }

  @Get('customer/history')
  @Roles('customer')
  @ApiOperation({ summary: 'Get customer booking history' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Booking history retrieved' })
  async getCustomerHistory(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.bookingService.getCustomerHistory(user.id, page, limit, status);
  }

  // Driver Endpoints

  @Get('nearby')
  @Roles('driver')
  @ApiOperation({ summary: 'Get nearby available bookings' })
  @ApiQuery({ name: 'latitude', required: true, type: Number })
  @ApiQuery({ name: 'longitude', required: true, type: Number })
  @ApiQuery({ name: 'radius', required: false, type: Number, description: 'Radius in km' })
  @ApiResponse({ status: 200, description: 'Nearby bookings retrieved' })
  async getNearbyBookings(
    @Query('latitude', ParseFloatPipe) latitude: number,
    @Query('longitude', ParseFloatPipe) longitude: number,
    @Query('radius', new DefaultValuePipe(5), ParseFloatPipe) radius: number,
  ) {
    return this.bookingService.getNearbyBookings(latitude, longitude, radius);
  }

  @Get('driver/active')
  @Roles('driver')
  @ApiOperation({ summary: 'Get driver current active booking' })
  @ApiResponse({ status: 200, description: 'Active booking retrieved' })
  async getDriverActiveBooking(@GetUser() user: User) {
    return this.bookingService.getDriverActiveBooking(user.id);
  }

  @Put(':id/accept')
  @Roles('driver')
  @ApiOperation({ summary: 'Accept booking request' })
  @ApiResponse({ status: 200, description: 'Booking accepted successfully' })
  async acceptBooking(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body('vehicle_id') vehicleId: string,
  ) {
    return this.bookingService.acceptBooking(id, user.id, vehicleId);
  }

  @Put(':id/reject')
  @Roles('driver')
  @ApiOperation({ summary: 'Reject booking request' })
  @ApiResponse({ status: 200, description: 'Booking rejected' })
  async rejectBooking(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body('reason') reason: string,
  ) {
    return this.bookingService.rejectBooking(id, user.id, reason);
  }

  @Put(':id/start')
  @Roles('driver')
  @ApiOperation({ summary: 'Start the trip' })
  @ApiResponse({ status: 200, description: 'Trip started successfully' })
  async startTrip(@Param('id') id: string, @GetUser() user: User) {
    return this.bookingService.startTrip(id, user.id);
  }

  @Put(':id/complete')
  @Roles('driver')
  @ApiOperation({ summary: 'Complete the trip' })
  @ApiResponse({ status: 200, description: 'Trip completed successfully' })
  async completeTrip(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body() completeTripDto?: CompleteTripDto,
  ) {
    return this.bookingService.completeTrip(id, user.id, completeTripDto);
  }

  @Get('driver/history')
  @Roles('driver')
  @ApiOperation({ summary: 'Get driver booking history' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Booking history retrieved' })
  async getDriverHistory(
    @GetUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.bookingService.getDriverHistory(user.id, page, limit);
  }
}
