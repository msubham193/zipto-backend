import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private messaging: any = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.config
      .get<string>('FIREBASE_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase credentials not set — push notifications disabled. ' +
          'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in .env',
      );
      return;
    }

    try {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        });
      }
      this.messaging = admin.messaging();
      this.logger.log('Firebase Admin SDK initialized — push notifications enabled');
    } catch (err: any) {
      this.logger.error(`Firebase Admin SDK init failed: ${err.message}`);
    }
  }

  get isEnabled(): boolean {
    return this.messaging !== null;
  }

  /**
   * Send push notification to a single device token.
   * Returns false for invalid/stale tokens so the caller can clean them up.
   *
   * isNewBooking=true: uses high-priority heads-up channel for driver alerts
   * (full-screen intent — Rapido / Ola style loud ring + banner).
   */
  async sendToToken(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    isNewBooking = false,
  ): Promise<boolean> {
    if (!this.messaging) return false;
    const channelId = isNewBooking ? 'zipto_new_booking' : 'zipto_default';
    try {
      await this.messaging.send({
        token,
        notification: { title, body },
        data: data ?? {},
        android: {
          priority: 'high',
          notification: {
            channelId,
            sound: isNewBooking ? 'new_booking' : 'default',
            // Heads-up notification (like Rapido's incoming booking)
            visibility: 'public',
            priority: isNewBooking ? 'max' : 'high',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: isNewBooking ? 'new_booking.caf' : 'default',
              badge: 1,
              'content-available': 1,
              'interruption-level': isNewBooking ? 'time-sensitive' : 'active',
            },
          },
        },
      });
      return true;
    } catch (err: any) {
      const staleTokenCodes = [
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
        'messaging/invalid-argument',
      ];
      if (staleTokenCodes.includes(err.code)) {
        return false; // stale — caller should remove from DB
      }
      this.logger.warn(
        `FCM send failed for token ...${token.slice(-8)}: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Send to many tokens at once (auto-chunked at 500).
   */
  async sendToTokens(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ success: number; failure: number }> {
    if (!this.messaging || tokens.length === 0) {
      return { success: 0, failure: 0 };
    }

    let success = 0;
    let failure = 0;

    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      try {
        const res = await this.messaging.sendEachForMulticast({
          tokens: chunk,
          notification: { title, body },
          data: data ?? {},
          android: { priority: 'high' },
          apns: {
            payload: {
              aps: { sound: 'default', badge: 1, 'content-available': 1 },
            },
          },
        });
        success += res.successCount;
        failure += res.failureCount;
      } catch (err: any) {
        this.logger.warn(
          `FCM batch send failed [${i}–${i + chunk.length}]: ${err.message}`,
        );
        failure += chunk.length;
      }
    }

    this.logger.log(
      `FCM batch sent to ${tokens.length} tokens — success: ${success}, failure: ${failure}`,
    );
    return { success, failure };
  }

  // Legacy compat methods used by existing code
  async sendToDevice(deviceToken: string, notification: { title: string; body: string; data?: Record<string, any> }): Promise<boolean> {
    return this.sendToToken(deviceToken, notification.title, notification.body);
  }

  async sendToMultipleDevices(deviceTokens: string[], notification: { title: string; body: string; data?: Record<string, any> }): Promise<boolean> {
    const res = await this.sendToTokens(deviceTokens, notification.title, notification.body);
    return res.success > 0;
  }

  async sendToTopic(topic: string, notification: { title: string; body: string; data?: Record<string, any> }): Promise<boolean> {
    if (!this.messaging) return false;
    try {
      await this.messaging.send({
        topic,
        notification: { title: notification.title, body: notification.body },
        data: notification.data ?? {},
      });
      return true;
    } catch (err: any) {
      this.logger.error(`FCM topic send failed: ${err.message}`);
      return false;
    }
  }
}
