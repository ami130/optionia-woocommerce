import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * The catalogue picker's API (M13.6, Phase 13 Stage 0).
 *
 * Read-only: `store_products` mirrors the merchant's WooCommerce store and is
 * written by M19's sync, never from the dashboard.
 */
describe('products (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;
  let token = '';
  let storeId = '';

  const NS = 'prod13';

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness(NS);
    dataSource = app.get(DataSource);

    await harness.cleanup();
    token = await harness.tenant('a');
    storeId = await harness.store('a');

    await seed([
      'Apron',
      'Bundle: two shirts',
      'Custom Hoodie',
      'Custom Hoodie',
      'Gift wrap 100%',
      'Zebra Socks',
    ]);
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  async function seed(names: string[]): Promise<void> {
    for (const [index, name] of names.entries()) {
      await dataSource.query(
        `INSERT INTO store_products
           (id, createdAt, updatedAt, storeId, externalId, name, sku, type,
            priceMinor, status, syncedAt)
         VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, ?, 'simple', 1000, 'publish', NOW(3))`,
        [storeId, `wc-${index}`, name, `SKU-${index}`],
      );
    }
  }

  const list = (query = ''): request.Test =>
    request(app.getHttpServer())
      .get(`/v1/products?storeId=${storeId}${query}`)
      .set('Authorization', `Bearer ${token}`);

  const namesOf = (body: { data: Array<{ name: string }> }): string[] =>
    body.data.map((row) => row.name);

  // --- Listing -------------------------------------------------------------

  it('returns the store’s catalogue, ordered by name', async () => {
    const response = await list().expect(200);

    expect(namesOf(response.body)).toEqual([
      'Apron',
      'Bundle: two shirts',
      'Custom Hoodie',
      'Custom Hoodie',
      'Gift wrap 100%',
      'Zebra Socks',
    ]);
  });

  /**
   * The picker needs an id it can put in an assignment's `targetRef`, and that
   * is WooCommerce's id — not ours.
   */
  it('exposes the external id an assignment will store', async () => {
    const response = await list().expect(200);

    expect(response.body.data[0].externalId).toMatch(/^wc-\d+$/);
  });

  /** Sync bookkeeping is not the picker's business. */
  it('returns an explicit field list, not the row', async () => {
    const [product] = (await list().expect(200)).body.data;

    expect(Object.keys(product).sort()).toEqual([
      'externalId',
      'id',
      'imageUrl',
      'name',
      'permalink',
      'priceMinor',
      'sku',
      'status',
      'type',
    ]);
  });

  // --- Search --------------------------------------------------------------

  it('matches a name prefix', async () => {
    const response = await list('&search=Custom').expect(200);

    expect(namesOf(response.body)).toEqual(['Custom Hoodie', 'Custom Hoodie']);
  });

  /**
   * **`%` is a character a merchant typed, not a wildcard.**
   *
   * Unescaped, a search for `100%` matches the whole catalogue — the picker
   * would appear to ignore what was typed.
   */
  it('treats a percent sign as text', async () => {
    const response = await list('&search=Gift wrap 100%25').expect(200);

    expect(namesOf(response.body)).toEqual(['Gift wrap 100%']);
  });

  it('treats an underscore as text', async () => {
    const response = await list('&search=Apro_').expect(200);

    expect(response.body.data).toEqual([]);
  });

  it('returns an empty page rather than an error when nothing matches', async () => {
    const response = await list('&search=NothingLikeThis').expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.meta.pagination.hasMore).toBe(false);
    expect(response.body.meta.pagination.cursor).toBeNull();
  });

  // --- Paging --------------------------------------------------------------

  /**
   * The whole catalogue, walked one page at a time.
   *
   * Two products share the name `Custom Hoodie`, so this also proves the `id`
   * tie-break: a keyset on `name` alone would loop forever on the duplicate.
   */
  it('pages through the catalogue without repeating or skipping', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page++) {
      const query: string = `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await list(query).expect(200);

      seen.push(...namesOf(response.body));
      cursor = response.body.meta.pagination.cursor as string | null;

      if (!cursor) {
        break;
      }
    }

    expect(seen).toEqual([
      'Apron',
      'Bundle: two shirts',
      'Custom Hoodie',
      'Custom Hoodie',
      'Gift wrap 100%',
      'Zebra Socks',
    ]);
  });

  /**
   * 🔴 **A page boundary falling *between* two identical names.**
   *
   * The `id` tie-break decides exactly one case, and `limit=2` never reaches it:
   * with six products the duplicate pair sits wholly inside page two, so a
   * keyset on `name` alone paged correctly and the mutant survived. `limit=1`
   * walks every boundary, including the one between the two `Custom Hoodie`
   * rows — where a name-only cursor asks for `name > 'Custom Hoodie'` and skips
   * the second copy.
   */
  it('does not skip a duplicate name across a page boundary', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page++) {
      const query: string = `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await list(query).expect(200);

      seen.push(...namesOf(response.body));
      cursor = response.body.meta.pagination.cursor as string | null;

      if (!cursor) {
        break;
      }
    }

    expect(seen).toEqual([
      'Apron',
      'Bundle: two shirts',
      'Custom Hoodie',
      'Custom Hoodie',
      'Gift wrap 100%',
      'Zebra Socks',
    ]);
  });

  it('reports no cursor on the last page', async () => {
    const response = await list('&limit=100').expect(200);

    expect(response.body.meta.pagination.hasMore).toBe(false);
    expect(response.body.meta.pagination.cursor).toBeNull();
  });

  /**
   * A mangled cursor is **loud**.
   *
   * Treating it as "no cursor" returns page one with a 200, which a client
   * cannot distinguish from a genuine first page — so a paging loop restarts
   * forever, re-processing the same rows.
   */
  it('refuses a malformed cursor', async () => {
    await list('&cursor=not-a-real-cursor').expect(400);
  });

  // --- Validation ----------------------------------------------------------

  it('requires a store id', async () => {
    await request(app.getHttpServer())
      .get('/v1/products')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('refuses a store id that is not a uuid', async () => {
    await request(app.getHttpServer())
      .get('/v1/products?storeId=nonsense')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('refuses an unreasonable page size', async () => {
    await list('&limit=5000').expect(400);
  });

  it('refuses an unauthenticated request', async () => {
    await request(app.getHttpServer()).get(`/v1/products?storeId=${storeId}`).expect(401);
  });
});
