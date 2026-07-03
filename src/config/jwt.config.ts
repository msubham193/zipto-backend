import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key',
  refreshSecret: process.env.JWT_REFRESH_SECRET || 'your-super-secret-refresh-key',
  // Access token lasts long enough to avoid constant refreshes; the refresh
  // token keeps the session alive for a full week so users aren't logged out
  // early — sessions are now tracked per-device (see RefreshToken entity), so
  // this is a hard, reliable 7-day expiry, not just a target.
  expiresIn: process.env.JWT_EXPIRATION || '1h',
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRATION || '7d',
}));
