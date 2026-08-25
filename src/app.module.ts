import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { buildDataSourceOptions } from './config/data-source';
import { loadConfig } from './config/env';
import { AuthModule } from './auth/auth.module';
import { AuthThrottlerGuard } from './auth/auth-throttler.guard';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { MailModule } from './mail/mail.module';
import { OptionSetsModule } from './option-sets/option-sets.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { HealthModule } from './health/health.module';

/**
 * Root module.
 *
 * Reading this file should show the whole shape of the application: what is
 * global, what is registered, and in what order. Domain modules are added when
 * their milestone arrives, not upfront — an empty directory is a promise the
 * code has not made yet.
 */
@Module({
  imports: [
    // First, so anything logged during later module initialisation is already
    // structured.
    LoggingModule,

    TypeOrmModule.forRootAsync({
      // Configuration is validated once, at boot, by loadConfig(). The same
      // function serves the TypeORM CLI, so there is exactly one place an
      // environment variable is read.
      useFactory: () => buildDataSourceOptions(loadConfig()),
    }),

    /**
     * Per-IP rate limiting.
     *
     * ⚠️ **Per-tenant limiting is deliberately absent.** M5.1 asks for
     * "per-IP plus per-tenant", but tenancy does not exist until Phase 6
     * (`TenantGuard` is M6.3), so there is no tenant to key a limit on.
     * Building a placeholder now would mean building it against an unproven
     * tenancy model. Added in Phase 6 alongside the guard.
     *
     * Two tiers: a short window that absorbs bursts, and a longer one that
     * bounds sustained abuse. A single window cannot do both — set it low and
     * legitimate bursts fail, set it high and a slow scraper never trips it.
     */
    ThrottlerModule.forRoot([
      /**
       * `default` must exist, and its absence is why every auth limit was inert.
       *
       * `@Throttle({ default: {...} })` overrides a bucket **by name**. With no
       * bucket called `default` the override matched nothing and silently did
       * nothing — 25 registrations against a declared limit of 5/hour all
       * succeeded. An unknown name is not an error, so nothing warns.
       *
       * These values are the fallback for routes that do not override.
       * Deliberately loose: a global limit tight enough to matter for auth would
       * break legitimate dashboard traffic.
       */
      { name: 'default', ttl: 60_000, limit: 300 },
      { name: 'short', ttl: 1_000, limit: 20 },
      { name: 'sustained', ttl: 60_000, limit: 300 },
    ]),

    AuthModule,
    MailModule,
    OptionSetsModule,
    HealthModule,
  ],

  providers: [
    // Order matters: the filter is outermost so it catches anything the
    // interceptor or a guard throws.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    /**
     * `AuthThrottlerGuard` **is** the global throttler.
     *
     * It extends `ThrottlerGuard` and only changes the key: IP alone for most
     * routes, IP plus the submitted account for anything carrying an email.
     *
     * Registering both — the base globally and this one per controller — was the
     * bug. They read the same `@Throttle` metadata and share one storage, so the
     * IP-keyed guard consumed the budget first and one account's failed logins
     * locked out every other account at that address.
     */
    { provide: APP_GUARD, useClass: AuthThrottlerGuard },

    /**
     * Authentication is global, and routes opt **out** with `@Public()`.
     *
     * The inverse — applying the guard per controller — makes forgetting it a
     * silent hole rather than a 401 during development. Every unauthenticated
     * route is now visible in a single grep for the decorator.
     *
     * Ordered after the throttler so an unauthenticated flood is rejected before
     * it costs a signature verification.
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
