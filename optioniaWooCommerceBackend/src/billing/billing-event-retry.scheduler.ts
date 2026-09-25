import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { loadConfig } from '../config/env';
import { BillingEventRetryService } from './billing-event-retry.service';

/**
 * What actually runs M23.4's retry pass.
 *
 * ## Why this is a separate file from the work
 *
 * 📌 **The schedule is a deployment decision; the retry is a rule.** Keeping
 * `@Cron` out of the service means the logic is callable from a test, a command
 * or a future queue without dragging a timer in — the same separation M23.5
 * used, and the reason that milestone could be built while this one's
 * infrastructure question was still open.
 *
 * ## Why @nestjs/schedule is pinned to 6.x
 *
 * 🔴 **v12 is pure ESM and this project is CommonJS.** `@nestjs/schedule@12`
 * ships `"type": "module"` with no CommonJS build, so Jest cannot parse it —
 * *"unexpected token: export * from './enums/index.js'"* — and **every suite
 * that loads this file fails to run**, not just this one. It is the same
 * constraint that forces `import Stripe = require('stripe')` elsewhere.
 *
 * 📌 **6.1.3 is the newest CommonJS release** and declares
 * `@nestjs/core: ^10 || ^11`, which covers the 11.x this project uses. There is
 * no 7–11: the versions jump 6.1.3 → 12.0.0.
 *
 * ## Why the guard exists
 *
 * 🔴 **`@nestjs/schedule` starts timers the moment the module loads**, which in
 * a test run means every suite that boots the app also starts retrying billing
 * events against the shared test database — from a process the test does not
 * control and cannot wait for. `BILLING_RETRY_ENABLED` keeps it off unless a
 * deployment asks for it.
 *
 * ⚠️ **Default OFF, deliberately.** An in-process worker that every instance
 * runs means N instances retry the same rows concurrently; turning it on is a
 * decision about how the service is deployed, not a default to inherit.
 *
 * 📌 **`loadConfig()` is called per tick, not cached.** It re-validates the
 * whole environment, which is a few microseconds every five minutes — and it
 * means an operator who fixes a typo does not have to restart the process.
 */
@Injectable()
export class BillingEventRetryScheduler {
  private readonly logger = new Logger(BillingEventRetryScheduler.name);

  constructor(private readonly retries: BillingEventRetryService) {}

  /**
   * 📌 **Every five minutes, not every minute.** The rows this reaches are ones
   * Stripe will not retry, so nothing is racing a provider; and `RETRY_AFTER_MS`
   * already excludes anything newer than a minute, so a tighter schedule would
   * mostly query for nothing.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async run(): Promise<void> {
    /*
     * ⚠️ **Read through `loadConfig()`, not `process.env` directly.** The first
     * version compared the raw string, so `BILLING_RETRY_ENABLE=true` — one
     * missing letter — disabled the worker **silently**: the pass never ran and
     * nothing said why. `bool()` throws on a value it cannot parse, and accepts
     * the same `true/1/yes` spellings as every other flag in this system.
     */
    if (!loadConfig().billing.retryEnabled) {
      return;
    }

    try {
      const outcome = await this.retries.retryPending();

      if (outcome.retried > 0) {
        this.logger.log(
          `Retried ${outcome.retried} billing event(s): ` +
            `${outcome.recovered} recovered, ${outcome.deadLettered} dead-lettered`,
        );
      }
    } catch (error) {
      /*
       * ⚠️ **This wraps the PASS, deliberately not the guard above it.** A
       * broken `BILLING_RETRY_ENABLED` is a configuration error, not a
       * transient failure: `loadConfig()` throws, `main.ts` calls it at boot,
       * and the application refuses to start. Catching it here would restore
       * exactly the silence this guard was moved into config to remove.
       *
       * 🔴 **A scheduled job that throws takes nothing else down, but it does
       * go unnoticed.** `@nestjs/schedule` logs an unhandled rejection and
       * carries on, so the failure of the thing that exists to catch failures
       * would itself be silent. Logging it here is the only signal.
       */
      this.logger.error(`The billing retry pass failed: ${(error as Error).message}`);
    }
  }
}
