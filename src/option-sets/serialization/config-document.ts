import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
   * **Not tenant-scoped by a repository**, because its caller is a store token
   * rather than a user (AC8, Phase 9): the store *is* the scope. The store id is
   * resolved from the authenticated token, never from a path a caller controls.
   */
  async build(storeId: string): Promise<ConfigDocument> {
    const store = await this.dataSource.getRepository(Store).findOne({
      where: { id: storeId },
    });

    if (!store) {
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
        optionSets.push(snapshot.snapshot as unknown as PublishedOptionSet);
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
