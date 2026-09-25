import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ConfigVersionService } from '../common/config-version.service';
import { Store } from '../stores/entities/store.entity';

/**
 * Telling a merchant's storefronts that their plan moved (F121, M9.4b).
 *
 * ## The gap this closes
 *
 * 🔴 **No billing path bumped `configVersion` at all.** Every caller of
 * `ConfigVersionService.bump()` lived in `src/option-sets/` — publish,
 * assignments, cascade, hard-delete. Nothing plan-related called it, so a
 * merchant who upgraded kept a stale config and saw *"I paid and nothing
 * happened"*, and one who downgraded kept serving higher-tier options.
 *
 * ⚠️ **Bounded, and worth stating honestly: this is a ≤15-minute window, not
 * a permanent hole.** F39 recorded that a stale config self-heals on the cron.
 * The defect is real — a merchant should not wait a quarter of an hour for a
 * plan they just paid for — but it is not indefinite, and an earlier note in
 * this repository overstated it.
 *
 * 📌 **M9.4b predicted this and assigned it here.** Its trigger table says in
 * bold *"Plan or subscription changed — 🔴 not covered… wire it in Phase 23"*,
 * and F39 closed only the documentation overclaim, not the work.
 *
 * ## Why this is a separate service
 *
 * 📌 **Two callers, one rule.** The webhook lifecycle and the reconciler both
 * move a plan, and F121's whole argument was that fixing one and not the other
 * would look closed while staying broken. A shared service is what makes
 * "every path that moves a plan invalidates config" a single, checkable fact.
 */
@Injectable()
export class PlanChangeInvalidatorService {
  private readonly logger = new Logger(PlanChangeInvalidatorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configVersion: ConfigVersionService,
  ) {}

  /**
   * Invalidate every storefront belonging to a tenant whose plan just moved.
   *
   * 🔴 **Best-effort, and that is the OPPOSITE of publishing's contract.**
   * `bump()` throws when a store is missing, deliberately rolling back the
   * caller's transaction — right for a publish, **wrong here**. A webhook that
   * fails because of a store bookkeeping problem is an event Stripe retries
   * forever and that can never succeed, which is exactly the defect N1 fixed.
   * The plan change is what must survive; the bump is a notification.
   *
   * ⚠️ **So failures are logged, never thrown.** A caller that wants the
   * stricter contract should call `bump()` directly.
   */
  async invalidate(tenantId: string, manager?: EntityManager): Promise<number> {
    const runner = manager ?? this.dataSource.manager;

    /*
     * 📌 **Every store the tenant owns, with no status filter** — matching what
     * every existing `bump()` caller does. They gate on *visibility*, never on
     * connection state, and a store that is disconnected today should serve
     * fresh configuration when it reconnects rather than a stale plan's.
     */
    const stores = await runner.find(Store, {
      where: { tenantId },
      select: { id: true },
    });

    if (stores.length === 0) {
      /*
       * ⚠️ **Not an error.** A merchant can pay before connecting a store —
       * that is the normal order — and there is nothing to invalidate.
       */
      return 0;
    }

    let bumped = 0;

    for (const store of stores) {
      try {
        await this.configVersion.bump(runner, store.id);
        bumped += 1;
      } catch (error) {
        /*
         * 🔴 **One store must not deny the others.** A tenant with three
         * storefronts and one broken row should still have two told.
         */
        this.logger.warn(
          `Could not invalidate config for store ${store.id} of tenant ${tenantId}: ` +
            `${(error as Error).message}`,
        );
      }
    }

    return bumped;
  }
}
