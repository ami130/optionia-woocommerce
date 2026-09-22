import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { DeliveryStatus, WebhookDirection } from './database/enums';
import { Store } from '../stores/entities/store.entity';

/**
 * Advances a store's content revision (M9.4b).
 *
 * ## Why this is a service rather than a private method
 *
 * `config_version` is the only thing a storefront uses to decide it is behind:
 * `GET /store/config` builds its ETag from it, so a change that does not move
 * it is a change no plugin ever fetches. Every connected store keeps serving
 * the old document until something else happens to publish.
 *
 * It began as a private method on `PublishService`, which made publishing the
 * only caller that *could* bump — and deleting a published set, which removes
 * it from the document, silently did not. That was not an oversight anyone
 * could see: the bump was unreachable from where the deletion happened.
 *
 * M9.4b enumerates six more triggers, spread across authoring, billing and
 * store settings, and several land in phases that have not started. Giving them
 * something to **call** rather than something to reimplement is the difference
 * between one rule and six copies of `configVersion + 1`.
 *
 * ## Always inside the caller's transaction
 *
 * The bump takes an `EntityManager` rather than opening its own. A version
 * advanced outside the change it describes can commit while the change rolls
 * back — storefronts would refetch and receive the *old* document under a *new*
 * version, and then hold it as current until the next publish. Taking the
 * caller's manager makes that impossible rather than merely unlikely.
 */
/**
 * The one event this queue carries today.
 *
 * Named rather than inlined because the worker in `M34.1c` matches on it, and a
 * string repeated in two repositories is a string that drifts.
 */
const PUSH_EVENT = 'config.updated';

@Injectable()
export class ConfigVersionService {
  /**
   * Advance the store's revision by one, and return the new value.
   *
   * `configVersion + 1` in SQL rather than read-modify-write: two publishes
   * landing together must produce two increments, not one.
   *
   * @param manager The caller's transaction. Never a fresh one.
   * @param storeId The store whose document changed.
   */
  async bump(manager: EntityManager, storeId: string): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(Store)
      .set({ configVersion: () => 'configVersion + 1' } as never)
      .where('id = :id', { id: storeId })
      .execute();

    /**
     * A bump that changed nothing is the bug this service exists to prevent.
     *
     * `UPDATE … WHERE id = ?` against a store that is not there affects zero
     * rows and raises nothing, so the caller is told the invalidation happened
     * when it did not — the same silent shape as the deletion bug: a change a
     * storefront should see, reported as done and never delivered.
     *
     * Throwing inside the caller's transaction is the point. The change that
     * prompted the bump rolls back with it, so the database never holds
     * published configuration that no storefront was told about.
     */
    if ((result.affected ?? 0) === 0) {
      throw new Error(
        `Cannot advance config_version: no store ${JSON.stringify(storeId)}. ` +
          'The change that prompted this bump has been rolled back.',
      );
    }

    const store = await manager.findOne(Store, { where: { id: storeId } });
    const configVersion = Number(store?.configVersion ?? 0);

    await this.enqueuePush(manager, store, configVersion);

    return configVersion;
  }

  /**
   * Queue a "new configuration is available" push (M9.4).
   *
   * ## Why here rather than in publishing
   *
   * Every trigger that advances the version is, by definition, one a storefront
   * should be told about — that is what advancing it *means*. Putting the
   * enqueue beside the bump makes the pair inseparable: M9.4b's remaining
   * triggers, and Phase 13's assignment CRUD, get the push by calling the same
   * method rather than by remembering a second one.
   *
   * ## Why a row rather than a request
   *
   * Nothing sends it yet. There is no worker in this codebase — no scheduler,
   * no queue consumer — and `M34.1` states that webhook processing "must not
   * run in the request path", which is exactly what dispatching here would be:
   * a merchant clicking Publish would wait on an HTTP call to their own shop.
   *
   * So the row is written and
   * [M34.1c](../../../developePlan.md) drains it. Nothing is broken meanwhile:
   * the plugin's fifteen-minute conditional pull already delivers every change
   * inside M9.4's fallback window, so the push is a latency improvement — 30
   * seconds instead of 15 — over a working baseline.
   *
   * ## Why it is skipped without a push URL
   *
   * A store connected by a plugin build predating the REST route has no
   * `pushUrl`, and a delivery with nowhere to go is a row the worker can only
   * fail. Those stores fall back to the pull, which is the acceptance's own
   * fallback path.
   *
   * @param manager       The caller's transaction, so the row commits with the change.
   * @param store         The store whose document changed, or null when it vanished.
   * @param configVersion The version now current.
   */
  private async enqueuePush(
    manager: EntityManager,
    store: Store | null,
    configVersion: number,
  ): Promise<void> {
    if (!store?.pushUrl) {
      return;
    }

    await manager.query(
      `INSERT INTO webhook_deliveries (storeId, direction, event, payload, status, createdAt)
       VALUES (?, ?, ?, ?, ?, NOW(3))`,
      [
        store.id,
        WebhookDirection.OUTBOUND,
        PUSH_EVENT,
        JSON.stringify({ event: PUSH_EVENT, config_version: configVersion }),
        DeliveryStatus.PENDING,
      ],
    );
  }

  /**
   * Advance the revision only when the change is one a storefront can see.
   *
   * The config document is built from **published snapshots**, so a draft is
   * invisible to it: creating, editing, duplicating or deleting one changes
   * nothing a plugin would fetch, and bumping for it would invalidate every
   * storefront cache for an edit no customer can observe.
   *
   * That distinction is why this takes a status rather than leaving each caller
   * to decide. "Was it published?" is one question with one answer, and a
   * caller that guessed it wrong would produce either a stale storefront or a
   * needless full refetch on every keystroke of authoring.
   *
   * @param manager    The caller's transaction.
   * @param storeId    The store whose document may have changed.
   * @param wasVisible Whether the affected set was published at the time.
   */
  async bumpIfVisible(
    manager: EntityManager,
    storeId: string,
    wasVisible: boolean,
  ): Promise<number | null> {
    if (!wasVisible) {
      return null;
    }

    return this.bump(manager, storeId);
  }
}
