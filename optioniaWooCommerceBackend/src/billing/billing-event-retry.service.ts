import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { BillingEvent } from './entities/billing-event.entity';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * 🔴 **Five, and it is a judgement rather than a measurement.** Stripe's own
 * dunning gives up after about a week; this is the number of times *our* worker
 * re-runs a handler that keeps failing before it stops and asks for a human.
 * Too high and a deterministic failure is retried for ever; too low and a
 * database blip buries an event a human must now find.
 */
export const MAX_ATTEMPTS = 5;

/**
 * 📌 **Old enough that the request which wrote it is certainly over.** A row is
 * inserted before processing, so a webhook still in flight has `processedAt`
 * null and would otherwise be picked up and run **concurrently with itself**.
 */
export const RETRY_AFTER_MS = 60_000;

/**
 * Re-running the webhook work that never finished (M23.4).
 *
 * ## What this retries, and what it deliberately does not
 *
 * 🔴 **Stripe's retries and ours must not fight.** Stripe redelivers a non-2xx
 * for days on its own schedule. If this worker also chased those, one failed
 * payment would be attempted twice per cycle — and N1 exists precisely because
 * our own idempotency check once *consumed* Stripe's retries, permanently
 * losing a failed webhook.
 *
 * 📌 **So the target is the work Stripe will NOT retry**: a row we answered
 * `200` to and then failed to finish, and a delivery whose process died
 * mid-handler. Both leave exactly the same trace — `processedAt` null — which
 * is the state N1's ordering was built to make visible.
 *
 * ## Why a table and not a queue
 *
 * ⚠️ **`@nestjs/schedule` keeps nothing across a restart, and that is fine
 * here**, because the queue is `billing_events`. The row is written before the
 * work and settled only on success, so a crash leaves a retryable row rather
 * than a lost job. The table is the durability; this is only what walks it.
 *
 * 🔴 **Which makes the absence of Redis a real choice, not a shortcut** — an
 * in-memory queue would have needed it.
 */
@Injectable()
export class BillingEventRetryService {
  private readonly logger = new Logger(BillingEventRetryService.name);

  constructor(
    @InjectRepository(BillingEvent)
    private readonly events: Repository<BillingEvent>,
    private readonly lifecycle: SubscriptionLifecycleService,
    /* 📌 F125: claiming needs a transaction the repository alone cannot give. */
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Take ownership of up to 50 retryable rows (F125).
   *
   * 🔴 **`FOR UPDATE SKIP LOCKED`, and the SKIP is the point.** Two workers
   * running the same pass would otherwise select the same rows and process each
   * event twice; with `SKIP LOCKED` the second simply sees fewer rows and does
   * the remaining work, rather than blocking behind the first.
   *
   * ⚠️ **The claim is its OWN transaction, deliberately short.** Holding the
   * lock across `lifecycle.apply()` would keep a row locked for the length of a
   * handler — and one slow provider call would stall every other worker. The
   * stamped `attempts` is what carries ownership afterwards, not the lock.
   *
   * 🔴 **`attempts` is incremented HERE, before the work**, so a process that
   * dies mid-handler still burns an attempt. Incrementing on completion would
   * let a crash-looping handler retry for ever without ever reaching the
   * dead-letter limit — the exact failure `deadAt` exists to stop.
   */
  private async claim(cutoff: Date): Promise<BillingEvent[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager
        .createQueryBuilder(BillingEvent, 'e')
        .where('e.processedAt IS NULL')
        .andWhere('e.deadAt IS NULL')
        .andWhere('e.createdAt < :cutoff', { cutoff })
        .orderBy('e.createdAt', 'ASC')
        .limit(50)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (rows.length === 0) {
        return [];
      }

      await manager
        .createQueryBuilder()
        .update(BillingEvent)
        .set({ attempts: () => 'attempts + 1' })
        .whereInIds(rows.map((row) => row.id))
        .execute();

      /* 📌 The in-memory copies must agree with the row we just wrote. */
      return rows.map((row) => Object.assign(row, { attempts: row.attempts + 1 }));
    });
  }

  /**
   * One pass over the retryable rows.
   *
   * ⚠️ **Returns a count rather than logging only**, so a test can assert what
   * happened without reading log output — and so a future ops view can report
   * a run.
   */
  async retryPending(now: Date = new Date()): Promise<{
    retried: number;
    recovered: number;
    deadLettered: number;
  }> {
    const cutoff = new Date(now.getTime() - RETRY_AFTER_MS);

    /*
     * 🔴 **Three conditions, and each is load-bearing** (see `claim`).
     * `processedAt IS NULL` is "never finished"; `deadAt IS NULL` excludes what
     * we already gave up on, or a deterministic failure would be re-run for
     * ever; and the age cutoff keeps this off rows whose original request is
     * still running.
     */
    const pending = await this.claim(cutoff);

    let recovered = 0;
    let deadLettered = 0;

    for (const event of pending) {
      /* 📌 Already incremented by `claim()`; this is the value now in the row. */
      const attempts = event.attempts;

      try {
        const result = await this.lifecycle.apply(event.type, event.payload);

        /*
         * ⚠️ **`error` is cleared on success.** A row that recovered but still
         * carried its first failure's message would read as a permanent
         * failure to whoever queries these later.
         */
        await this.events.update(
          { id: event.id },
          { processedAt: new Date(), error: null, attempts },
        );

        recovered += 1;

        this.logger.log(
          `Recovered ${event.type} (${event.providerEventId}) on attempt ${attempts}: ` +
            (result.changed ? result.detail : `no change (${result.reason})`),
        );
      } catch (error) {
        const message = (error as Error).message;

        /*
         * 🔴 **Give up at the limit, and record WHEN.** Without `deadAt` the
         * row stays retryable for ever: a handler that fails deterministically
         * — an unmapped status, a malformed payload — would be re-run every
         * cycle until a person noticed.
         */
        const dead = attempts >= MAX_ATTEMPTS;

        await this.events.update(
          { id: event.id },
          { error: message, attempts, deadAt: dead ? new Date() : null },
        );

        if (dead) {
          deadLettered += 1;

          /*
           * 🔴 **`error` level, because this needs a person.** Phase 26 will
           * render these; until then the log is the only thing that says a
           * merchant's billing event was abandoned.
           */
          this.logger.error(
            `Dead-lettered ${event.type} (${event.providerEventId}) after ` +
              `${attempts} attempt(s): ${message}`,
          );
        } else {
          this.logger.warn(
            `Retry ${attempts}/${MAX_ATTEMPTS} failed for ${event.type} ` +
              `(${event.providerEventId}): ${message}`,
          );
        }
      }
    }

    return { retried: pending.length, recovered, deadLettered };
  }
}
