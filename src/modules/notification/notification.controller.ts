import {
  Controller,
  Post,
  Get,
  Delete,
  Put,
  Body,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import {
  SendNotificationDto,
  BroadcastNotificationDto,
  RegisterFcmTokenDto,
  DriverNotificationDto,
} from './dto/notification.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { User } from '../auth/entities/user.entity';

@ApiTags('Notification')
@Controller('notification')
@ApiBearerAuth()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // FCM Token — any authenticated user
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register or update the device FCM token for push notifications.
   * Called on app launch after the device grants notification permission.
   */
  @Put('fcm-token')
  @Roles('driver', 'customer', 'admin')
  @ApiOperation({ summary: 'Register device FCM token for push notifications' })
  @ApiBody({ type: RegisterFcmTokenDto })
  @ApiResponse({ status: 200, schema: { example: { success: true } } })
  async registerFcmToken(
    @GetUser() user: User,
    @Body() dto: RegisterFcmTokenDto,
  ) {
    await this.notificationService.registerFcmToken(user.id, dto.token);
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Admin — broadcast
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Broadcast a push notification to a target group or specific user.
   */
  @Post('broadcast')
  @Roles('admin')
  @ApiOperation({
    summary: '[Admin] Broadcast push notification',
    description:
      'Send push (FCM) + in-app notification to: all, drivers, customers, or a specific user.',
  })
  @ApiBody({ type: BroadcastNotificationDto })
  @ApiResponse({
    status: 201,
    schema: {
      example: {
        success: true,
        target: 'drivers',
        fcm: { success: 42, failure: 2 },
        inApp: 44,
      },
    },
  })
  async broadcast(@Body() dto: BroadcastNotificationDto) {
    if (dto.target === 'user' && !dto.user_id) {
      throw new BadRequestException('user_id is required when target is "user"');
    }
    const result = await this.notificationService.broadcast(dto);
    return { success: true, ...result };
  }

  /**
   * [Admin] Push to a single specific user (legacy endpoint kept for compat).
   */
  @Post('send')
  @Roles('admin')
  @ApiOperation({ summary: '[Admin] Send notification to a specific user' })
  @ApiBody({ type: SendNotificationDto })
  async sendNotification(@Body() dto: SendNotificationDto) {
    return this.notificationService.sendPushNotification(dto);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Driver notifications
  // ─────────────────────────────────────────────────────────────────────────

  @Get()
  @Roles('driver')
  @ApiOperation({ summary: '[Driver] Get notification inbox' })
  @ApiResponse({
    status: 200,
    description: 'List of driver notifications (newest first)',
  })
  async getNotifications(@GetUser() user: User) {
    const notifications = await this.notificationService.getForUser(user.id);
    return { success: true, data: notifications };
  }

  @Post('read-all')
  @Roles('driver')
  @ApiOperation({ summary: '[Driver] Mark all notifications as read' })
  async markAllRead(@GetUser() user: User) {
    await this.notificationService.markAllRead(user.id);
    return { success: true };
  }

  @Delete('clear')
  @Roles('driver')
  @ApiOperation({ summary: '[Driver] Clear all notifications' })
  async clearNotifications(@GetUser() user: User) {
    await this.notificationService.clearForUser(user.id);
    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Customer notifications
  // ─────────────────────────────────────────────────────────────────────────

  @Get('customer')
  @Roles('customer')
  @ApiOperation({ summary: '[Customer] Get notification inbox' })
  @ApiResponse({
    status: 200,
    description: 'List of customer notifications (newest first)',
  })
  async getCustomerNotifications(@GetUser() user: User) {
    const notifications = await this.notificationService.getForCustomer(user.id);
    return { success: true, data: notifications };
  }

  @Post('customer/read-all')
  @Roles('customer')
  @ApiOperation({ summary: '[Customer] Mark all notifications as read' })
  async markAllReadCustomer(@GetUser() user: User) {
    await this.notificationService.markAllReadForCustomer(user.id);
    return { success: true };
  }

  @Delete('customer/clear')
  @Roles('customer')
  @ApiOperation({ summary: '[Customer] Clear all notifications' })
  async clearCustomerNotifications(@GetUser() user: User) {
    await this.notificationService.clearForCustomer(user.id);
    return { success: true };
  }
}
