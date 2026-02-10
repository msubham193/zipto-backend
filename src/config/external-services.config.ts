import { registerAs } from '@nestjs/config';

export default registerAs('externalServices', () => ({
  mapbox: {
    accessToken: process.env.MAPBOX_ACCESS_TOKEN || '',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || '',
  },
  fcm: {
    serverKey: process.env.FCM_SERVER_KEY || '',
  },
  otp: {
    length: parseInt(process.env.OTP_LENGTH || '6', 10),
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10),
  },
  rateLimit: {
    ttl: parseInt(process.env.THROTTLE_TTL || '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
  },
}));
