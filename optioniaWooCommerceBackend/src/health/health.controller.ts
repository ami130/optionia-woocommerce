import { Controller, Get } from '@nestjs/common';

import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/guards/public.decorator';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

/**
 * Liveness and readiness.
 *
 * Deliberately **unversioned** (`/health`, not `/v1/health`): monitoring and
 * load balancers should not have to track API versions to know whether the
 * service is up. See ADR-011.
 *
 * Also excluded from the response envelope — Terminus returns a flat body that
 * probes expect, and wrapping it would break them for no benefit.
 */
/**
 * Unauthenticated, deliberately.
 *
 * Authentication is global (`APP_GUARD`), so this marker is what keeps the probe
 * reachable. A load balancer has no credentials, and a health check returning 401
 * is indistinguishable from one returning 500 — the orchestrator restarts a
 * healthy service in a loop.
 *
 * The body is safe to expose: connectivity, a version and a Node version. It
 * reveals nothing about tenants or data.
 */
@Public()
/**
 * Never rate limited.
 *
 * A liveness probe polls continuously and has no credentials, so it trips the
 * burst bucket within seconds. A 429 there is indistinguishable from a 500 to an
 * orchestrator, which restarts a healthy service in a loop — the same failure the
 * `@Public()` marker above prevents, arriving by a different route.
 *
 * Safe to exempt: the endpoint reads one connection and returns three constants.
 *
 * Every bucket is named explicitly. `@SkipThrottle()` with no argument sets the
 * skip for `default` alone — the guard checks the flag per named bucket — so the
 * bare form left `short` and `sustained` active and 10 of 30 probes were still
 * rejected.
 */
@SkipThrottle({ default: true, short: true, sustained: true })
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
  ) {}

  /**
   * Reports database connectivity and build version.
   *
   * The database check is a real query, not a connection-pool lookup: a pool
   * can report healthy while the server behind it is unreachable, which is
   * precisely the failure a probe exists to catch.
   *
   * Returns 200 when healthy, 503 otherwise, which is what a load balancer
   * acts on.
   */
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.pingCheck('database', { timeout: 3000 }),
      () =>
        Promise.resolve({
          build: {
            status: 'up' as const,
            version: process.env.npm_package_version ?? 'unknown',
            node: process.version,
          },
        }),
    ]);
  }
}
