import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { AppConfig } from '../../config/configuration';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Structured JSON logging foundation.
 *
 * - genReqId reuses an incoming X-Correlation-Id header when present
 *   (e.g. from an upstream gateway), otherwise generates a UUID — this
 *   becomes `request.id`, threaded through every log line automatically
 *   by pino-http, and echoed back to the client by RequestIdInterceptor.
 * - Sensitive fields are redacted centrally so no call site has to
 *   remember to avoid logging secrets.
 * - Pretty-printing is enabled only outside production for readability;
 *   production emits raw JSON to stdout for log-aggregator consumption.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const app = configService.get<AppConfig>('app');
        const isProduction = app?.nodeEnv === 'production';

        return {
          pinoHttp: {
            level: app?.logLevel ?? 'info',
            genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => {
              const incoming = req.headers[CORRELATION_ID_HEADER];
              const value = Array.isArray(incoming) ? incoming[0] : incoming;
              return value && value.trim().length > 0 ? value : randomUUID();
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.passwordHash',
                'req.body.refreshToken',
                '*.password',
                '*.passwordHash',
                '*.token',
                '*.accessToken',
                '*.refreshToken',
              ],
              censor: '[REDACTED]',
            },
            transport: isProduction
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:standard',
                  },
                },
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
