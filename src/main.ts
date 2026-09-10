import 'reflect-metadata';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import * as compression from 'compression';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { flattenValidationErrors } from './common/validation/flatten-validation-errors';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { ConfigurationError, loadConfig } from './config/env';
import { serveOpenApi } from './common/openapi/openapi';

/**
 * Application bootstrap.
 *
 * Ordering here is deliberate and load-bearing:
 *  1. Load and validate configuration BEFORE creating the app, so a
 *     misconfigured process dies before it can bind a port or open a pool.
 *  2. Security headers before anything else can respond.
 *  3. The validation pipe before any controller sees a body.
 */
async function bootstrap(): Promise<void> {
  loadDotenv();

  const logger = new Logger('Bootstrap');

  // Configuration first. A ConfigurationError here means the process cannot
  // start, so it is caught and reported plainly rather than as a stack trace —
  // the reader needs the variable name, not our call stack.
  let config: ReturnType<typeof loadConfig>;

  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      logger.error(error.message);
      process.exit(1);
    }

    throw error;
  }

  const app = await NestFactory.create(AppModule, {
    // Buffer startup logs so nothing is written before the logger is configured.
    bufferLogs: true,
  });

  // Replace Nest's default logger, so framework messages and application
  // messages share one structured stream rather than two formats.
  app.useLogger(app.get(PinoLogger));

  /**
   * Correlation id first, before ANY other middleware.
   *
   * Registered here at the Express level rather than through
   * `MiddlewareConsumer`, because Nest applies module middleware *after* the
   * body parser. A malformed-JSON request is rejected by the parser, so with
   * module-level registration that error carried no request id — leaving the
   * one failure a merchant is most likely to report as the one impossible to
   * trace. Verified: it reported `no-request-context` before this change.
   */
  const requestContext = new RequestContextMiddleware();
  app.use(requestContext.use.bind(requestContext));

  // Security headers, applying to every response including errors raised
  // before a route matches.
  app.use(helmet());

  /**
   * Response compression (M9.1).
   *
   * The config document is the reason. A store with twenty option sets sends
   * roughly 30KB of JSON, and it compresses to about 1.2KB — a 96% saving on a
   * payload every connected store pulls every fifteen minutes. JSON of that
   * shape, with keys repeating once per option, is close to the best case a
   * deflate window can have.
   *
   * `threshold` leaves small responses alone: below about a kilobyte the
   * gzip header and the CPU cost exceed the saving, and most responses here —
   * a heartbeat reply, an error envelope — are far below it.
   *
   * Applies to every route rather than one, because a client that sends
   * `Accept-Encoding: gzip` is asking about the connection, not the endpoint,
   * and compressing only the largest response would be a surprise everywhere
   * else. Clients that do not ask are unaffected: `compression` honours the
   * request header and sends identity encoding when it is absent.
   */
  app.use(compression({ threshold: 1024 }));

  /**
   * Global validation.
   *
   * `forbidNonWhitelisted` is the important one: an unknown field is a 400, not
   * a silent discard. That closes mass assignment as a class of bug — a caller
   * cannot smuggle `isAdmin` or `tenantId` into a DTO and hope something binds
   * it.
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // Constraint names would tell a caller which validators run on which
      // fields. Useful in development, unnecessary detail in production.
      disableErrorMessages: config.isProduction,

      /**
       * Emit `{ field, message }` rather than flat strings.
       *
       * By default the pipe produces sentences like "password must be longer
       * than or equal to 12 characters", and the filter had no reliable way to
       * recover the property from one — so every detail arrived with an empty
       * `field`, and a form could highlight nothing. ADR-009 promises per-field
       * details; this is what makes them true rather than aspirational.
       *
       * Nested properties are joined with a dot (`address.postcode`), which is
       * the path a client already uses to find the input.
       */
      exceptionFactory: (errors) => new BadRequestException(flattenValidationErrors(errors)),
    }),
  );

  /**
   * Route prefix.
   *
   * `/health` is excluded: monitoring should not track API versions, and probes
   * expect a flat body rather than our envelope. See ADR-011.
   */
  app.setGlobalPrefix('v1', { exclude: ['health'] });

  /**
   * CORS from an explicit allowlist.
   *
   * `loadConfig()` has already rejected `*` — on a multi-tenant API a wildcard
   * origin is a data-exposure risk, and browsers reject it for credentialed
   * requests anyway.
   */
  app.enableCors({
    origin: config.security.corsOrigins,
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  });

  /**
   * The generated OpenAPI description, and its explorer.
   *
   * **Off in production.** The spec itself is harmless — every path is already
   * known to anyone holding the plugin — but the explorer issues live requests,
   * and one pointed at production data is a footgun handed to whoever finds the
   * URL.
   */
  serveOpenApi(app, !config.isProduction);

  // Flush a request in flight rather than dropping it when the orchestrator
  // sends SIGTERM.
  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.log(`Optionia API listening on port ${config.port} [${config.nodeEnv}]`);
  logger.log(`Health: http://localhost:${config.port}/health`);

  if (!config.isProduction) {
    logger.log(`API docs: http://localhost:${config.port}/docs`);
  }
}

void bootstrap();
