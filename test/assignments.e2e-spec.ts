import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { generateStoreToken } from '../src/common/crypto/tokens';
import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * Which products an option set applies to (M13.6, Phase 13 Stage 0).
 *
 * **The first place in the product that creates a `MANUAL` assignment.** Until
 * now the only source was `demo.seed.ts`, which is why Phase 10's renderer had
 * nothing real to resolve.
 */
describe('assignments (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;
  let token = '';
  let storeId = '';
  let setId = '';

  const NS = 'assign13';

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness(NS);
    dataSource = app.get(DataSource);

    await harness.cleanup();
    token = await harness.tenant('a');
    storeId = await harness.store('a');

    await seedProducts(['wc-1', 'wc-2', 'wc-3']);
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  beforeEach(async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/option-sets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `${NS}-${Math.random().toString(36).slice(2, 8)}`, storeId });

    expect(created.status).toBe(201);
    setId = created.body.data.id as string;
  });

  async function seedProducts(externalIds: string[]): Promise<void> {
    for (const externalId of externalIds) {
      await dataSource.query(
        `INSERT INTO store_products
           (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt)
         VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, 'simple', 'publish', NOW(3))
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [storeId, externalId, `Product ${externalId}`],
      );
    }
  }

  const assign = (ids: string[], set = setId): request.Test =>
    request(app.getHttpServer())
      .post(`/v1/option-sets/${set}/assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ externalProductIds: ids });

  const unassign = (externalId: string, set = setId): request.Test =>
    request(app.getHttpServer())
      .delete(`/v1/option-sets/${set}/assignments/${externalId}`)
      .set('Authorization', `Bearer ${token}`);

  const listAssignments = (set = setId): request.Test =>
    request(app.getHttpServer())
      .get(`/v1/option-sets/${set}/assignments`)
      .set('Authorization', `Bearer ${token}`);

  const storeVersion = async (): Promise<number> => {
    const [row] = await dataSource.query(`SELECT configVersion FROM stores WHERE id = ?`, [storeId]);

    return Number(row.configVersion);
  };

  // --- Writing -------------------------------------------------------------

  /**
   * 🔴 **`mode` and `targetType` are written explicitly, never defaulted.**
   *
   * The storefront skips an assignment whose mode it does not recognise and
   * counts it as deferred, so a wrong value produces an option that **never
   * renders**, with a skip counter as the only trace. Asserted against the
   * stored row rather than the response, because the row is what the config
   * document reads.
   */
  it('writes mode=manual and targetType=product', async () => {
    await assign(['wc-1']).expect(200);

    const [row] = await dataSource.query(
      `SELECT mode, targetType, targetRef FROM option_set_assignments
        WHERE optionSetId = ? AND deletedAt = '1970-01-01 00:00:00.000'`,
      [setId],
    );

    expect(row.mode).toBe('manual');
    expect(row.targetType).toBe('product');
    expect(row.targetRef).toBe('wc-1');
  });

  it('assigns several products at once', async () => {
    const response = await assign(['wc-1', 'wc-2', 'wc-3']).expect(200);

    expect(response.body.data.assignments).toHaveLength(3);
  });

  /**
   * **Every write advances the store's revision.**
   *
   * Assignments are a live read in the storefront document, so a write that did
   * not bump would leave every connected plugin serving a document it believes
   * is current — the option appearing only after some later, unrelated publish.
   */
  it('advances configVersion on assign', async () => {
    const before = await storeVersion();
    const response = await assign(['wc-1']).expect(200);

    const after = await storeVersion();
    expect(after).toBeGreaterThan(before);
    expect(response.body.data.configVersion).toBe(after);
  });

  it('advances configVersion on unassign', async () => {
    await assign(['wc-1']).expect(200);
    const before = await storeVersion();

    await unassign('wc-1').expect(200);

    expect(await storeVersion()).toBeGreaterThan(before);
  });

  // --- Naming the product (M13.6) ------------------------------------------

  /**
   * 🔴 **The picker must show a name, not a WooCommerce id.**
   *
   * `targetRef` is `wc-1`; a merchant expects "Product wc-1". It cannot be
   * resolved client-side — `GET /products` has no id filter, so naming N
   * assignments would mean paging the whole catalogue or making N searches.
   */
  it('names the product each assignment targets', async () => {
    const response = await assign(['wc-1']).expect(200);

    expect(response.body.data.assignments[0].productName).toBe('Product wc-1');
    expect(response.body.data.assignments[0].productStatus).toBe('publish');
  });

  /**
   * The write answers with names too, not only the reload.
   *
   * A picker showing "Product wc-1" after a refresh and `wc-1` immediately after
   * assigning would look broken at the one moment a merchant is watching.
   */
  it('names the product on the read as well as the write', async () => {
    await assign(['wc-1']).expect(200);

    const listed = await listAssignments().expect(200);

    expect(listed.body.data[0].productName).toBe('Product wc-1');
  });

  /**
   * 🔴 **A product deleted upstream is still listed, unnamed.**
   *
   * The join is a `LEFT JOIN` precisely for this: an inner one would hide the
   * rows that need attention. A merchant reading "assigned to 4 products"
   * deserves to know one of them no longer exists — otherwise the option quietly
   * stops appearing while the list still says it should.
   */
  it('lists an assignment whose product has gone, with a null name', async () => {
    await assign(['wc-1']).expect(200);

    await dataSource.query(`DELETE FROM store_products WHERE storeId = ? AND externalId = ?`, [
      storeId,
      'wc-1',
    ]);

    const listed = await listAssignments().expect(200);

    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].targetRef).toBe('wc-1');
    expect(listed.body.data[0].productName).toBeNull();
    expect(listed.body.data[0].productStatus).toBeNull();

    // Restore it for the tests that follow.
    await dataSource.query(
      `INSERT INTO store_products
         (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt)
       VALUES (UUID(), NOW(3), NOW(3), ?, 'wc-1', 'Product wc-1', 'simple', 'publish', NOW(3))`,
      [storeId],
    );
  });

  /**
   * ⚠️ **The join is scoped by store, not by `targetRef` alone.**
   *
   * WooCommerce numbers products from 1 on every install, so two shops routinely
   * share ids. Joining on `externalId` alone would name a product from the wrong
   * store — a merchant seeing another shop's product name on their own
   * assignment.
   */
  it('does not name a product from a different store sharing the id', async () => {
    const otherStore = await harness.store('a');

    await dataSource.query(
      `INSERT INTO store_products
         (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt)
       VALUES (UUID(), NOW(3), NOW(3), ?, 'wc-shared', 'Other store product', 'simple', 'publish', NOW(3))`,
      [otherStore],
    );

    await dataSource.query(
      `INSERT INTO store_products
         (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt)
       VALUES (UUID(), NOW(3), NOW(3), ?, 'wc-shared', 'Mine', 'simple', 'publish', NOW(3))`,
      [storeId],
    );

    const response = await assign(['wc-shared']).expect(200);

    /*
     * The row **count** is the assertion that bites, not just the name.
     *
     * Without the `storeId` predicate the join matches both stores' rows, so one
     * assignment comes back **twice** — a duplicate in the picker, and whichever
     * name MySQL happens to order first. Checking `[0].productName` alone passes
     * on luck; measured, the mutant survived that check.
     */
    const forShared = (response.body.data.assignments as Array<{ targetRef: string; productName: string }>)
      .filter((a) => a.targetRef === 'wc-shared');

    expect(forShared).toHaveLength(1);
    expect(forShared[0].productName).toBe('Mine');
  });

  // --- Idempotency ---------------------------------------------------------

  /**
   * **A double submit is ordinary in a picker**, and must not become a
   * constraint violation the merchant did not cause.
   *
   * `uq_assignments_set_target` remains the guarantee; this is the path that
   * makes it invisible.
   */
  it('assigning the same product twice creates one row', async () => {
    await assign(['wc-1']).expect(200);
    const second = await assign(['wc-1']).expect(200);

    expect(second.body.data.assignments).toHaveLength(1);
  });

  it('a partially-new request assigns only what is missing', async () => {
    await assign(['wc-1']).expect(200);
    const response = await assign(['wc-1', 'wc-2']).expect(200);

    expect(response.body.data.assignments).toHaveLength(2);
  });

  /**
   * 🔴 **Concurrent assigns of the same product all succeed.**
   *
   * A picker's double-click, and the case a `SELECT`-then-`INSERT` cannot
   * handle: both requests find the product missing, both insert, and
   * `uq_assignments_set_target` turns the loser into a **409 the merchant did
   * not cause**. Measured on the first implementation — `[200, 409, 409]`.
   *
   * The upsert makes the database resolve it. The row count matters as much as
   * the statuses: three successes that produced three rows would mean the
   * unique index had stopped working.
   */
  it('concurrent assigns of the same product all succeed', async () => {
    const call = (): request.Test => assign(['wc-1']);

    const results = await Promise.all([call(), call(), call()]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);

    const [row] = await dataSource.query(
      `SELECT COUNT(*) n FROM option_set_assignments
        WHERE optionSetId = ? AND deletedAt = '1970-01-01 00:00:00.000'`,
      [setId],
    );

    expect(Number(row.n)).toBe(1);
  });

  it('a repeated product id in one request is de-duplicated', async () => {
    const response = await assign(['wc-1', 'wc-1']).expect(200);

    expect(response.body.data.assignments).toHaveLength(1);
  });

  // --- Unassigning ---------------------------------------------------------

  /**
   * A soft delete: the storefront filters on the live sentinel, so the
   * assignment stops applying the moment this commits.
   */
  it('unassigning removes it from the live list', async () => {
    await assign(['wc-1', 'wc-2']).expect(200);
    const response = await unassign('wc-1').expect(200);

    expect(response.body.data.assignments).toHaveLength(1);
    expect(response.body.data.assignments[0].targetRef).toBe('wc-2');
  });

  /**
   * **Re-assigning after unassigning must work.**
   *
   * `deletedAt` is part of the unique key precisely so a tombstone does not
   * block this — the case that would have failed had the key been three columns.
   */
  it('a product can be re-assigned after being unassigned', async () => {
    await assign(['wc-1']).expect(200);
    await unassign('wc-1').expect(200);

    const response = await assign(['wc-1']).expect(200);
    expect(response.body.data.assignments).toHaveLength(1);
  });

  it('unassigning something not assigned is a 404', async () => {
    await unassign('wc-3').expect(404);
  });

  /**
   * 🔴 **Unassigning twice is a 404, not a second success.**
   *
   * The case the previous test cannot reach: it uses a product that was never
   * assigned, so no tombstone exists to match. Here one does — and an `UPDATE`
   * that did not filter on the live sentinel would find the soft-deleted row,
   * report one affected row, bump `configVersion` and answer `200` for work it
   * did not do.
   *
   * Found by mutation: relaxing the `deletedAt` filter passed all sixteen tests.
   */
  it('unassigning twice is a 404 the second time', async () => {
    await assign(['wc-1']).expect(200);
    await unassign('wc-1').expect(200);

    const before = await storeVersion();

    await unassign('wc-1').expect(404);

    expect(await storeVersion()).toBe(before);
  });

  // --- Ownership (finding A3) ----------------------------------------------

  /**
   * 🔴 **A product must exist in this set's own store.**
   *
   * `targetRef` holds a WooCommerce id and has no foreign key — the product
   * lives on the merchant's site, not here — so nothing in the schema stops a
   * set being assigned to a product belonging to another store. Stored,
   * accepted, and silently never rendering.
   */
  it('refuses a product that is not in the set’s store', async () => {
    await assign(['wc-does-not-exist']).expect(400);

    expect((await listAssignments().expect(200)).body.data).toEqual([]);
  });

  /**
   * 🔴 **The same tenant's *other* store is refused too.**
   *
   * The half of A3 the cross-tenant probe cannot reach: an agency running two
   * shops is one tenant, so tenant scoping alone permits this. The check is on
   * `set.storeId`, not on the tenant — and the failure it prevents is silent,
   * because the plugin would index by a product id that does not exist on the
   * site serving that set.
   *
   * Recorded as a gap by the Stage 0 audit: both suites created one store, so
   * only the cross-tenant case was proven.
   */
  it('refuses a product from another store owned by the same tenant', async () => {
    const otherStore = await harness.store('a');

    await dataSource.query(
      `INSERT INTO store_products
         (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt)
       VALUES (UUID(), NOW(3), NOW(3), ?, 'wc-other', 'Other store product', 'simple', 'publish', NOW(3))`,
      [otherStore],
    );

    await assign(['wc-other']).expect(400);

    expect((await listAssignments().expect(200)).body.data).toEqual([]);
  });

  it('refuses the whole request when one product is unknown', async () => {
    await assign(['wc-1', 'wc-nope']).expect(400);

    expect((await listAssignments().expect(200)).body.data).toEqual([]);
  });

  // --- Validation ----------------------------------------------------------

  it('refuses an empty product list', async () => {
    await assign([]).expect(400);
  });

  it('refuses an unknown option set', async () => {
    await assign(['wc-1'], '00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('refuses an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .post(`/v1/option-sets/${setId}/assignments`)
      .send({ externalProductIds: ['wc-1'] })
      .expect(401);
  });

  it('lists nothing for a set with no assignments', async () => {
    expect((await listAssignments().expect(200)).body.data).toEqual([]);
  });

  // --- The whole point of Stage 0 -----------------------------------------

  /**
   * 🔴 **An assignment made here reaches the storefront document.**
   *
   * Everything above proves this endpoint is internally consistent. None of it
   * proves the **plugin** can use what it writes — and that is the only reason
   * Stage 0 exists: until now the sole source of a `MANUAL` assignment was
   * `demo.seed.ts`, so Phase 10's renderer had nothing real to resolve.
   *
   * The shape asserted is the one `Config\ProductIndex` requires. It reads
   * `mode`, and treats anything that is neither `all` nor `manual` as deferred —
   * **skipping the assignment entirely** and counting it, so a wrong value
   * produces an option that never renders with a skip counter as the only trace.
   * `target_type` must be `product` and `target_ref` the WooCommerce id, because
   * the plugin indexes by exactly those.
   *
   * Verified by hand during the Stage 0 audit and made permanent here: a
   * hand-run check is one nobody repeats.
   */
  it('an assignment reaches the storefront config document', async () => {
    const credential = generateStoreToken();

    await dataSource.query(
      `INSERT INTO store_credentials
         (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
       VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
      [storeId, credential.hash, credential.prefix],
    );

    const auth = { Authorization: `Bearer ${token}` };

    // A set with something to publish: an empty one is refused, correctly.
    const group = await request(app.getHttpServer())
      .post(`/v1/option-sets/${setId}/groups`)
      .set(auth)
      .send({ label: 'Finish' });
    const option = await request(app.getHttpServer())
      .post(`/v1/groups/${group.body.data.id}/options`)
      .set(auth)
      .send({ key: 'finish', label: 'Finish', presentation: 'radio' });
    await request(app.getHttpServer())
      .post(`/v1/options/${option.body.data.id}/values`)
      .set(auth)
      .send({ valueKey: 'lux', label: 'Luxury' });

    await assign(['wc-1']).expect(200);

    await request(app.getHttpServer())
      .post(`/v1/option-sets/${setId}/publish`)
      .set(auth)
      .send({})
      .expect(201);

    const document = await request(app.getHttpServer())
      .get('/v1/store/config')
      .set('Authorization', `Bearer ${credential.plaintext}`)
      .expect(200);

    const published = (document.body.data.option_sets as Array<{
      assignments: Array<{ mode: string; target_type: string; target_ref: string }>;
    }>).find((set) => set.assignments.length > 0);

    expect(published).toBeDefined();
    expect(published?.assignments).toEqual([
      { mode: 'manual', target_type: 'product', target_ref: 'wc-1', priority: 0 },
    ]);
  });
});
