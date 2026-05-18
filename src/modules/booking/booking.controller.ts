import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  ParseFloatPipe,
  DefaultValuePipe,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BookingService } from './booking.service';
import { BookingGateway } from './booking.gateway';
import {
  EstimateFareDto,
  CreateBookingDto,
  CancelBookingDto,
  StartTripDto,
  CompleteTripDto,
  HandoffRequestDto,
  HandoffAcceptDto,
} from './dto/booking.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Booking')
@Controller('booking')
@ApiBearerAuth()
export class BookingController {
  constructor(
    private readonly bookingService: BookingService,
    private readonly bookingGateway: BookingGateway,
  ) {}

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
  @Throttle({ default: { ttl: 10000, limit: 5 } }) // max 5 fare estimates per 10s per user
  @ApiOperation({ summary: 'Estimate fare for a trip' })
  @ApiResponse({ status: 200, description: 'Fare estimated successfully' })
  async estimateFare(@Body() estimateFareDto: EstimateFareDto) {
    return this.bookingService.estimateFare(estimateFareDto);
  }

  @Post('create')
  @Roles('customer')
  @Throttle({ default: { ttl: 30000, limit: 3 } }) // max 3 bookings per 30s per user
  @ApiOperation({ summary: 'Create new booking' })
  @ApiResponse({ status: 201, description: 'Booking created successfully' })
  async create(@GetUser() user: User, @Body() createBookingDto: CreateBookingDto) {
    return this.bookingService.create(user.id, createBookingDto);
  }

  @Get('offer/:offerId/status')
  @Roles('customer')
  @ApiOperation({ summary: 'Poll offer status while searching for a driver' })
  @ApiResponse({ status: 200, description: 'searching | accepted (with booking_id) | expired' })
  async getOfferStatus(@Param('offerId') offerId: string, @GetUser() user: User) {
    return this.bookingService.getOfferStatus(offerId, user.id);
  }

  @Patch('offer/:offerId/fare')
  @Roles('customer')
  @ApiOperation({ summary: 'Increase offer fare mid-search to attract more drivers' })
  async updateOfferFare(
    @Param('offerId') offerId: string,
    @Body('new_fare') newFare: number,
    @GetUser() user: User,
  ) {
    if (!newFare || isNaN(Number(newFare)) || Number(newFare) <= 0) {
      throw new BadRequestException('new_fare must be a positive number');
    }
    return this.bookingService.updateOfferFare(offerId, user.id, Number(newFare));
  }

  @Post('offer/:offerId/retry')
  @Roles('customer')
  @ApiOperation({ summary: 'Retry driver search with increased fare (max 3 retries)' })
  @ApiResponse({ status: 201, description: 'Search restarted with new fare' })
  async retrySearch(
    @Param('offerId') offerId: string,
    @Body('new_fare') newFare: number,
    @GetUser() user: User,
  ) {
    if (!newFare || isNaN(Number(newFare)) || Number(newFare) <= 0) {
      throw new BadRequestException('new_fare must be a positive number');
    }
    return this.bookingService.retrySearch(offerId, user.id, Number(newFare));
  }

