import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  UseInterceptors,
  UploadedFiles,
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
import {
  UpdateDriverDto,
  UpdateAvailabilityDto,
  UpdateLocationDto,
  OnboardDriverDto,
} from './dto/driver.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';
import { VehicleType } from '../vehicle/entities/vehicle.entity';

@ApiTags('Driver')
@Controller('driver')
@Roles('driver')
@ApiBearerAuth()
export class DriverController {
  constructor(private readonly driverService: DriverService) {}

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
  @ApiOperation({ summary: 'Get driver earnings dashboard' })
  @ApiResponse({ status: 200, description: 'Earnings retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getEarnings(@GetUser() user: User) {
    return this.driverService.getEarnings(user.id);
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
}
