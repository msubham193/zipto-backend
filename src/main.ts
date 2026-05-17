import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RolesGuard } from './common/guards/roles.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Get configuration
  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') || 3000;
  const apiPrefix = configService.get<string>('app.apiPrefix') || 'api';
  const appName = configService.get<string>('app.name') || 'SkiDO';
  const corsOrigins = configService.get<string[]>('app.corsOrigins') || [];

  const nodeEnv = configService.get<string>('app.nodeEnv') || 'development';
  const isProduction = nodeEnv === 'production';

  // Body size limit — prevent oversized payload attacks
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

  // Global prefix
  app.setGlobalPrefix(apiPrefix);

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
