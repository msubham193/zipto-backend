import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendNotificationDto } from './dto/notification.dto';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Send push notification via FCM
   * TODO: Implement actual FCM integration when server key is available
   */
  async sendPushNotification(sendNotificationDto: SendNotificationDto) {
    const { user_id, title, body, data } = sendNotificationDto;

    // Mock FCM implementation
    // In production, use firebase-admin SDK:
    /*
    const admin = require('firebase-admin');
    
    await admin.messaging().send({
      token: userFcmToken,
      notification: { title, body },
      data: data || {},
    });
    */

    this.logger.log(`Push notification sent to user ${user_id}: ${title}`);

    return {
      message: 'Notification sent successfully (mock)',
      user_id,
      title,
      body,
    };
  }

  /**
   * Send booking update notification
   */
  async sendBookingUpdate(userId: string, bookingId: string, status: string, message: string) {
    return this.sendPushNotification({
      user_id: userId,
      title: `Booking ${status}`,
      body: message,
      data: {
        type: 'booking_update',
        booking_id: bookingId,
        status,
      },
    });
  }

  /**
   * Send payment confirmation notification
   */
  async sendPaymentConfirmation(userId: string, bookingId: string, amount: number) {
    return this.sendPushNotification({
      user_id: userId,
      title: 'Payment Successful',
      body: `Your payment of ₹${amount} has been processed successfully.`,
      data: {
        type: 'payment_confirmation',
        booking_id: bookingId,
        amount,
      },
    });
  }

  /**
   * Send driver arrival notification
   */
  async sendDriverArrival(userId: string, bookingId: string, driverName: string) {
    return this.sendPushNotification({
      user_id: userId,
      title: 'Driver Arriving',
      body: `${driverName} is arriving at your pickup location.`,
      data: {
        type: 'driver_arrival',
        booking_id: bookingId,
      },
    });
  }
}
