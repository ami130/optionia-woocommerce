import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';
import { MAX_PRODUCTS_PER_PUSH } from '../src/products/dto/ingest-products.dto';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * Catalogue ingest (M19.1).
 *
 * The push half of ADR-067: the store reads its own catalogue and posts it,
 * because the cloud holds no WooCommerce credentials and AC8 forbids it holding
 * any. Three properties carry this endpoint — **idempotency**, because the
 * plugin retries and resumes; **store isolation**, because a catalogue is a
 * merchant's commercial data; and **partial-batch integrity**, because a bad
 * row must not cost 249 good ones.
 */
describe('catalogue ingest (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('cat191');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    await harness.tenant('a');
    await harness.tenant('b');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  /** A connected store with a live credential — a plugin that can push. */
  async function connected(tenant: 'a' | 'b' = 'a'): Promise<{ id: string; token: string }> {
    const id = await harness.store(tenant);
    const credential = generateStoreToken();

    await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
      StoreStatus.CONNECTED,
      id,
    ]);
    await dataSource.query(
      `INSERT INTO store_credentials
         (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
       VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
      [id, credential.hash, credential.prefix],
    );

    return { id, token: credential.plaintext };
  }

  /** A well-formed product; individual tests override what they are about. */
  const product = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    external_id: `wc-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Custom Hoodie',
    sku: 'HOOD-1',
    type: 'simple',
    price_minor: 1799,
    status: 'publish',
    permalink: 'https://store.example.com/product/custom-hoodie/',
    image_url: null,
    categories: ['Apparel'],
    tags: ['bestseller'],
    external_updated_at: '2026-09-14T06:00:00.000Z',
    ...overrides,
  });

  const push = (token: string, body: object): request.Test =>
    request(app.getHttpServer())
      .post('/v1/store/products')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const productsFor = async (storeId: string): Promise<Array<Record<string, unknown>>> =>
    dataSource.query(`SELECT * FROM store_products WHERE storeId = ? ORDER BY externalId`, [
      storeId,
    ]);

  // --- The happy path ------------------------------------------------------

  it('writes a pushed product', async () => {
    const store = await connected();

    const response = await push(store.token, {
      products: [product({ external_id: 'wc-1', name: 'Hoodie' })],
    }).expect(200);

    expect(response.body.data).toEqual({ accepted: 1 });

    const [row] = await productsFor(store.id);

    expect(row.externalId).toBe('wc-1');
    expect(row.name).toBe('Hoodie');
    expect(Number(row.priceMinor)).toBe(1799);
  });

  /**
   * 🔴 The whole point of the mirror: the picker resolves an assignment's
   * `targetRef` against `externalId`, so a product stored under any other key
   * is a product no assignment can reach.
   */
  it('stores categories and tags as arrays the picker can read', async () => {
    const store = await connected();

    await push(store.token, {
      products: [product({ external_id: 'wc-2', categories: ['Apparel', 'Winter'], tags: ['new'] })],
    }).expect(200);

    const [row] = await productsFor(store.id);

    expect(row.categories).toEqual(['Apparel', 'Winter']);
    expect(row.tags).toEqual(['new']);
  });

  /**
   * 🔴 **A JSON `null` is not the same as SQL `NULL`, and a surviving mutant
   * found this gap.** `JSON.stringify(null)` is the string `"null"`, which a
   * `json` column stores as a JSON null value — indistinguishable to a reader
   * from a product that genuinely has no categories, and not what `IS NULL`
   * matches. M19.3's reconciliation and the picker both read this column.
   */
  it('stores an absent category list as SQL NULL, not a JSON null', async () => {
    const store = await connected();

    await push(store.token, {
      products: [product({ external_id: 'wc-8', categories: null, tags: null })],
    }).expect(200);

    const [row] = await dataSource.query(
      `SELECT categories IS NULL AS categoriesNull, tags IS NULL AS tagsNull
         FROM store_products WHERE storeId = ?`,
      [store.id],
    );

    expect(Number(row.categoriesNull)).toBe(1);
    expect(Number(row.tagsNull)).toBe(1);
  });

  it('accepts a null price for a product with no single price', async () => {
    const store = await connected();

    await push(store.token, {
      products: [product({ external_id: 'wc-3', type: 'variable', price_minor: null })],
    }).expect(200);

    const [row] = await productsFor(store.id);

    /*
     * ⚠️ Null, not zero. A variable product genuinely has no one price, and the
     * picker prints `—` for it; defaulting to 0 would show a free product.
     */
    expect(row.priceMinor).toBeNull();
  });

  // --- Idempotency ---------------------------------------------------------

  /**
   * The plugin retries a batch whose response was lost, and reconciliation
   * re-pushes rows it already sent. Neither may duplicate a product.
   */
  it('updates rather than duplicating on a re-push', async () => {
    const store = await connected();

    await push(store.token, { products: [product({ external_id: 'wc-4', name: 'First' })] });
    await push(store.token, { products: [product({ external_id: 'wc-4', name: 'Renamed' })] });

    const rows = await productsFor(store.id);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renamed');
  });

  /**
   * ⚠️ `syncedAt` records when the cloud last *heard about* a product, not when
   * the product changed. M19.3 reads it to find rows the store has stopped
   * mentioning, so an unchanged row must still have it refreshed — otherwise a
   * live product looks abandoned.
   */
  it('refreshes syncedAt even when nothing about the product changed', async () => {
    const store = await connected();
    const unchanged = product({ external_id: 'wc-5' });

    await push(store.token, { products: [unchanged] });
    const [before] = await productsFor(store.id);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await push(store.token, { products: [unchanged] });
    const [after] = await productsFor(store.id);

    expect(new Date(after.syncedAt as string).getTime()).toBeGreaterThan(
      new Date(before.syncedAt as string).getTime(),
    );
  });

  // --- Batching ------------------------------------------------------------

  it('accepts a full batch', async () => {
    const store = await connected();

    const products = Array.from({ length: MAX_PRODUCTS_PER_PUSH }, (_unused, index) =>
      product({ external_id: `bulk-${index}` }),
    );

    const response = await push(store.token, { products }).expect(200);

    expect(response.body.data.accepted).toBe(MAX_PRODUCTS_PER_PUSH);
    expect(await productsFor(store.id)).toHaveLength(MAX_PRODUCTS_PER_PUSH);
  });

  /*
   * The cap bounds the work one request can ask for. Without it a caller could
   * demand an unbounded transaction, and the array shape alone is valid.
   */
  /**
   * 🔴 **The cap and the body limit are two different bounds, and this proves
   * which one bites.** An audit found the cap's original justification wrong:
   * it put the worst-case product at ~1.8 kB, having forgotten that
   * `categories` and `tags` each allow 50 entries of 200 characters. The true
   * worst case is ~22 kB, so a *full* batch of maximal products is **5.26 MB**
   * — five times the limit.
   *
   * ⚠️ **The outcome must be a `413`, never a `500`.** That is the whole of
   * ADR-072: a 4xx tells the pusher to halve its batch and retry, while a 5xx
   * would tell it to retry the same oversized batch for ever. Worst case the
   * halving converges in three steps; a realistic store never retries, because
   * 50 *real* slugs make a ~2.3 kB product and 250 of those is 558 kB.
   */
  it('answers 413 when a full batch exceeds the body limit', async () => {
    const store = await connected();

    const maximal = Array.from({ length: MAX_PRODUCTS_PER_PUSH }, (_unused, index) =>
      product({
        external_id: `max-${index}`,
        name: 'x'.repeat(255),
        permalink: `https://example.com/${'x'.repeat(460)}`,
        image_url: `https://example.com/${'x'.repeat(460)}`,
        categories: Array.from({ length: 50 }, () => 'x'.repeat(200)),
        tags: Array.from({ length: 50 }, () => 'x'.repeat(200)),
      }),
    );

    await push(store.token, { products: maximal }).expect(413);

    /* Nothing written: the parser refused the body before any handler ran. */
    expect(await productsFor(store.id)).toHaveLength(0);
  });

  /**
   * The other side of the same boundary: a batch at the cap, with the taxonomy
   * sizes a real store produces, must be **accepted**. A cap that only ever
   * 413s would be a cap of zero.
   */
  it('accepts a full batch of realistically-sized products', async () => {
    const store = await connected();

    const realistic = Array.from({ length: MAX_PRODUCTS_PER_PUSH }, (_unused, index) =>
      product({
        external_id: `real-${index}`,
        categories: Array.from({ length: 50 }, (_c, n) => `winter-apparel-${n}`),
        tags: Array.from({ length: 50 }, (_t, n) => `bestseller-${n}`),
      }),
    );

    await push(store.token, { products: realistic }).expect(200);

    expect(await productsFor(store.id)).toHaveLength(MAX_PRODUCTS_PER_PUSH);
  });

  it('refuses a batch over the cap', async () => {
    const store = await connected();

    const products = Array.from({ length: MAX_PRODUCTS_PER_PUSH + 1 }, (_unused, index) =>
      product({ external_id: `over-${index}` }),
    );

    await push(store.token, { products }).expect(400);
    expect(await productsFor(store.id)).toHaveLength(0);
  });

  it('refuses an empty batch', async () => {
    const store = await connected();

    await push(store.token, { products: [] }).expect(400);
  });

  /**
   * 🔴 **A bad row must not cost the good ones their write — it must cost the
   * batch its acceptance.** The statement is one transaction, so a rejected
   * batch writes nothing and the plugin's cursor does not advance. Silently
   * writing 249 and dropping one would leave a gap nothing reports.
   */
  it('writes nothing when one product in the batch is invalid', async () => {
    const store = await connected();

    await push(store.token, {
      products: [
        product({ external_id: 'good-1' }),
        product({ external_id: 'bad-1', name: '' }),
        product({ external_id: 'good-2' }),
      ],
    }).expect(400);

    expect(await productsFor(store.id)).toHaveLength(0);
  });

  // --- Removal (M19.2) -----------------------------------------------------

  const remove = (token: string, externalId: string): request.Test =>
    request(app.getHttpServer())
      .delete(`/v1/store/products/${encodeURIComponent(externalId)}`)
      .set('Authorization', `Bearer ${token}`);

  it('removes a product from the mirror', async () => {
    const store = await connected();

    await push(store.token, { products: [product({ external_id: 'wc-del' })] }).expect(200);
    expect(await productsFor(store.id)).toHaveLength(1);

    const response = await remove(store.token, 'wc-del').expect(200);

    expect(response.body.data).toEqual({ removed: true });
    expect(await productsFor(store.id)).toHaveLength(0);
  });

  /**
   * ⚠️ **Not a 404.** The plugin queues a removal for a product that may never
   * have been pushed — deleted before the first walk reached it — and a 404
   * would make it retry a request whose desired end state already holds.
   */
  it('accepts removing a product that was never pushed', async () => {
    const store = await connected();

    const response = await remove(store.token, 'never-existed').expect(200);

    expect(response.body.data).toEqual({ removed: false });
  });

  /** The plugin's queue can deliver the same removal twice. */
  it('is idempotent', async () => {
    const store = await connected();

    await push(store.token, { products: [product({ external_id: 'wc-twice' })] });

    await remove(store.token, 'wc-twice').expect(200);
    const second = await remove(store.token, 'wc-twice').expect(200);

    expect(second.body.data).toEqual({ removed: false });
  });

  /**
   * 🔴 **A store must not be able to delete another's products.** The endpoint
   * takes only an external id, which two stores may legitimately share — so the
   * scope comes from the credential or it comes from nowhere.
   */
  it('removes only from the store the credential names', async () => {
    const mine = await connected('a');
    const theirs = await connected('b');

    await push(mine.token, { products: [product({ external_id: '55' })] });
    await push(theirs.token, { products: [product({ external_id: '55' })] });

    await remove(mine.token, '55').expect(200);

    expect(await productsFor(mine.id)).toHaveLength(0);
    expect(await productsFor(theirs.id)).toHaveLength(1);
  });

  it('refuses an unauthenticated removal', async () => {
    await request(app.getHttpServer()).delete('/v1/store/products/wc-1').expect(401);
  });

  /**
   * 📌 **A re-push after a removal restores the product.** Untrashing fires
   * `woocommerce_update_product`, which queues the product again — which is
   * what makes removal safe rather than lossy (ADR-074).
   */
  it('lets a removed product be pushed again', async () => {
    const store = await connected();

    await push(store.token, { products: [product({ external_id: 'wc-back', name: 'First' })] });
    await remove(store.token, 'wc-back');
    await push(store.token, { products: [product({ external_id: 'wc-back', name: 'Restored' })] });

    const [row] = await productsFor(store.id);

    expect(row.name).toBe('Restored');
  });

  // --- Reconciliation (M19.3) ----------------------------------------------

  const reconcile = (token: string, body: object): request.Test =>
    request(app.getHttpServer())
      .post('/v1/store/products/reconcile')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /** Seed the mirror with products `wc-1 … wc-n`, in ascending id order. */
  const seed = async (token: string, ids: string[]): Promise<void> => {
    await push(token, { products: ids.map((id) => product({ external_id: id })) }).expect(200);
  };

  /**
   * 🔴 **The defect this endpoint's contract exists to prevent.**
   *
   * If absence from a *page* meant "the store no longer has it", an ordinary
   * paged sweep would delete everything outside the page it is currently
   * sending. Modelled at scale: a mirror of 40,000 products and a page of 250
   * leaves **39,750 valid products deleted**.
   *
   * So a page that omits most of the mirror must remove **nothing**.
   */
  it('deletes nothing on a page that is not the final one', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1', 'wc-2', 'wc-3', 'wc-4']);

    const response = await reconcile(store.token, {
      external_ids: ['wc-1'],
      range_start: 'wc-1',
    }).expect(200);

    expect(response.body.data.removed).toBe(0);
    expect(await productsFor(store.id)).toHaveLength(4);
  });

  /** It still *reports* the drift, so the plugin can surface it before acting. */
  it('reports drift on a non-final page without acting on it', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1', 'wc-2', 'wc-3']);

    const response = await reconcile(store.token, {
      external_ids: ['wc-1', 'wc-3'],
      range_start: 'wc-1',
    }).expect(200);

    expect(response.body.data.stale).toBe(1);
    expect(response.body.data.removed).toBe(0);
  });

  it('removes rows the store no longer holds, on a final manifest', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1', 'wc-2', 'wc-3']);

    const response = await reconcile(store.token, {
      external_ids: ['wc-1', 'wc-3'],
      range_start: 'wc-1',
      is_final: true,
    }).expect(200);

    expect(response.body.data).toEqual({ checked: 2, stale: 1, removed: 1 });

    const remaining = (await productsFor(store.id)).map((row) => row.externalId);

    expect(remaining).toEqual(['wc-1', 'wc-3']);
  });

  /**
   * 🔴 **The range bounds the deletion, not just the final flag.** A manifest
   * that covered `wc-2 … wc-3` says nothing about `wc-1`, and deleting it would
   * be guessing at data the store never claimed either way.
   */
  it('never deletes outside the range the manifest covered', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1', 'wc-2', 'wc-3']);

    await reconcile(store.token, {
      external_ids: ['wc-2', 'wc-3'],
      range_start: 'wc-2',
      is_final: true,
    }).expect(200);

    expect((await productsFor(store.id)).map((row) => row.externalId)).toEqual([
      'wc-1',
      'wc-2',
      'wc-3',
    ]);
  });

  /**
   * 🔴 **The store's highest product must be reconcilable, and once it was
   * not.** An earlier draft derived the range ceiling from the page's own
   * highest id — so deleting `wc-9` from `wc-1…wc-9` produced a final manifest
   * of `wc-1…wc-8`, whose range stopped at `wc-8`. `wc-9` sat outside it and
   * survived **every** sweep, for ever.
   *
   * A final page means "this is the whole store from `range_start` upward", so
   * it is unbounded above.
   */
  it('removes the highest product when the store has dropped it', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1', 'wc-2', 'wc-9']);

    await reconcile(store.token, {
      external_ids: ['wc-1', 'wc-2'],
      range_start: 'wc-1',
      is_final: true,
    }).expect(200);

    expect((await productsFor(store.id)).map((row) => row.externalId)).toEqual(['wc-1', 'wc-2']);
  });

  /** A non-final page keeps its ceiling: everything above it is still coming. */
  it('does not reach past its own highest id on a non-final page', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1', 'wc-2', 'wc-9']);

    await reconcile(store.token, {
      external_ids: ['wc-1', 'wc-2'],
      range_start: 'wc-1',
    }).expect(200);

    expect(await productsFor(store.id)).toHaveLength(3);
  });

  /**
   * 🔴 **The manifest must be in STRING order, because `externalId` is
   * `varchar` and MySQL compares it as one.**
   *
   * The two orderings genuinely differ: numerically `2 < 9 < 10 < 100`, but as
   * strings `"10" < "100" < "2" < "9"`. A plugin paging numerically — which is
   * what `wc_get_products()` does with `orderby => ID` — would send
   * `range_start = "2"`, and rows `10` and `100` sort **below** it as strings,
   * falling outside every range and never being examined.
   *
   * 📌 **A leak, not a loss**: nothing is wrongly deleted, but a product
   * deleted upstream would survive every sweep. This pins the behaviour so the
   * plugin's ordering is a contract rather than a coincidence.
   */
  it('only examines rows inside the string-ordered range', async () => {
    const store = await connected();
    await seed(store.token, ['2', '9', '10', '100']);

    /* A numerically-ordered floor: everything below "2" as a string is unseen. */
    await reconcile(store.token, {
      external_ids: ['2', '9'],
      range_start: '2',
      is_final: true,
    }).expect(200);

    const remaining = (await productsFor(store.id)).map((row) => row.externalId).sort();

    expect(remaining).toEqual(['10', '100', '2', '9']);
  });

  /** In string order the same sweep reaches everything and removes correctly. */
  it('sweeps the whole catalogue when the manifest is string-ordered', async () => {
    const store = await connected();
    await seed(store.token, ['2', '9', '10', '100']);

    await reconcile(store.token, {
      external_ids: ['10', '100', '9'],
      range_start: '10',
      is_final: true,
    }).expect(200);

    const remaining = (await productsFor(store.id)).map((row) => row.externalId).sort();

    expect(remaining).toEqual(['10', '100', '9']);
  });

  it('removes nothing when the store and mirror agree', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1', 'wc-2']);

    const response = await reconcile(store.token, {
      external_ids: ['wc-1', 'wc-2'],
      range_start: 'wc-1',
      is_final: true,
    }).expect(200);

    expect(response.body.data).toEqual({ checked: 2, stale: 0, removed: 0 });
    expect(await productsFor(store.id)).toHaveLength(2);
  });

  /**
   * ⚠️ A product the store holds but the mirror does not is **not** an error
   * here. The cloud cannot create it from an id alone — the push does that.
   * Reconciliation's job in that direction is to be silent.
   */
  it('ignores ids the mirror has never seen', async () => {
    const store = await connected();
    await seed(store.token, ['wc-1']);

    const response = await reconcile(store.token, {
      external_ids: ['wc-1', 'wc-2', 'wc-3'],
      range_start: 'wc-1',
      is_final: true,
    }).expect(200);

    expect(response.body.data.removed).toBe(0);
    expect(await productsFor(store.id)).toHaveLength(1);
  });

  /**
   * 🔴 **A store must not reconcile another's catalogue.** The manifest carries
   * only external ids, which two stores may legitimately share.
   */
  it('reconciles only the store the credential names', async () => {
    const mine = await connected('a');
    const theirs = await connected('b');

    await seed(mine.token, ['shared-1', 'shared-2']);
    await seed(theirs.token, ['shared-1', 'shared-2']);

    /* Final, so unbounded above: the sweep claims `shared-1` is all there is. */
    await reconcile(mine.token, {
      external_ids: ['shared-1'],
      range_start: 'shared-1',
      is_final: true,
    }).expect(200);

    expect(await productsFor(mine.id)).toHaveLength(1);
    expect(await productsFor(theirs.id)).toHaveLength(2);
  });

  it('refuses an empty manifest', async () => {
    const store = await connected();

    await reconcile(store.token, { external_ids: [], is_final: true }).expect(400);
  });

  it('refuses an unauthenticated reconcile', async () => {
    await request(app.getHttpServer())
      .post('/v1/store/products/reconcile')
      .send({ external_ids: ['wc-1'] })
      .expect(401);
  });

  // --- Isolation -----------------------------------------------------------

  /**
   * 🔴 **`storeId` comes from the credential, never from the body.** A store
   * that could name another's id would rewrite its catalogue — the whole of AC8
   * in one field.
   */
  it('ignores a storeId in the body', async () => {
    const mine = await connected('a');
    const theirs = await connected('b');

    /* `forbidNonWhitelisted` rejects the unknown field outright. */
    await push(mine.token, {
      storeId: theirs.id,
      products: [product({ external_id: 'wc-6' })],
    }).expect(400);

    expect(await productsFor(theirs.id)).toHaveLength(0);
  });

  it('writes to the store the credential names', async () => {
    const mine = await connected('a');
    const theirs = await connected('b');

    await push(mine.token, { products: [product({ external_id: 'wc-7' })] }).expect(200);

    expect(await productsFor(mine.id)).toHaveLength(1);
    expect(await productsFor(theirs.id)).toHaveLength(0);
  });

  it('refuses an unauthenticated push', async () => {
    await request(app.getHttpServer())
      .post('/v1/store/products')
      .send({ products: [product()] })
      .expect(401);
  });

  /**
   * Two stores may legitimately use the same WooCommerce id: the mirror is
   * keyed `(storeId, externalId)`, not by `externalId` alone.
   */
  it('keeps two stores that share an external id apart', async () => {
    const mine = await connected('a');
    const theirs = await connected('b');

    await push(mine.token, { products: [product({ external_id: '20', name: 'Mine' })] });
    await push(theirs.token, { products: [product({ external_id: '20', name: 'Theirs' })] });

    const [myRow] = await productsFor(mine.id);
    const [theirRow] = await productsFor(theirs.id);

    expect(myRow.name).toBe('Mine');
    expect(theirRow.name).toBe('Theirs');
  });
});
