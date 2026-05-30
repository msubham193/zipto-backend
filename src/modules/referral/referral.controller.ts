import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ReferralService } from './referral.service';
import { ApplyReferralDto } from './dto/referral.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Referrals')
@Controller('referral')
@ApiBearerAuth()
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Get('me')
  @Roles('customer')
  @ApiOperation({ summary: 'Get my referral code, reward amounts and stats' })
  @ApiResponse({ status: 200, description: 'Referral info retrieved' })
  async getMe(@GetUser() user: User) {
    return this.referralService.getMyReferralInfo(user.id);
  }

  @Post('apply')
  @Roles('customer')
  @ApiOperation({ summary: 'Apply a referral code (before first completed order)' })
  @ApiResponse({ status: 200, description: 'Code applied' })
  @ApiResponse({ status: 400, description: 'Invalid code / not eligible' })
  @ApiResponse({ status: 409, description: 'Already used a referral code' })
  async apply(@GetUser() user: User, @Body() dto: ApplyReferralDto) {
    return this.referralService.applyCode(user.id, dto.code, dto.device_id);
  }

  @Get('my-referrals')
  @Roles('customer')
  @ApiOperation({ summary: 'List people I referred and coins earned' })
  @ApiResponse({ status: 200, description: 'Referrals retrieved' })
  async myReferrals(@GetUser() user: User) {
    return this.referralService.getMyReferrals(user.id);
  }
}
