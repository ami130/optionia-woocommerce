import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DomainException } from '../common/errors/domain.exception';
import { ConfigDocumentBuilder } from '../option-sets/serialization/config-document';
import type { ConfigDocument } from '../option-sets/serialization/projections';
import { configEtag, matchesEtag } from './config-etag';

/** What the endpoint should send. */
export type ConfigDelivery =
  | { readonly kind: 'not-modified'; readonly etag: string }
  | { readonly kind: 'document'; readonly etag: string; readonly document: ConfigDocument };

/**
 * Serves the config document a storefront renders from (M9.1).
 *
 * ## The conditional path must not build the document
 *
 * A storefront asks this question every fifteen minutes, and the answer is
 * almost always "nothing changed". Answering it costs **one indexed read** of
 * `stores.configVersion`; building the document costs a query for the store, a
 * query for its published sets, and a query for their snapshots.
 *
 * Doing the cheap thing first is the entire point of a conditional request. An
 * implementation that built the document and then discarded it would still
 * return a correct `304` — and would have paid the full cost to send nothing,
 * which is the failure mode worth naming because it is invisible in a test that
 * only checks the status code.
 */
@Injectable()
export class ConfigDeliveryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly documents: ConfigDocumentBuilder,
  ) {}

  /**
   * Decide what to send for one store.
   *
   * @param storeId       The store named by the presented credential.
   * @param ifNoneMatch   The client's `If-None-Match` header, if any.
   */
  async deliver(storeId: string, ifNoneMatch?: string): Promise<ConfigDelivery> {
    const version = await this.currentVersion(storeId);
    const etag = configEtag(storeId, version);

    if (matchesEtag(ifNoneMatch, etag)) {
      return { kind: 'not-modified', etag };
    }

    const document = await this.documents.build(storeId);

    /**
     * The validator is rebuilt from the document, not reused from above.
     *
     * A publish landing between the two reads would otherwise label a *new*
     * document with the *old* version, and the plugin would cache it under a
     * validator it already holds — so the next conditional request returns 304
     * and the storefront never sees the change. Rare, silent, and permanent
     * until the next publish.
     */
    return {
      kind: 'document',
      etag: configEtag(storeId, document.config_version),
      document,
    };
  }

  /**
   * The store's content revision, by itself.
   *
   * Selects one column rather than hydrating the entity: this runs on every
   * conditional request from every store, and the other columns are not read.
   */
  private async currentVersion(storeId: string): Promise<number> {
    const rows = (await this.dataSource.query(
      `SELECT configVersion FROM stores WHERE id = ? LIMIT 1`,
      [storeId],
    )) as Array<{ configVersion: string | number }>;

    if (rows.length === 0) {
      /**
       * A credential naming a store that no longer exists.
       *
       * `NOT_FOUND` rather than `UNAUTHENTICATED`: the credential was valid —
       * `StoreTokenGuard` already accepted it — so telling the caller their
       * token is bad would send them to reconnect a store that is gone.
       */
      throw DomainException.notFound('Store');
    }

    return Number(rows[0].configVersion);
  }
}
