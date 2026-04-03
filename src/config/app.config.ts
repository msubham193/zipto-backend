import { registerAs } from '@nestjs/config';

const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://localhost:4200',
  'http://localhost:5173',
  'https://zipto-admin.vercel.app',
  'https://zipto-admin-panel.vercel.app',
  'https://admin.ridezipto.com',
];

const envCorsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || 'api',
  name: process.env.APP_NAME || 'SkiDO',
  corsOrigins: Array.from(new Set([...defaultCorsOrigins, ...envCorsOrigins])),
}));
