import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { IngestProductDto, IngestProductsDto } from './dto/ingest-products.dto';
import { ReconcileProductsDto } from './dto/reconcile-products.dto';

/** What the plugin learns from one reconcile page. */
export interface ReconcileResult {
  /** How many ids this page claimed. */
  checked: number;

  /**
   * How many mirror rows inside the range the page did not claim.
   *
   * Reported on every page, acted on only when the manifest completes — which
   * lets the plugin surface drift before anything is deleted.
   */
  stale: number;

  /** How many rows were actually deleted. Always 0 on a non-final page. */
  removed: number;
}

/** What the plugin learns from a removal. */
export interface RemoveResult {
  /**
   * Whether a row was actually deleted.
   *
   * The plugin does not branch on it — both outcomes mean "stop retrying" — but
   * it separates a real removal from a redelivery in the log, which is the
   * difference between a catalogue shrinking and a queue repeating itself.
   */
  removed: boolean;
}

/** What the plugin learns from a successful push. */
export interface IngestResult {
  /**
   * How many products this batch wrote — inserted or updated.
   *
   * ✏️ **There is no `inserted` count, and that was settled by measurement.**
   * An earlier version reported one, derived from `affectedRows` — MySQL counts
   * 1 per insert and 2 per update. The arithmetic is **not recoverable**: a row
   * updated to identical values counts **0**, so `affectedRows = 3` on a
   * three-row batch means either three inserts or one insert, one update and
   * one no-op. A count that is sometimes wrong is worse than none, because
   * nothing downstream can tell which time it is.
   */
  accepted: number;
}

/**
 * Catalogue ingest (M19.1).
 *
 * 🔴 **The store pushes; the cloud never pulls** (ADR-067). A pull would need
 * the cloud to hold WooCommerce credentials for every tenant — a high-value
 * secret pool, and the reverse of the trust direction AC8 sets: *"every plugin
 * installation is treated as potentially hostile."* The plugin reads its own
 * catalogue in-process and posts batches here, authenticated by the same store
 * token `POST /store/orders` uses.
 *
 * ⚠️ **`storeId` comes from the guard, never from the body.** `StoreTokenGuard`
 * resolves it from the credential; accepting it as a field would let any
 * connected store write another's catalogue, which is the whole of AC8 in one
 * mistake.
 *
 * ## 🔴 The mirror is append-only until M19.3
 *
 * **This endpoint only ever upserts, and the push sends only products that
 * exist — so nothing here can remove a row.** A product deleted in WooCommerce
 * stays in the mirror indefinitely: the picker keeps offering it, and an
 * assignment can still be created against it.
 *
 * ⚠️ **The safety net for that is currently unreachable.** The dashboard's
 * *"No longer in your catalogue"* warning fires when the joined `productName`
 * is null — that is, when the **row is absent**. A push-driven catalogue never
 * makes a row absent, so the message cannot appear from this path.
 *
 * 📌 **`syncedAt` is the signal already being written for it.** It is refreshed
 * on **every** row in a batch, including unchanged ones, so it records when the
 * cloud last *heard about* a product rather than when the product last changed
 * (`externalUpdatedAt` is that). A row whose `syncedAt` falls behind a
 * completed walk is one the store has stopped mentioning. **Nothing reads it
 * yet** — [M19.3](../../developePlan.md)'s reconciliation is the owner, and
 * this is recorded here so the gap is inherited deliberately rather than
 * discovered.
 */
