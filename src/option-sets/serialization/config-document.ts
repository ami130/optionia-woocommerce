import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { getTenantId } from '../../common/context/request-context';
import { LIVE_SENTINEL_SQL } from '../../common/database/base.entity';
import { OptionSetStatus } from '../../common/database/enums';
import { DomainException } from '../../common/errors/domain.exception';
import { OptionSetVersion } from '../entities/option-set-version.entity';
import { OptionSet } from '../entities/option-set.entity';
import { Store } from '../../stores/entities/store.entity';
import type { ConfigDocument, PublishedOptionSet } from './projections';

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

    const optionSets: PublishedOptionSet[] = [];

    for (const set of sets) {
      const snapshot = await this.dataSource.getRepository(OptionSetVersion).findOne({
        where: { optionSetId: set.id, version: set.version },
      });

      /**
       * A published set with no snapshot at its current version cannot happen —
       * publish writes both in one transaction — so this is a corrupted state
       * rather than a case to handle. It is **skipped rather than thrown**: one
       * broken set must not take a whole storefront's configuration down with
       * it, and every other set on the store still renders.
       */
      if (snapshot) {
        optionSets.push(normaliseSnapshot(snapshot.snapshot));
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
    // Mandatory in the contract, absent from snapshots written before 7h.
    assignments: set.assignments ?? [],
    rules: set.rules ?? [],
    groups: set.groups ?? [],
  };
}
