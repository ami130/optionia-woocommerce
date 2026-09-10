import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';

import { getTenantId } from '../../common/context/request-context';
import { LIVE_SENTINEL_SQL } from '../../common/database/base.entity';
import { OptionSetStatus } from '../../common/database/enums';
import { DomainException } from '../../common/errors/domain.exception';
import { OptionSetAssignment } from '../entities/option-set-assignment.entity';
import { OptionSetVersion } from '../entities/option-set-version.entity';
import { OptionSet } from '../entities/option-set.entity';
import { Store } from '../../stores/entities/store.entity';
import type { ConfigDocument, PublishedAssignment, PublishedOptionSet } from './projections';

/**
 * The shape version of the document, not its content (M7.5).
 *
 * **Frozen at 1.** The shipped plugin declares `SUPPORTED_SCHEMA_VERSION = 1`
 * and refuses anything higher, keeping its last good copy — so raising this
 * silently switches off every storefront running a plugin build older than the
 * change. It is bumped only for a breaking change to the document's shape, and
 * only alongside a plugin release that understands it.
 *
 * Additive changes do **not** bump it: a reader that ignores a key it does not
 * know is unaffected, which is why the envelope already carries `assignments`
 * and `rules` as empty arrays rather than waiting for Phase 13 and Phase 17.
 */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Assembles the config document a storefront fetches.
 *
 * ## Why it reads snapshots, not live rows
 *
 * The live rows are the merchant's working draft. A document built from them
 * would ship every edit the moment it was typed — which is the opposite of what
 * the draft state exists for, and would make "an edit does not immediately reach
 * storefronts" (M7.4) false.
 *
 * Each published set contributes the snapshot written by its most recent
 * publish. That snapshot is immutable, so a document is reproducible: asking for
 * it twice returns the same content unless something was published in between.
 */
