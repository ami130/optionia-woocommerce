import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { buildDataSourceOptions } from './config/data-source';
import { loadConfig } from './config/env';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
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
      { name: 'short', ttl: 1_000, limit: 20 },
      { name: 'sustained', ttl: 60_000, limit: 300 },
    ]),

    HealthModule,
  ],

  providers: [
    // Order matters: the filter is outermost so it catches anything the
    // interceptor or a guard throws.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
