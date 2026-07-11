import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import { RedisService } from '../../services/redis.service';

/**
 * Liveness/readiness check for load balancers and uptime monitors. Verifies
 * the app can actually reach its dependencies (DB, Redis) rather than just
 * confirming the Node process is running — PM2 can show "online" while the
 * DB connection is dead.
 */
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
  ) {}

  @Public()
  @Get()
  async check(@Res() res: Response) {
    const checks: Record<string, 'ok' | 'error'> = { database: 'ok', redis: 'ok' };
    let healthy = true;

    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      checks.database = 'error';
      healthy = false;
    }

    try {
      await this.redisService.ping();
    } catch {
      checks.redis = 'error';
      healthy = false;
    }

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  }
}
