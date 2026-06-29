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
  razorpayx: {
    // RazorpayX current account number (e.g. 7878780126480956) — required for automated driver payouts
    accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || '',
    // Set this in the Razorpay dashboard under Webhooks → secret for payout events
    webhookSecret: process.env.RAZORPAYX_WEBHOOK_SECRET || '',
  },
  cashfreePayout: {
    // Cashfree Payouts uses SEPARATE credentials from the Payment Gateway.
    // Generate under Cashfree dashboard → Payouts → Developers → API Keys.
    clientId: process.env.CASHFREE_PAYOUT_CLIENT_ID || '',
    clientSecret: process.env.CASHFREE_PAYOUT_CLIENT_SECRET || '',
    webhookSecret: process.env.CASHFREE_PAYOUT_WEBHOOK_SECRET || '',
    env: process.env.CASHFREE_PAYOUT_ENV || 'production',
    apiVersion: process.env.CASHFREE_PAYOUT_API_VERSION || '2024-01-01',
  },
  twoFactor: {
    apiKey       : process.env.TWO_FACTOR_API_KEY || '',
    senderId     : 'Zipto',
    peId         : '1101559440000094860',
    ctId         : '1107177908307247477',
  },
  smtp: {
    // Transactional email (admin OTP, admin invites). Gmail SMTP with an
    // App Password (NOT the account password) — generated at
    // https://myaccount.google.com/apppasswords with 2FA enabled.
    host  : process.env.SMTP_HOST || 'smtp.gmail.com',
    port  : parseInt(process.env.SMTP_PORT || '465', 10),
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true', // true for 465, false for 587
    user  : process.env.SMTP_USER || '',
    pass  : (process.env.SMTP_PASS || '').replace(/\s+/g, ''), // app passwords are shown space-separated
    from  : process.env.SMTP_FROM || 'Bookfleet <ride.zipto@gmail.com>',
  },
  admin: {
    // Public URL of the admin panel — used in invite/notification emails.
    panelUrl       : process.env.ADMIN_PANEL_URL || 'https://admin.ridezipto.com',
    // The single root super-admin who may create/manage other admins.
    superAdminEmail: (process.env.SUPER_ADMIN_EMAIL || 'ashwini@ridezipto.com').trim().toLowerCase(),
    // Initial password seeded for the super-admin if the account doesn't exist yet.
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || 'Admin@123',
    superAdminName : process.env.SUPER_ADMIN_NAME || 'Ashwini',
    // Legacy/default admin logins to retire (disabled on boot). Comma-separated.
    legacyAdminEmails: (process.env.LEGACY_ADMIN_EMAILS || 'admin@skido.com,admin@zipto.in')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
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
