import { Controller, Get } from '@nestjs/common';
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
