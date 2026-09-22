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

  const unassignMany = (
    targets: Array<{ targetType: string; targetRef: string }>,
    set = setId,
  ): request.Test =>
    request(app.getHttpServer())
      .post(`/v1/option-sets/${set}/assignments/unassign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targets });

  const preview = (targetType: string, targetRef: string, set = setId): request.Test =>
    request(app.getHttpServer())
      .get(`/v1/option-sets/${set}/assignments/preview`)
      .query({ targetType, targetRef })
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

  /**
   * The same journey for a **category** (M19.1' step 4).
   *
   * 🔴 **This is the gap the stage actually had.** The publish path was already
   * target-type agnostic — `ConfigDocumentBuilder` joins assignments live and
   * maps `target_type`/`target_ref` from whatever the row holds, and
   * `config-delivery.e2e-spec.ts` already published a category — but that test
   * inserts through the repository, bypassing the API. Nothing proved a
   * non-product assignment **authored through the API** reaches the document,
   * which is precisely the path M19.1' opened.
   *
   * ⚠️ **No `store_products` row is seeded, deliberately.** The A3 existence
   * check is product-only: a category is not a row in this database, and
   * requiring a member would reject the configuration a merchant makes when
   * they assign to "Summer" before stocking it.
   *
   * 📌 **The plugin still skips this**, and that is correct, not a failure.
   * `Config\ProductIndex` indexes `manual` + `product` and counts everything
   * else in `skipped_count()`. Resolution is M19.4 (ADR-068); this stage makes
   * the assignment *authorable and published*, so the counter finally has
   * something real to count.
   */
  it('a category assignment authored through the API reaches the document', async () => {
    const credential = generateStoreToken();

    await dataSource.query(
      `INSERT INTO store_credentials
         (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
       VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
      [storeId, credential.hash, credential.prefix],
    );

    const auth = { Authorization: `Bearer ${token}` };

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

    await request(app.getHttpServer())
      .post(`/v1/option-sets/${setId}/assignments`)
      .set(auth)
      .send({ targets: [{ targetType: 'category', targetRef: 'summer' }] })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/option-sets/${setId}/publish`)
      .set(auth)
      .send({})
      .expect(201);

    const document = await request(app.getHttpServer())
      .get('/v1/store/config')
      .set('Authorization', `Bearer ${credential.plaintext}`)
      .expect(200);

    /*
     * ⚠️ **Found by id, not by "the first set with assignments".** The store is
     * shared across this suite, so the neighbouring test's product set is also
     * in the document — selecting by shape picked that one up and the assertion
     * compared the wrong set.
     */
    const published = (document.body.data.option_sets as Array<{
      id: string;
      assignments: Array<{ mode: string; target_type: string; target_ref: string }>;
    }>).find((set) => set.id === setId);

    expect(published).toBeDefined();
    expect(published?.assignments).toEqual([
      { mode: 'manual', target_type: 'category', target_ref: 'summer', priority: 0 },
    ]);
  });

  // --- Bulk unassign (M19.5) ----------------------------------------------

  it('removes several targets in one request', async () => {
    await assign(['wc-1', 'wc-2', 'wc-3']).expect(200);

    const response = await unassignMany([
      { targetType: 'product', targetRef: 'wc-1' },
      { targetType: 'product', targetRef: 'wc-3' },
    ]).expect(200);

    expect(response.body.data.removed).toBe(2);

    const remaining = (response.body.data.assignments as Array<{ targetRef: string }>).map(
      (row) => row.targetRef,
    );

    expect(remaining).toEqual(['wc-2']);
  });

  /**
   * 🔴 **A stale selection is not an error**, and this is the assertion that
   * says so. The single unassign answers `404` for a target that is not
   * assigned — right for one named thing, wrong for a selection, which goes
   * stale whenever another session removes a row or a merchant re-clicks a
   * slow request. Failing wholesale would leave every other row assigned and
   * say nothing about which.
   */
  it('ignores targets that are already gone, and reports how many it removed', async () => {
    await assign(['wc-1']).expect(200);

    const response = await unassignMany([
      { targetType: 'product', targetRef: 'wc-1' },
      { targetType: 'product', targetRef: 'wc-2' },
    ]).expect(200);

    expect(response.body.data.removed).toBe(1);
    expect(response.body.data.assignments).toEqual([]);
  });

  /**
   * 🔴 **The PAIR addresses the row, not the reference.**
   *
   * `targetRef` is unique only within a type, so a category and a product may
   * share one. Removing the category must leave the product assigned —
   * matching on the reference alone once deleted the wrong row, which is why
   * the single unassign takes a type at all.
   */
  it('removes only the target type asked for when a ref is shared', async () => {
    await assign(['wc-1']).expect(200);

    await request(app.getHttpServer())
      .post(`/v1/option-sets/${setId}/assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targets: [{ targetType: 'category', targetRef: 'wc-1' }] })
      .expect(200);

    const response = await unassignMany([
      { targetType: 'category', targetRef: 'wc-1' },
    ]).expect(200);

    expect(response.body.data.removed).toBe(1);
    expect(response.body.data.assignments).toEqual([
      expect.objectContaining({ targetType: 'product', targetRef: 'wc-1' }),
    ]);
  });

  it('advances configVersion on a bulk unassign', async () => {
    await assign(['wc-1']).expect(200);

    const before = await storeVersion();

    await unassignMany([{ targetType: 'product', targetRef: 'wc-1' }]).expect(200);

    expect(await storeVersion()).toBeGreaterThan(before);
  });

  it('refuses an empty bulk unassign', async () => {
    await unassignMany([]).expect(400);
  });

  it('a repeated pair in one bulk unassign is de-duplicated', async () => {
    await assign(['wc-1']).expect(200);

    const response = await unassignMany([
      { targetType: 'product', targetRef: 'wc-1' },
      { targetType: 'product', targetRef: 'wc-1' },
    ]).expect(200);

    /* One row existed, so one row was removed — not two. */
    expect(response.body.data.removed).toBe(1);
  });

  // --- Counts before applying (M19.5) -------------------------------------

  /**
   * ⚠️ **A taxonomy count is an ESTIMATE, and the flag says so.** The mirror is
   * a snapshot; the storefront resolves `has_term()` live (ADR-068), so a
   * product categorised after this count still matches. `exact: false` is what
   * stops the number being presented as a promise.
   */
  it('counts the mirrored products in a category, inexactly', async () => {
    await dataSource.query(
      `UPDATE store_products SET categories = JSON_ARRAY('summer')
        WHERE storeId = ? AND externalId IN ('wc-1', 'wc-2')`,
      [storeId],
    );

    const response = await preview('category', 'summer').expect(200);

    expect(response.body.data).toEqual({ matched: 2, exact: false });
  });

  it('counts a tag from its own column', async () => {
    await dataSource.query(
      `UPDATE store_products SET tags = JSON_ARRAY('personalised')
        WHERE storeId = ? AND externalId = 'wc-3'`,
      [storeId],
    );

    const response = await preview('tag', 'personalised').expect(200);

    expect(response.body.data).toEqual({ matched: 1, exact: false });
  });

  /**
   * A category nothing is in counts zero rather than failing: assigning a set
   * to a term before stocking it is a plan, not a mistake (M19.1').
   */
  it('counts zero for a category no product is in', async () => {
    const response = await preview('category', 'nothing-is-here').expect(200);

    expect(response.body.data).toEqual({ matched: 0, exact: false });
  });

  /**
   * 🔴 **A product target is EXACT — it names one thing.** Reporting
   * `exact: false` for it would tell a merchant their own explicit choice was
   * a guess.
   */
  it('reports a known product as an exact single match', async () => {
    const response = await preview('product', 'wc-1').expect(200);

    expect(response.body.data).toEqual({ matched: 1, exact: true });
  });

  it('reports a product that is not in the store as no match', async () => {
    const response = await preview('product', 'wc-absent').expect(200);

    expect(response.body.data).toEqual({ matched: 0, exact: true });
  });

  /**
   * `attribute` and `price_range` have no defined reference format (ADR-076),
   * so there is nothing to count. `null` is the absence of a measurement;
   * reporting `0` would be a measurement, and a wrong one.
   */
  it('reports an uncountable target type as unknown rather than zero', async () => {
    const response = await preview('attribute', 'colour:red').expect(200);

    expect(response.body.data).toEqual({ matched: null, exact: false });
  });

  it('refuses a preview with no targetRef', async () => {
    await request(app.getHttpServer())
      .get(`/v1/option-sets/${setId}/assignments/preview`)
      .query({ targetType: 'category' })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('refuses a preview with an unknown target type', async () => {
    await preview('nonsense', 'summer').expect(400);
  });

  /**
   * 🔴 **Scoped to the set's own store, and this is the only test that says
   * so.** `externalId` is unique only within a store — WooCommerce numbers from
   * 1 on every install — so an unscoped count reports another merchant's
   * catalogue as though it were this one's. Measured while writing this: with
   * the `storeId` filter removed, the category count rose from 2 to 3.
   */
  it('counts only the set’s own store', async () => {
    await dataSource.query(
      `UPDATE store_products SET categories = JSON_ARRAY('summer')
        WHERE storeId = ? AND externalId IN ('wc-1', 'wc-2')`,
      [storeId],
    );

    /*
     * A second store for the same tenant — `harness.store('a')` creates one
     * rather than returning the first, which is how the cross-store join test
     * above gets its other store. A second *tenant* would need `tenant('b')`
     * and prove a weaker thing: tenant isolation is already enforced a layer
     * up, and the bug this guards against is two stores of one merchant.
     */
    const otherStore = await harness.store('a');

    await dataSource.query(
      `INSERT INTO store_products
         (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt, categories)
       VALUES (UUID(), NOW(3), NOW(3), ?, 'wc-9', 'Other store product', 'simple', 'publish',
               NOW(3), JSON_ARRAY('summer'))
       ON DUPLICATE KEY UPDATE categories = VALUES(categories)`,
      [otherStore],
    );

    const response = await preview('category', 'summer').expect(200);

    /* The other store's product is in `summer` too, and must not be counted. */
    expect(response.body.data.matched).toBe(2);
  });
});