@Injectable()
export class CatalogueIngestService {
  private readonly logger = new Logger(CatalogueIngestService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Write one batch of products.
   *
   * ## One statement, not one per product
   *
   * A 250-product batch as 250 round trips would spend the request in latency
   * rather than work. A single multi-row `INSERT … ON DUPLICATE KEY UPDATE`
   * makes the batch one statement and one transaction.
   *
   * ## Why raw SQL rather than the repository
   *
   * `ProductsRepository` scopes every read with `requireTenantId()`, and a
   * store-token request has **no tenant in context** — the guard resolves a
   * *store*. `OrdersService.report()` is the precedent: store-authenticated
   * writes take `storeId` from the guard and use raw SQL for exactly this
   * reason.
   */
  async ingest(storeId: string, dto: IngestProductsDto): Promise<IngestResult> {
    const products = dto.products;

    return this.dataSource.transaction(async (manager) => {
      const columns =
        '(id, storeId, externalId, name, sku, type, priceMinor, status, ' +
        'permalink, imageUrl, categories, tags, syncedAt, externalUpdatedAt, ' +
        'createdAt, updatedAt)';

      const rows = products
        .map(() => '(UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), ?, NOW(3), NOW(3))')
        .join(', ');

      const parameters = products.flatMap((product) => this.parametersFor(storeId, product));

      /**
       * `ON DUPLICATE KEY UPDATE` against `uq_store_products_external
       * (storeId, externalId)`.
       *
       * ⚠️ **`syncedAt` is refreshed on every row, including unchanged ones.**
       * It records when the cloud last *heard about* a product, not when the
       * product last changed — that is `externalUpdatedAt`. M19.3's
       * reconciliation reads the first to find rows the store has stopped
       * mentioning, so leaving it stale on an unchanged row would make a live
       * product look abandoned.
       *
       * 📌 **No `deletedAt` in the key.** `store_products` extends
       * `BaseEntity`, not `SoftDeletableEntity` — it is hard-deleted by design
       * — so this is not the NULL-collision trap ADR-070 recorded for
       * assignments.
       */
      const result: { affectedRows: number } = await manager.query(
        `INSERT INTO store_products ${columns} VALUES ${rows}
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           sku = VALUES(sku),
           type = VALUES(type),
           priceMinor = VALUES(priceMinor),
           status = VALUES(status),
           permalink = VALUES(permalink),
           imageUrl = VALUES(imageUrl),
           categories = VALUES(categories),
           tags = VALUES(tags),
           syncedAt = VALUES(syncedAt),
           externalUpdatedAt = VALUES(externalUpdatedAt),
           updatedAt = NOW(3)`,
        parameters,
      );

      /*
       * `affectedRows` is logged raw rather than interpreted. It is 1 per
       * insert, 2 per update and 0 per no-op update, which makes inserts and
       * updates indistinguishable — useful as a trace, not as a count.
       */
      this.logger.log(
        `Catalogue batch ingested. store=${storeId} products=${products.length} ` +
          `affectedRows=${result.affectedRows}`,
      );

      return { accepted: products.length };
    });
  }

  /**
   * Reconcile one page of the store's ids against the mirror (M19.3).
   *
   * 🔴 **Deletes only on a complete manifest, and only inside its range**
   * (ADR-075). Absence from a *page* does not mean a product is gone — during
   * an ordinary paged sweep every id outside the current page is absent from
   * it. Modelled: a mirror of 40,000 products and a page of 250 would leave
   * **39,750 valid products deleted**.
   *
   * So a non-final page reports drift and changes nothing. The final page
   * deletes, bounded by `[range_start, max(external_ids)]` — the span the
   * manifest actually covered. A row outside that span was never claimed either
   * way, and deleting it would be guessing.
   *
   * ⚠️ **String comparison, because `externalId` is `varchar`.** WooCommerce
   * ids are numeric today, but the column is a string and an assignment's
   * `targetRef` compares as one. Casting here would make the range behave
   * differently from every other comparison against this column.
   */
  async reconcile(storeId: string, dto: ReconcileProductsDto): Promise<ReconcileResult> {
    const ids = dto.external_ids;
    const rangeStart = dto.range_start ?? ids[0];
    const isFinal = dto.is_final === true;

    /**
     * 🔴 **The final page is unbounded above, and an earlier draft was not —
     * a failing test found it.**
     *
     * Deriving the ceiling from the page's own highest id means the store's
     * **highest** product can never be reconciled: delete `wc-9` from a
     * catalogue of `wc-1…wc-9` and the final manifest is `wc-1…wc-8`, whose
     * range stops at `wc-8`. `wc-9` sits outside it and survives every sweep,
     * for ever.
     *
     * A final page says *"this is the whole store from `range_start` upward"*,
     * so above that floor there is nothing left to be cautious about. A
     * **non-final** page keeps the ceiling, because everything above it is
     * still coming.
     */
    const rangeEnd = isFinal ? null : ids[ids.length - 1];

    /*
     * Compared in SQL rather than loaded and filtered: a 100k catalogue would
     * otherwise cross the wire twice to answer a question about set membership.
     */
    const held: Array<{ externalId: string }> =
      rangeEnd === null
        ? await this.dataSource.query(
            `SELECT externalId FROM store_products WHERE storeId = ? AND externalId >= ?`,
            [storeId, rangeStart],
          )
        : await this.dataSource.query(
            `SELECT externalId FROM store_products
              WHERE storeId = ? AND externalId >= ? AND externalId <= ?`,
            [storeId, rangeStart, rangeEnd],
          );

    const claimed = new Set(ids);
    const stale = held.map((row) => row.externalId).filter((id) => !claimed.has(id));

    if (!isFinal) {
      /*
       * A page reports and does not act. The plugin uses the count to surface
       * progress; the decision waits for the whole manifest.
       */
      return { checked: ids.length, stale: stale.length, removed: 0 };
    }

    if (stale.length === 0) {
      return { checked: ids.length, stale: 0, removed: 0 };
    }

    const result: { affectedRows: number } = await this.dataSource.query(
      `DELETE FROM store_products
        WHERE storeId = ? AND externalId IN (${stale.map(() => '?').join(', ')})`,
      [storeId, ...stale],
    );

    this.logger.log(
      `Catalogue reconciled. store=${storeId} checked=${ids.length} removed=${result.affectedRows}`,
    );

    return { checked: ids.length, stale: stale.length, removed: result.affectedRows };
  }

  /**
   * Remove one product from the mirror (M19.2).
   *
   * 🔴 **Trash and delete both arrive here** (ADR-074). `CataloguePayload`'s
   * walk covers `publish`, `draft`, `pending` and `private` — **not `trash`** —
   * so a trashed product is not "a product with another status" to this mirror;
   * it is one that should no longer be in it. Mirroring the status instead
   * would leave the full walk and the increment disagreeing, and M19.3's
   * reconciliation would then undo whatever the increment had just written.
   *
   * ⚠️ **Idempotent, and silent about a miss.** The plugin's queue can deliver
   * the same removal twice, and a product deleted before it was ever pushed was
   * never here. Both are the desired end state — the row is gone — so neither
   * is an error the plugin should act on.
   *
   * 📌 **Assignments are not deleted with it.** An assignment row is the
   * merchant's *intent*, and a product trashed by accident and restored an hour
   * later must not lose it. The picker renders "No longer in your catalogue"
   * from the absent row; M19.5's bulk tooling is where clearing them belongs.
   */
  async remove(storeId: string, externalId: string): Promise<RemoveResult> {
    const result: { affectedRows: number } = await this.dataSource.query(
      `DELETE FROM store_products WHERE storeId = ? AND externalId = ?`,
      [storeId, externalId],
    );

    const removed = result.affectedRows > 0;

    this.logger.log(
      `Catalogue product removed. store=${storeId} external=${externalId} existed=${removed}`,
    );

    return { removed };
  }

  /** One product's parameters, in the order the statement's placeholders expect. */
  private parametersFor(storeId: string, product: IngestProductDto): unknown[] {
    return [
      storeId,
      product.external_id,
      product.name,
      product.sku ?? null,
      product.type,
      product.price_minor ?? null,
      product.status,
      product.permalink ?? null,
      product.image_url ?? null,
      /*
       * `json` columns take a JSON string, and `null` is a JSON *value* — so
       * these are stringified only when present. Passing the string "null"
       * would store a JSON null the picker cannot tell from an empty list.
       */
      product.categories === undefined || product.categories === null
        ? null
        : JSON.stringify(product.categories),
      product.tags === undefined || product.tags === null ? null : JSON.stringify(product.tags),
      this.parseTimestamp(product.external_updated_at),
    ];
  }

  /**
   * An upstream timestamp, or null.
   *
   * `@IsISO8601()` accepts shapes `Date` still cannot parse, so an unparseable
   * value becomes null rather than `Invalid Date` — which MySQL would reject
   * mid-batch and turn one bad field into a failed push of 250 good products.
   */
  private parseTimestamp(value: string | null | undefined): Date | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
