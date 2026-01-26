import {
  Controller,
  Get,
  Put,
  Body,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { DriverService } from './driver.service';
import { UpdateDriverDto, UpdateAvailabilityDto, UpdateLocationDto } from './dto/driver.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

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
}
