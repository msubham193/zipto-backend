import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CustomerService } from './customer.service';
import { UpdateCustomerDto, SavedLocationDto } from './dto/customer.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Customer')
@Controller('customer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('customer')
@ApiBearerAuth()
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get customer profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@GetUser() user: User) {
    return this.customerService.getProfile(user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update customer profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateProfile(@GetUser() user: User, @Body() updateCustomerDto: UpdateCustomerDto) {
    return this.customerService.updateProfile(user.id, updateCustomerDto);
  }

  @Get('saved-locations')
  @ApiOperation({ summary: 'Get all saved locations' })
  @ApiResponse({ status: 200, description: 'Saved locations retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getSavedLocations(@GetUser() user: User) {
    return this.customerService.getSavedLocations(user.id);
  }

  @Post('saved-locations')
  @ApiOperation({ summary: 'Add new saved location' })
  @ApiResponse({ status: 201, description: 'Location added successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async addSavedLocation(@GetUser() user: User, @Body() locationDto: SavedLocationDto) {
    return this.customerService.addSavedLocation(user.id, locationDto);
  }

  @Delete('saved-locations/:index')
  @ApiOperation({ summary: 'Delete saved location by index' })
  @ApiResponse({ status: 200, description: 'Location deleted successfully' })
  @ApiResponse({ status: 404, description: 'Location not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async removeSavedLocation(@GetUser() user: User, @Param('index', ParseIntPipe) index: number) {
    return this.customerService.removeSavedLocation(user.id, index);
  }
}
