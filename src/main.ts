import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as express from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RolesGuard } from './common/guards/roles.guard';

async function bootstrap() {
  // In production, drop debug/verbose logs to keep the event loop and disk free
  // under load; keep them in development for debuggability.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Get configuration
  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') || 3000;
  const apiPrefix = configService.get<string>('app.apiPrefix') || 'api';
  const appName = configService.get<string>('app.name') || 'SkiDO';
  const corsOrigins = configService.get<string[]>('app.corsOrigins') || [];

  const nodeEnv = configService.get<string>('app.nodeEnv') || 'development';
  const isProduction = nodeEnv === 'production';

  // Body size limit — prevent oversized payload attacks.
  // `verify` captures the exact raw bytes onto req.rawBody BEFORE JSON parsing
  // replaces req.body. Webhook signature checks (Cashfree, Cashfree Payouts)
  // hash these exact bytes — without this, `rawBody: true` above is shadowed
  // by this middleware (it runs first and consumes the body) and signature
  // verification silently always fails.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Serve static public assets (e.g. the referral banner used for link previews)
  // at the host root, unaffected by the /api global prefix:
  //   skido-backend/public/referral-banner.png → https://<host>/referral-banner.png
  app.useStaticAssets(join(__dirname, '..', 'public'), {
    setHeaders: (res) => {
      // Allow social/CDN crawlers to embed the image cross-origin.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  });

  // CORS — must be registered before Helmet so headers are not stripped
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Security headers
  app.use(
    helmet({
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      // Allow cross-origin requests from whitelisted origins
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: isProduction
        ? true
        : {
            directives: {
              defaultSrc: [`'self'`],
              styleSrc: [`'self'`, `'unsafe-inline'`],
              scriptSrc: [`'self'`, `'unsafe-inline'`, `'unsafe-eval'`],
              imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
            },
          },
    }),
  );

  // Global prefix — exclude the public referral landing page so share links are
  // clean (e.g. https://api.ridezipto.com/refer/CODE) and crawlable by WhatsApp.
  app.setGlobalPrefix(apiPrefix, {
    exclude: [{ path: 'refer/:code', method: RequestMethod.GET }],
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new TransformInterceptor());

  // Global guards
  const reflector = app.get(Reflector);
  app.useGlobalGuards(new RolesGuard(reflector));

  // Swagger — only exposed in non-production environments
  if (!isProduction) {
    const config = new DocumentBuilder()
      .setTitle(`${appName} API`)
      .setDescription('Smart Kinetics Delivery Odisha - Comprehensive Logistics API')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('Authentication', 'User authentication and authorization')
      .addTag('Customer', 'Customer profile and management')
      .addTag('Driver', 'Driver profile and management')
      .addTag('Vehicle', 'Vehicle management')
      .addTag('Booking', 'Booking and trip management')
      .addTag('Payment', 'Payment processing')
      .addTag('Rating', 'Rating and feedback')
      .addTag('Admin', 'Admin operations')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  await app.listen(port);

  console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   ${appName} - Backend API                        ║
  ║                                                   ║
  ║   🚀 Server running on: http://localhost:${port}      ║
  ║   📚 API Docs: http://localhost:${port}/${apiPrefix}/docs   ║
  ║   🏷️  Environment: ${configService.get('app.nodeEnv')}     ║
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
  `);
}

bootstrap();