  @Put('offer/:offerId/cancel')
  @Roles('customer')
  @ApiOperation({ summary: 'Cancel an offer before any driver accepts' })
  @ApiResponse({ status: 200, description: 'Offer cancelled' })
  async cancelOffer(@Param('offerId') offerId: string, @GetUser() user: User) {
    return this.bookingService.cancelOffer(offerId, user.id);
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

  @Get('customer/active')
  @Roles('customer')
  @ApiOperation({ summary: 'Get current active booking for customer' })
  async getCustomerActiveBooking(@GetUser() user: User) {
    return this.bookingService.getCustomerActiveBooking(user.id);
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

  @Get('available')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Get broadcast bookings available to accept',
    description:
      'Returns all PENDING bookings that were broadcast to nearby drivers and have not yet been accepted. The driver must be online and within range. Used to populate the Notifications screen.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of broadcast bookings the driver can accept',
    schema: {
      example: [
        {
          id: 'booking-uuid',
          pickup_address: '12 MG Road, Bangalore',
          drop_address: 'Koramangala, Bangalore',
          estimated_fare: 185,
          distance: 6.4,
          vehicle_type: 'bike',
          created_at: '2024-03-10T10:30:00.000Z',
        },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getAvailableBookings(@GetUser() user: User) {
    return this.bookingService.getAvailableBookings(user.id);
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
  async rejectBooking(@Param('id') id: string, @GetUser() user: User) {
    return this.bookingService.rejectBooking(id, user.id);
  }

  @Put(':id/start')
  @Roles('driver')
  @ApiOperation({ summary: 'Start the trip (requires pickup OTP from customer)' })
  @ApiResponse({ status: 200, description: 'Trip started successfully' })
  @ApiResponse({ status: 400, description: 'Invalid pickup OTP' })
  async startTrip(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body() startTripDto: StartTripDto,
  ) {
    return this.bookingService.startTrip(id, user.id, startTripDto.pickup_otp);
  }

  @Post(':id/resend-delivery-otp')
  @Roles('driver')
  @ApiOperation({ summary: 'Resend delivery OTP to receiver via SMS' })
  @ApiResponse({ status: 200, description: 'OTP resent successfully' })
  @ApiResponse({ status: 400, description: 'OTP already verified or no receiver phone' })
  async resendDeliveryOtp(@Param('id') id: string, @GetUser() user: User) {
    return this.bookingService.resendDeliveryOtp(id, user.id);
  }

  @Post(':id/call/:party')
  @Roles('driver')
  @Throttle({ default: { ttl: 30000, limit: 3 } }) // max 3 call attempts per 30s
  @ApiOperation({
    summary: '[Driver] Initiate masked call to booking contact',
    description:
      'Bridges a voice call so neither the rider nor the customer sees each other\'s personal number. ' +
      'Twilio calls the rider\'s phone from the official Zipto number; when picked up it dials the contact. ' +
      'party = "sender" (the customer who booked) or "receiver" (delivery recipient).',
  })
  @ApiResponse({ status: 200, description: 'Call initiated — rider\'s phone will ring shortly' })
  @ApiResponse({ status: 400, description: 'No phone number available or misconfigured voice service' })
  async callContact(
    @Param('id') id: string,
    @Param('party') party: string,
    @GetUser() user: User,
  ) {
    if (party !== 'sender' && party !== 'receiver') {
      throw new BadRequestException('party must be "sender" or "receiver"');
    }
    return this.bookingService.callContact(id, user.id, party as 'sender' | 'receiver');
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

  // ─── Handoff Endpoints ───────────────────────────────────────────────────────

  @Post(':id/handoff/request')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Request handoff due to vehicle breakdown',
    description:
      'Current driver signals that their vehicle is broken down mid-delivery. ' +
      'The system stores a 3-minute handoff offer in Redis and broadcasts it to nearby available drivers. ' +
      'Only allowed once per booking. Booking must be ACCEPTED, DRIVER_ASSIGNED, or ONGOING.',
  })
  @ApiResponse({ status: 201, description: 'Handoff request broadcast to nearby drivers' })
  @ApiResponse({ status: 400, description: 'Already handed off or active handoff pending' })
  @ApiResponse({ status: 403, description: 'Not the assigned driver' })
  async requestHandoff(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body() dto: HandoffRequestDto,
  ) {
    return this.bookingService.requestHandoff(id, user.id, dto.reason);
  }

  @Put(':id/handoff/accept')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Accept a handoff offer',
    description:
      'A nearby driver takes over the booking from the stranded driver. ' +
      'Atomically transfers driver_id to the accepting driver. ' +
      'The new driver must have an approved vehicle matching the required vehicle type and no active booking.',
  })
  @ApiResponse({ status: 200, description: 'Handoff accepted — new driver now owns the booking' })
  @ApiResponse({ status: 400, description: 'Offer expired, already accepted, or driver has active booking' })
  @ApiResponse({ status: 403, description: 'Self-accept attempted or driver/vehicle not approved' })
  async acceptHandoff(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body() dto: HandoffAcceptDto,
  ) {
    return this.bookingService.acceptHandoff(id, user.id, dto.vehicle_id);
  }

  @Delete(':id/handoff/cancel')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Cancel own handoff request',
    description: 'Original driver cancels the pending handoff (e.g., vehicle issue resolved). ' +
      'Removes the Redis offer so no further drivers are notified.',
  })
  @ApiResponse({ status: 200, description: 'Handoff request cancelled' })
  @ApiResponse({ status: 400, description: 'No active handoff to cancel' })
  async cancelHandoff(@Param('id') id: string, @GetUser() user: User) {
    return this.bookingService.cancelHandoff(id, user.id);
  }

  @Get(':id/handoff/status')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Poll handoff status',
    description: 'Returns whether a handoff request is active, time remaining, and handoff history for the booking.',
  })
  @ApiResponse({ status: 200, description: 'Handoff status returned' })
  async getHandoffStatus(@Param('id') id: string, @GetUser() user: User) {
    return this.bookingService.getHandoffStatus(id, user.id);
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

  // ─── DEV ONLY ────────────────────────────────────────────────────────────────

  @Public()
  @Post('test/fire-offer')
  @ApiOperation({ summary: '[DEV] Fire a fake booking_offer to a driver via WebSocket' })
  @ApiResponse({ status: 200, description: 'Offer fired' })
  async testFireOffer(
    @Body()
    body: {
      driverId: string;
      pickup?: string;
      drop?: string;
      fare?: number;
      distance?: number;
      vehicleType?: string;
      timeLeft?: number;
    },
  ) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Not available in production');
    }

    const offer = {
      bookingId: `test-${Date.now()}`,
      pickup: body.pickup ?? 'Nayapalli, Bhubaneswar',
      drop: body.drop ?? 'Esplanade, Bhubaneswar',
      fare: body.fare ?? 120,
      distance: body.distance ?? 4.5,
      vehicleType: body.vehicleType ?? 'bike',
      timeLeft: body.timeLeft ?? 30,
    };

    this.bookingGateway.emitBookingOffer(body.driverId, offer);

    return { sent: true, driverId: body.driverId, offer };
  }
}