@Injectable()
export class ConfigDocumentBuilder {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The document for one store.
   *
   * ## Two realms, two scopes
   *
   * The intended caller is a **store token** (`GET /store/config`, Phase 9),
   * which names exactly one store and belongs to no tenant — there, the store
   * *is* the scope and the id comes from the token rather than from a path.
   *
   * A **tenant user** may also reach this, for a preview of what a storefront
   * would receive. There the store must belong to their tenant, and this
   * enforces that rather than assuming the caller checked.
   *
   * The earlier version scoped on neither: it looked the store up by id alone
   * and relied on a comment describing a safeguard that was not built — a
   * probe confirmed one tenant could assemble another's full published config.
   * A guarantee stated in a comment and enforced nowhere is the failure this
   * codebase keeps finding, so the predicate lives in the query.
   */
  async build(storeId: string): Promise<ConfigDocument> {
    const tenantId = getTenantId();

    const store = await this.dataSource.getRepository(Store).findOne({
      // `getTenantId()` is null for a store token, which legitimately has no
      // tenant; the token itself resolved the store id, so no narrowing is
      // needed. It is a real tenant for a dashboard user, and then it narrows.
      where: tenantId === null ? { id: storeId } : { id: storeId, tenantId },
    });

    if (!store) {
      // Same answer whether the store does not exist or belongs to someone
      // else (ADR-010): a caller must not learn that an id is real.
      throw DomainException.notFound('Store');
    }

    const sets = await this.dataSource.getRepository(OptionSet).find({
      where: {
        storeId,
        status: OptionSetStatus.PUBLISHED,
        deletedAt: LIVE_SENTINEL_SQL as never,
      },
      // Deterministic: two builds of unchanged data must produce the same
      // bytes, or a merchant comparing documents sees differences that are not.
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    /**
     * Every snapshot in one query, not one query per set.
     *
     * This loop used to `findOne` inside it, so a store cost `N + 2` queries —
     * a merchant with forty published sets paid forty-two round trips, on a
     * document fetched by every store every fifteen minutes and again on every
     * push. The composite key is indexed, so each was fast; the cost was the
     * count, and it multiplied by tenant.
     *
     * The `IN` list is bounded by the number of published sets on one store,
     * which the plan caps well below any statement limit.
     */
    const snapshots = sets.length
      ? await this.dataSource
          .getRepository(OptionSetVersion)
          .createQueryBuilder('v')
          .where('v.optionSetId IN (:...ids)', { ids: sets.map((set) => set.id) })
          .getMany()
      : [];

    /** Keyed by `optionSetId:version` — a set's *current* version, not its latest. */
    const bySetAndVersion = new Map(
      snapshots.map((snapshot) => [`${snapshot.optionSetId}:${snapshot.version}`, snapshot]),
    );

    /**
     * Assignments are read **live**, not taken from the snapshot.
     *
     * A snapshot is the record of what was *published*, and an assignment is not
     * part of that: the same published set is assigned and unassigned without
     * republishing, so storing assignments in the snapshot would make every
     * assignment change require a new version. The snapshot is also immutable,
     * which would leave every set published before this code shipped carrying
     * `assignments: []` for ever — a serializer change could never reach them.
     *
     * So they are joined here, beside the snapshot rather than inside it, the
     * same way `normaliseSnapshot` fills contract-mandatory keys on read without
     * altering what was stored.
     *
     * **Tenant scope is inherited, and that is deliberate.**
     * `option_set_assignments` has no `storeId` — it keys on `optionSetId`
     * alone. The ids below come from `sets`, which is already narrowed by store
     * and, for a dashboard user, by tenant. Reaching this table by any other
     * route would bypass that check, and `check-isolation` inspects routes
     * rather than queries, so it would not notice. The scope has to be correct
     * by construction.
     *
     * One statement for the whole store, not one per set: the `IN` list is the
     * same bounded set of ids the snapshot query already uses.
     */
    const assignments = sets.length
      ? await this.dataSource.getRepository(OptionSetAssignment).find({
          where: {
            optionSetId: In(sets.map((set) => set.id)),
            deletedAt: LIVE_SENTINEL_SQL as never,
          },
          // Deterministic for the same reason the set query is ordered: two
          // builds of unchanged data must produce the same bytes.
          order: { priority: 'ASC', id: 'ASC' },
        })
      : [];

    /** Assignments grouped by the set they belong to. */
    const bySet = new Map<string, PublishedAssignment[]>();

    for (const assignment of assignments) {
      const forSet = bySet.get(assignment.optionSetId) ?? [];

      /**
       * Mapped field by field, never spread.
       *
       * The entity is `camelCase` and carries columns the contract does not:
       * `id`, `optionSetId`, and `matchRules` — the conditional condition tree,
       * which is internal and has no business on a storefront. A spread would
       * put all three on the wire in the wrong case, and no gate would catch it:
       * `check-api-contract` verifies routes, not payload shapes.
       */
      forSet.push({
        mode: assignment.mode,
        target_type: assignment.targetType,
        target_ref: assignment.targetRef,
        priority: assignment.priority,
      });

      bySet.set(assignment.optionSetId, forSet);
    }

    const optionSets: PublishedOptionSet[] = [];

    for (const set of sets) {
      const snapshot = bySetAndVersion.get(`${set.id}:${set.version}`);

      /**
       * A published set with no snapshot at its current version cannot happen —
       * publish writes both in one transaction — so this is a corrupted state
       * rather than a case to handle. It is **skipped rather than thrown**: one
       * broken set must not take a whole storefront's configuration down with
       * it, and every other set on the store still renders.
       */
      if (snapshot) {
        optionSets.push({
          ...normaliseSnapshot(snapshot.snapshot),
          // Live, overriding whatever the snapshot happened to carry.
          assignments: bySet.get(set.id) ?? [],
        });
      }
    }

    return {
      schema_version: CONFIG_SCHEMA_VERSION,
      config_version: Number(store.configVersion),
      store_id: store.id,
      // When the document was assembled. Distinct from a publish time: the same
      // content re-fetched an hour later is the same document, newly stamped.
      generated_at: new Date().toISOString(),
      option_sets: optionSets,
    };
  }
}

/**
 * Guarantee a snapshot has the shape `schema_version: 1` promises.
 *
 * **Snapshots are immutable and outlive the code that wrote them.** A snapshot
 * written before `assignments` and `rules` joined the envelope carries neither
 * key, and shipping it verbatim puts a document on a storefront that contradicts
 * the contract — a PHP reader doing `foreach ($set['rules'])` warns on a key the
 * contract guaranteed is always present.
 *
 * The alternative — rewriting old snapshots — is worse: they are the record of
 * what was actually published, and editing them makes version history a lie
 * (ADR-030's reasoning about rollback applies equally here). So they are
 * normalised **on read**, filling only keys the contract declares mandatory and
 * never altering content.
 *
 * This is what makes "additive changes do not bump `schema_version`" true rather
 * than aspirational: a key added to the envelope appears in every document,
 * including ones assembled from snapshots that predate it.
 */
function normaliseSnapshot(snapshot: Record<string, unknown>): PublishedOptionSet {
  const set = snapshot as unknown as PublishedOptionSet;

  return {
    ...set,
    /**
     * Filled only so the shape is complete before the caller replaces it.
     *
     * Until Phase 10 Stage 1 a snapshot's own assignments were what a storefront
     * received, so they were mapped through a `normaliseAssignment` helper that
     * filled `mode` on documents written before that key existed. Stage 1 made
     * assignments a **live** read, so whatever stands here is discarded a few
     * lines later — and mapping a value nobody reads is the kind of dead work
     * that later reads as a guarantee.
     *
     * Nothing is lost with the helper. Across the whole history of
     * `option-set.serializer.ts`, `assignments: []` is the only value publish has
     * ever written into a snapshot, so no stored document has assignments that
     * needed filling.
     */
    assignments: [],
    rules: set.rules ?? [],
    groups: set.groups ?? [],
  };
}

