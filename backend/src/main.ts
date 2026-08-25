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
