import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { loadConfig } from '../config/env';
import { RollupThresholdService } from './rollup-threshold.service';

/**
 * What actually runs the rollup-threshold check (M25.2).
 *
 * ## Why this is a separate file from the work
 *
 * 📌 **The schedule is a deployment decision; the threshold is a rule.** Keeping
 * `@Cron` out of the service means the check is callable from a test, a command
 * or a future queue without dragging a timer in — the same separation
 * `BillingEventRetryScheduler` makes, and for the same reason.
 *
 * ## Why daily rather than hourly
 *
 * 🔴 **The thing being watched moves at the speed of a merchant's sales.** A
 * tenant does not cross 100k selections between two hourly ticks, and the
 * response — building rollup tables, with a migration and a backfill — is days
 * of work rather than minutes. A tighter schedule would query more often to
 * learn the same thing later.
 *
 * ⚠️ **The guard is default-off, like every scheduled worker here.**
 * `@nestjs/schedule` starts its timers the moment the module loads, so without
 * it every test suite that boots the app would run this against the shared test
 * database. `ANALYTICS_ROLLUP_MONITOR_ENABLED` keeps it off unless a deployment
 * asks — and an in-process monitor that every instance runs means N instances
 * log the same warning, which is a deployment question rather than a default.
 */
@Injectable()
export class RollupThresholdScheduler {
  private readonly logger = new Logger(RollupThresholdScheduler.name);

  constructor(private readonly thresholds: RollupThresholdService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run(): Promise<void> {
    /*
     * ⚠️ **Read through `loadConfig()`, never `process.env` directly.** A
     * misspelt flag name would otherwise disable this monitor **silently** —
     * exactly what `BILLING_RETRY_ENABLE=true` did to the retry worker — and a
     * monitor that fails silently is worse than no monitor, because it is
     * believed.
     */
    if (!loadConfig().analytics.rollupMonitorEnabled) {
      return;
    }

    try {
      await this.thresholds.check();
    } catch (error) {
      /*
       * 🔴 **A scheduled job that throws takes nothing else down, but it does
       * go unnoticed.** `@nestjs/schedule` logs an unhandled rejection and
       * carries on, so the failure of the thing that exists to give warning
       * would itself be silent. Logging it here is the only signal.
       *
       * ⚠️ **This wraps the CHECK, not the guard above it.** A broken flag is a
       * configuration error: `loadConfig()` throws, `main.ts` calls it at boot,
       * and the application refuses to start. Catching that here would restore
       * the silence the guard exists to remove.
       */
      this.logger.error(`The rollup threshold check failed: ${(error as Error).message}`);
    }
  }
}
