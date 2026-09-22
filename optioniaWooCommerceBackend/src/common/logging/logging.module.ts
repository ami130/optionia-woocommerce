import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { getRequestId } from '../context/request-context';
import { loadConfig } from '../../config/env';

/**
 * Structured logging.
 *
 * JSON in every environment except local development, where a human is reading
 * the output directly. Machine-readable logs are the point: a correlation id is
 * only useful if a log aggregator can filter on it, and Nest's default
 * pretty-printer renders structured context as `Object(2)` across several
 * lines — unqueryable.
 *
 * Every line carries `requestId`, injected automatically rather than passed at
 * each call site. A merchant quotes one id from a support ticket and every line
 * for that request is retrievable.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        const isLocal = config.nodeEnv === 'development';

        return {
          pinoHttp: {
            level: config.logLevel,

            // Pretty output locally; JSON everywhere else. `pino-pretty` is a
            // development dependency of convenience — never used where logs are
            // shipped somewhere.
            transport: isLocal
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    colorize: true,
                    translateTime: 'HH:MM:ss.l',
                    ignore: 'pid,hostname',
                  },
                }
              : undefined,

            // Reuse the id established by RequestContextMiddleware rather than
            // generating a second one, so the value in the log matches the
            // `X-Request-Id` header the client received.
            genReqId: () => getRequestId(),

            // Bind the id to every line emitted during the request, including
            // ones from services that know nothing about HTTP.
            customProps: () => ({ requestId: getRequestId() }),

            /**
             * Redaction.
             *
             * Logs are read by support, shipped to a third-party aggregator, and
             * kept for months. A request that carries an Authorization header or
             * a store token must not leave a durable copy of it there.
             *
             * Paths are explicit rather than pattern-based: pino's redaction is
             * applied at serialisation time and a wildcard over every object
             * would cost more than it saves.
             */
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-optionia-token"]',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.token',
                'req.body.secret',
              ],
              censor: '[redacted]',
            },

            /**
             * Trim what is serialised per line.
             *
             * pino-http's defaults log every request and response header on
             * every line. That is verbose enough to bury the message, costs
             * storage at volume, and widens the surface for a header to be
             * logged that redaction has not been told about.
             *
             * Kept: the fields an operator actually filters or groups by.
             */
            serializers: {
              req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
                id: req.id,
                method: req.method,
                url: req.url,
                remoteAddress: req.remoteAddress,
              }),
              res: (res: { statusCode: number }) => ({
                statusCode: res.statusCode,
              }),
            },

            // Health checks run every few seconds. Logging them at info buries
            // real traffic; they stay visible at debug when something is wrong.
            autoLogging: {
              ignore: (req) => req.url === '/health',
            },

            // A 4xx is the caller's problem and is not our error. Logging it at
            // `error` fills the error stream with bot traffic and hides genuine
            // failures.
            customLogLevel: (_req, res, err) => {
              if (err || res.statusCode >= 500) return 'error';
              if (res.statusCode >= 400) return 'warn';
              return 'info';
            },

            customSuccessMessage: (req, res) =>
              `${req.method} ${req.url} ${res.statusCode}`,

            customErrorMessage: (req, res, err) =>
              `${req.method} ${req.url} ${res.statusCode} — ${err.message}`,
          },
        };
      },
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
