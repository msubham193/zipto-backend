import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface FCMNotification {
  title: string;
  body: string;
  data?: Record<string, any>;
}

@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private readonly serverKey: string;
  private admin: any;

  constructor(private configService: ConfigService) {
    this.serverKey = this.configService.get<string>('externalServices.fcm.serverKey') || '';

    // Initialize Firebase Admin SDK if serverKey is available
    if (this.serverKey) {
      try {
        const admin = require('firebase-admin');
        
        // Initialize with server key (for testing)
        // In production, use service account JSON
        admin.initializeApp({
          credential: admin.credential.cert({
            // TODO: Replace with actual service account JSON
            projectId: 'skido-project',
            privateKey: this.serverKey,
            clientEmail: 'firebase-adminsdk@skido-project.iam.gserviceaccount.com',
          }),
        });

        this.admin = admin;
        this.logger.log('Firebase Admin SDK initialized');
      } catch (error: any) {
        this.logger.warn(`Firebase Admin SDK initialization failed: ${error.message}`);
      }
    } else {
      this.logger.warn('FCM server key not configured, using mock mode');
    }
  }

  /**
   * Send push notification to a device token
   */
  async sendToDevice(deviceToken: string, notification: FCMNotification): Promise<boolean> {
    if (!this.admin) {
      this.logger.log(`[MOCK FCM] Notification to ${deviceToken.substring(0, 20)}...`);
      this.logger.log(`Title: ${notification.title}, Body: ${notification.body}`);
      return true; // Mock success
    }

    try {
      const message = {
        token: deviceToken,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: notification.data || {},
      };

      const response = await this.admin.messaging().send(message);
      this.logger.log(`FCM notification sent successfully: ${response}`);
      return true;
    } catch (error: any) {
      this.logger.error(`FCM send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send to multiple devices
   */
  async sendToMultipleDevices(
    deviceTokens: string[],
    notification: FCMNotification,
  ): Promise<boolean> {
    if (!this.admin) {
      this.logger.log(`[MOCK FCM] Sending to ${deviceTokens.length} devices`);
      this.logger.log(`Title: ${notification.title}, Body: ${notification.body}`);
      return true;
    }

    try {
      const message = {
        tokens: deviceTokens,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: notification.data || {},
      };

      const response = await this.admin.messaging().sendMulticast(message);
      this.logger.log(`FCM sent to ${response.successCount}/${deviceTokens.length} devices`);
      return response.successCount > 0;
    } catch (error: any) {
      this.logger.error(`FCM multicast send failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send to a topic
   */
  async sendToTopic(topic: string, notification: FCMNotification): Promise<boolean> {
    if (!this.admin) {
      this.logger.log(`[MOCK FCM] Sending to topic: ${topic}`);
      this.logger.log(`Title: ${notification.title}, Body: ${notification.body}`);
      return true;
    }

    try {
      const message = {
        topic,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: notification.data || {},
      };

      const response = await this.admin.messaging().send(message);
      this.logger.log(`FCM notification sent to topic ${topic}: ${response}`);
      return true;
    } catch (error: any) {
      this.logger.error(`FCM topic send failed: ${error.message}`);
      return false;
    }
  }
}
