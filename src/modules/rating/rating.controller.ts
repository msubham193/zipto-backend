import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { RatingService } from './rating.service';
import { SubmitRatingDto } from './dto/rating.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Rating')
@Controller('rating')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  @Post('submit')
  @Roles('customer')
  @ApiOperation({ summary: 'Submit rating for completed booking' })
  @ApiResponse({ status: 201, description: 'Rating submitted successfully' })
  @ApiResponse({ status: 400, description: 'Invalid booking or already rated' })
  async submitRating(@GetUser() user: User, @Body() submitRatingDto: SubmitRatingDto) {
    return this.ratingService.submitRating(user.id, submitRatingDto);
  }

  @Get('booking/:bookingId')
  @Roles('customer', 'driver')
  @ApiOperation({ summary: 'Get rating for a specific booking' })
  @ApiResponse({ status: 200, description: 'Rating retrieved successfully' })
  async getRatingByBooking(@Param('bookingId') bookingId: string, @GetUser() user: User) {
    return this.ratingService.getRatingByBooking(bookingId, user.id);
  }

  @Get('driver/:driverId')
  @ApiOperation({ summary: 'Get all ratings for a driver' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Driver ratings retrieved' })
  async getDriverRatings(
    @Param('driverId') driverId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.ratingService.getDriverRatings(driverId, page, limit);
  }
}
