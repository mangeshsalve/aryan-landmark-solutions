import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);

  const configService = app.get(ConfigService);
  const config = configService.get<AppConfig>('app')!;

  app.setGlobalPrefix('api/v1');

  // Phase 1 production-readiness fix — trust the reverse proxy/CDN (e.g.
  // Cloudflare) that will front this API in staging/production, so
  // req.ip (read by ThrottlerGuard's per-client rate limiting and by
  // AuditService's ipAddress field) reflects the real client rather than
  // the proxy's own address. Uses Express's numeric trust-proxy mode (a
  // bounded hop count) rather than `true`, which would trust an
  // unlimited/unspecified forwarding chain and let a client spoof its own
  // IP by setting X-Forwarded-For itself when no proxy is actually
  // present. TRUST_PROXY_HOPS lets the exact topology (Cloudflare alone
  // vs. Cloudflare plus a platform load balancer) be set per deployment
  // without a code change, defaulting to 1 (a single proxy directly in
  // front of the app, e.g. Cloudflare) when unset. Confined to
  // staging/production: local development and automated tests talk to
  // this server directly, with no proxy in front, so trust-proxy is left
  // at Express's own default (disabled) there — req.ip already reflects
  // the real caller in that case, and enabling it would only add an
  // unnecessary difference from how the app actually runs locally. Uses
  // getHttpAdapter().getInstance() rather than typing `app` as
  // NestExpressApplication, since this is the only Express-specific call
  // in this file — this project uses the default @nestjs/platform-express
  // adapter (no Fastify adapter is configured anywhere), so the
  // underlying HTTP instance here is always a real Express app.
  if (config.nodeEnv === 'staging' || config.nodeEnv === 'production') {
    const trustProxyHops = process.env.TRUST_PROXY_HOPS
      ? parseInt(process.env.TRUST_PROXY_HOPS, 10)
      : 1;
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);
  }

  // Without this, PrismaService.onModuleDestroy() (which calls
  // $disconnect()) never runs on SIGTERM/SIGINT — Nest doesn't listen for
  // OS shutdown signals unless explicitly told to. Matters for container
  // orchestration (rolling deploys, scale-down): without it, the process
  // is killed with the PostgreSQL connection still open.
  app.enableShutdownHooks();

  app.use(helmet());

  app.enableCors({
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
  });

  // Global validation: whitelist + forbidNonWhitelisted rejects any field
  // not declared on a DTO — the primary defense against a client trying to
  // smuggle role/userId/isPublic/etc. into a request body. transform coerces
  // path/query params to their declared types.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  if (config.nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Aryan Landmark Solutions API')
      .setDescription(
        'Authentication, master management, customers, properties, ' +
          'attachments/R2, inquiries, assignment, and the public property API.',
      )
      .setVersion('1.0.0')
      .addBearerAuth(  {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        'application-jwt',
      )
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        'master-jwt',
      ).build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/v1/docs', app, document);
  }

  await app.listen(config.port);
  logger.log(`Application listening on port ${config.port} [${config.nodeEnv}]`);
}

bootstrap();
