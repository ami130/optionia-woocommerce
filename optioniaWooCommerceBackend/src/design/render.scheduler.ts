import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { loadConfig } from '../config/env';
import { RenderWorkerService } from './render-worker.service';

/**
 * What actually runs the render pass (M26e.4).
 *
 * ## Why this is a separate file from the work
 *
 * 📌 **The schedule is a deployment decision; the render is a rule.** Keeping
 * `@Cron` out of the worker means the pass stays callable from a test, a
 * command or a future queue without dragging a timer in — the same separation
 * `BillingEventRetryScheduler` keeps, and for the same reason.
 *
 * 🔴 **I built the rule and not the schedule, and an audit caught it.** For one
 * commit `renderPending()` had no production caller at all: a store could
 * request a render, a row was written, and nothing ever rendered it. Every job
 * sat at `preparing` for ever. `check-reachable` passed throughout, because
 * registering a provider in a module satisfies *reachable* without anything
 * ever CALLING it — the same "named is not rendered" boundary the symbol gate
 * already records, in a new place.
 *
 * ## Why it is off by default
 *
 * ⚠️ **`@nestjs/schedule` starts timers the moment the module loads**, which in
 * a test run means every suite that boots the app renders against the shared
 * test database from a process the test does not control and cannot wait for.
 *
 * 🔴 **And N instances would each drain the same queue.** `FOR UPDATE SKIP
 * LOCKED` keeps that safe rather than corrupt — the second worker claims
 * different rows — but it is still N times the rasterisation for one queue, and
 * rasterising is the expensive thing in this pipeline. Turning it on is a
 * decision about how the service is deployed, not a default to inherit.
 */
@Injectable()
export class RenderScheduler {
  private readonly logger = new Logger(RenderScheduler.name);

  constructor(private readonly worker: RenderWorkerService) {}

  /**
   * 📌 **Every minute, where billing retries every five.** A print file is on
   * a customer's order and a merchant may be waiting to fulfil it, so latency
   * matters here in a way it does not for a webhook nobody is watching —
   * Decision 2's whole premise is that the customer has already checked out,
   * not that the file can take an hour. `RENDER_AFTER_MS` excludes anything
   * newer than five seconds, so a tighter schedule would mostly find nothing.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    /*
     * ⚠️ **Read through `loadConfig()`, not `process.env`.** The billing
     * scheduler records what the raw-string version cost: `BILLING_RETRY_ENABLE`
     * — one missing letter — disabled the worker SILENTLY, the pass never ran,
     * and nothing said why. `bool()` throws on a value it cannot parse.
     */
    if (!loadConfig().designRenderEnabled) {
      return;
    }

    try {
      const outcome = await this.worker.renderPending();

      if (outcome.claimed > 0) {
        this.logger.log(
          `Rendered ${outcome.claimed} job(s): ` +
            `${outcome.rendered} succeeded, ${outcome.deadLettered} dead-lettered`,
        );
      }

      /*
       * 🔴 **The deadline is only real if something reads it.** `collectBy` is
       * stamped by the worker and cleared on collection; without this call it
       * was written and never asked about, which is the same as not having it.
       * Decision 3a: *"if collection ever fails silently, the buffer becomes
       * the home by accident."*
       *
       * ⚠️ **`warn`, not `log`.** An overdue buffer is not throughput news —
       * it means a merchant's print file is sitting in the cloud because
       * collection is broken, and it is the one symptom that otherwise looks
       * exactly like success.
       */
      const overdue = await this.worker.countUncollected();

      if (overdue > 0) {
        this.logger.warn(
          `${overdue} rendered file(s) past their collection deadline — ` +
            'the plugin is not collecting. The bytes are retained.',
        );
      }
    } catch (error) {
      /*
       * ⚠️ **This wraps the PASS, deliberately not the guard above it.** A
       * broken `DESIGN_RENDER_ENABLED` is a configuration error rather than a
       * transient failure: `loadConfig()` throws, `main.ts` calls it at boot,
       * and the application refuses to start. Catching it here would restore
       * exactly the silence the flag was moved into config to remove.
       *
       * 🔴 **A scheduled job that throws takes nothing else down, and goes
       * unnoticed.** `@nestjs/schedule` logs an unhandled rejection and carries
       * on — so the failure of the thing that produces print files would itself
       * be silent, and a merchant would learn of it from a customer.
       */
      this.logger.error(`The render pass failed: ${(error as Error).message}`);
    }
  }
}
