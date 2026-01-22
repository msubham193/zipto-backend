import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { VehicleService } from './vehicle.service';
import { RegisterVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Vehicle')
@Controller('vehicle')
export class VehicleController {
  constructor(private readonly vehicleService: VehicleService) {}

  @Get('types')
  @ApiOperation({ summary: 'Get all vehicle types (public)' })
  @ApiResponse({ status: 200, description: 'Vehicle types retrieved successfully' })
  getVehicleTypes() {
    return this.vehicleService.getVehicleTypes();
  }

  @Post('register')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register new vehicle' })
  @ApiResponse({ status: 201, description: 'Vehicle registered successfully' })
  @ApiResponse({ status: 409, description: 'Registration number already exists' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async register(@GetUser() user: User, @Body() registerVehicleDto: RegisterVehicleDto) {
    return this.vehicleService.register(user.id, registerVehicleDto);
  }

  @Get('my-vehicles')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get driver vehicles' })
  @ApiResponse({ status: 200, description: 'Vehicles retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMyVehicles(@GetUser() user: User) {
    return this.vehicleService.getDriverVehicles(user.id);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get vehicle details by ID' })
  @ApiResponse({ status: 200, description: 'Vehicle retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Vehicle not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getById(@Param('id') id: string, @GetUser() user: User) {
    return this.vehicleService.getById(id, user.id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('driver')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update vehicle details' })
  @ApiResponse({ status: 200, description: 'Vehicle updated successfully' })
  @ApiResponse({ status: 404, description: 'Vehicle not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async update(
    @Param('id') id: string,
    @GetUser() user: User,
    @Body() updateVehicleDto: UpdateVehicleDto,
  ) {
    return this.vehicleService.update(id, user.id, updateVehicleDto);
  }
}
