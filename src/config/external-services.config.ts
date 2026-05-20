import { registerAs } from '@nestjs/config';

export default registerAs('externalServices', () => ({
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  twoFactor: {
    apiKey       : process.env.TWO_FACTOR_API_KEY || '',
    senderId     : 'Zipto',
    peId         : '1101559440000094860',
    ctId         : '1107177908307247477',
  },
  exotel: {
    sid:      process.env.EXOTEL_SID || '',
    apiKey:   process.env.EXOTEL_API_KEY || '',
    apiToken: process.env.EXOTEL_API_TOKEN || '',
    exophone: process.env.EXOTEL_EXOPHONE || '',
  },
  fcm: {
    serverKey: process.env.FCM_SERVER_KEY || '',
  },
  otp: {
    expiryMinutes  : parseInt(process.env.OTP_EXPIRY_MINUTES   || '5',  10),
    maxAttempts    : parseInt(process.env.OTP_MAX_ATTEMPTS      || '5',  10),
    resendCooldown : parseInt(process.env.OTP_RESEND_COOLDOWN   || '60', 10), // seconds
  },
  rateLimit: {
    ttl: parseInt(process.env.THROTTLE_TTL || '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
  },
}));
