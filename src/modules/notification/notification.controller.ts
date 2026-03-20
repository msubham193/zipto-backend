import { Controller, Post, Get, Delete, Body } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { SendNotificationDto, DriverNotificationDto } from './dto/notification.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Notification')
@Controller('notification')
@ApiBearerAuth()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * Admin — push a custom notification to any user
   */
  @Post('send')
  @Roles('admin')
  @ApiOperation({ summary: '[Admin] Send a push notification to any user' })
  @ApiBody({ type: SendNotificationDto })
  @ApiResponse({
    status: 201,
    description: 'Notification queued and delivered',
    schema: {
      example: {
        message: 'Notification sent',
        user_id: 'uuid',
        title: 'Hello',
        body: 'Your message here',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async sendNotification(@Body() sendNotificationDto: SendNotificationDto) {
    return this.notificationService.sendPushNotification(sendNotificationDto);
  }

  /**
   * Driver — fetch their own notification inbox
   */
  @Get()
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Get my notifications',
    description:
      'Returns up to 50 notifications stored in Redis (approval, rejection, payment, weekly summary, general). Persisted for 30 days.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of notifications (newest first)',
    schema: {
      example: {
        success: true,
        data: [
          {
            id: 'c3a1b2d4-...',
            type: 'approval',
            title: '🎉 Account Approved!',
            message: 'Your driver account has been verified.',
            data: null,
            createdAt: 1710000000000,
            read: false,
          },
          {
            id: 'f1e2d3c4-...',
            type: 'payment',
            title: '💸 Payment Received',
            message: '₹250 has been credited to your account for trip #ABC123.',
            data: { bookingId: 'uuid', amount: 250 },
            createdAt: 1709990000000,
            read: true,
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getNotifications(@GetUser() user: User) {
    const notifications = await this.notificationService.getForUser(user.id);
    return { success: true, data: notifications };
  }

  /**
   * Driver — mark every notification as read
   */
  @Post('read-all')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Mark all notifications as read',
    description: 'Sets read=true on every notification in the driver\'s inbox.',
  })
  @ApiResponse({
    status: 201,
    description: 'All notifications marked as read',
    schema: { example: { success: true } },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async markAllRead(@GetUser() user: User) {
    await this.notificationService.markAllRead(user.id);
    return { success: true };
  }

  /**
   * Driver — clear / delete entire inbox
   */
  @Delete('clear')
  @Roles('driver')
  @ApiOperation({
    summary: '[Driver] Clear all notifications',
    description: 'Permanently deletes the entire notification inbox from Redis.',
  })
  @ApiResponse({
    status: 200,
    description: 'Inbox cleared',
    schema: { example: { success: true } },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async clearNotifications(@GetUser() user: User) {
    await this.notificationService.clearForUser(user.id);
    return { success: true };
  }
}
