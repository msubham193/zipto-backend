import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'skido_db',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    // Connection pool — sized for concurrency. A single Node process holds up to
    // `max` connections; keep headroom below Postgres max_connections (~100).
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE || '20', 10),
    extra: {
      max: parseInt(process.env.DATABASE_POOL_SIZE || '20', 10),
      // Fail fast instead of hanging the request if the pool is saturated.
      connectionTimeoutMillis: 10000,
      // Release idle connections so we don't pin the pool at peak forever.
      idleTimeoutMillis: 30000,
      // Kill runaway queries so one slow statement can't hold a connection and
      // cascade into pool exhaustion. Generous enough for admin reports.
      statement_timeout: parseInt(process.env.DATABASE_STATEMENT_TIMEOUT || '60000', 10),
      query_timeout: parseInt(process.env.DATABASE_STATEMENT_TIMEOUT || '60000', 10),
      keepAlive: true,
    },
  }),
);
