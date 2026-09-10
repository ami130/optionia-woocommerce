import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';

import { createHarness, idOf, type Harness } from './harness';

/**
 * The tenant isolation matrix (M6.6, extended by 7n to every Phase 7 endpoint).
 *
 * **This suite is permanent and runs in CI forever.**
 *
 * ## Why it exists when other suites already test isolation
 *
 * They do — twelve files contain a cross-tenant assertion. That is exactly the
 * problem: no single place could answer *"is every route covered?"*, and a route
 * added without a negative test would join a green suite unnoticed.
 *
 * So this enumerates the routes from the **router itself**, drives every one of
 * them as tenant B against tenant A's data, and asserts the answer. A new
 * tenant-scoped endpoint fails here until someone adds it to the matrix — which
 * is the property M6.6 asks for and no scattered assertion can provide.
 *
 * ## Why 404 and not 403
 *
 * A 403 confirms the resource exists. Walking ids and reading the status would
 * then enumerate another tenant's data without ever seeing it (ADR-010).
 */
describe('tenant isolation matrix (e2e)', () => {
  let harness: Harness;

  const NS = 'matrix';

  /** Tenant A owns everything below; tenant B is the intruder. */
  let tokenA = '';
  let tokenB = '';
  let storeA = '';

  const owned = {
    set: '',
    group: '',
    option: '',
    value: '',
    item: '',
  };

  beforeAll(async () => {
    harness = await createHarness(NS);
    await harness.cleanup();

    tokenA = await harness.tenant('a');
    tokenB = await harness.tenant('b');
    storeA = await harness.store('a');

    owned.set = idOf(await post(tokenA, '/option-sets', { name: 'A', storeId: storeA }), 'set');
    owned.group = idOf(
      await post(tokenA, `/option-sets/${owned.set}/groups`, { label: 'A group' }),
      'group',
    );
    owned.option = idOf(
      await post(tokenA, `/groups/${owned.group}/options`, {
        key: 'a_option',
        label: 'A option',
        presentation: 'radio',
      }),
      'option',
    );
    owned.item = idOf(
      await post(tokenA, `/groups/${owned.group}/items`, {
        kind: 'heading',
        content: 'A heading',
      }),
      'item',
    );

    owned.value = idOf(
      await post(tokenA, `/options/${owned.option}/values`, { valueKey: 'a', label: 'A' }),
      'value',
    );

    // A published version, so the version routes have something real to hide.
    const published = await post(tokenA, `/option-sets/${owned.set}/publish`, {});

    if (published.status !== 201) {
      throw new Error(`Fixture failed to publish: ${JSON.stringify(published.body)}`);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.cleanup();
    await harness.close();
  });

  const post = (token: string, path: string, body: object = {}) =>
    request(harness.app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const patch = (token: string, path: string, body: object = {}) =>
    request(harness.app.getHttpServer())
      .patch(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (token: string, path: string) =>
    request(harness.app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${token}`);
  const del = (token: string, path: string) =>
    request(harness.app.getHttpServer())
      .delete(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`);

  /**
   * Every tenant-scoped route that takes a foreign id, driven as tenant B.
   *
   * The route string is the key: `isolation-coverage` reads this file, compares
   * these against the router, and fails when a route exists with no entry here.
   */
  const probes: Array<[string, () => request.Test]> = [
    // Option sets
    ['GET /v1/option-sets/:id', () => get(tokenB, `/option-sets/${owned.set}`)],
    ['PATCH /v1/option-sets/:id', () => patch(tokenB, `/option-sets/${owned.set}`, { name: 'x' })],
    ['DELETE /v1/option-sets/:id', () => del(tokenB, `/option-sets/${owned.set}`)],
    ['DELETE /v1/option-sets/:id/permanent', () =>
      del(tokenB, `/option-sets/${owned.set}/permanent`)],
    ['POST /v1/option-sets/:id/duplicate', () => post(tokenB, `/option-sets/${owned.set}/duplicate`)],
    ['GET /v1/option-sets/:id/detail', () => get(tokenB, `/option-sets/${owned.set}/detail`)],
    ['GET /v1/option-sets/:id/assignments', () =>
      get(tokenB, `/option-sets/${owned.set}/assignments`)],
    ['POST /v1/option-sets/:id/assignments', () =>
      post(tokenB, `/option-sets/${owned.set}/assignments`, { externalProductIds: ['wc-1'] })],
    ['DELETE /v1/option-sets/:id/assignments/:externalProductId', () =>
      del(tokenB, `/option-sets/${owned.set}/assignments/wc-1`)],
    ['GET /v1/option-sets/:id/preview', () => get(tokenB, `/option-sets/${owned.set}/preview`)],

    /**
     * Stores (M8.6). Both are destructive ownership acts, so a 403 here would
     * confirm another tenant's store exists before refusing to touch it.
     */
    ['GET /v1/stores/:id', () => get(tokenB, `/stores/${storeA}`)],
    ['POST /v1/stores/:id/disconnect', () => post(tokenB, `/stores/${storeA}/disconnect`)],
    ['POST /v1/stores/:id/rotate-credential', () =>
      post(tokenB, `/stores/${storeA}/rotate-credential`)],

    // Publishing
    ['GET /v1/option-sets/:id/publish-check', () =>
      get(tokenB, `/option-sets/${owned.set}/publish-check`)],
    ['POST /v1/option-sets/:id/publish', () => post(tokenB, `/option-sets/${owned.set}/publish`)],
    ['GET /v1/option-sets/:id/versions', () => get(tokenB, `/option-sets/${owned.set}/versions`)],
    ['GET /v1/option-sets/:id/versions/:version', () =>
      get(tokenB, `/option-sets/${owned.set}/versions/1`)],
    ['POST /v1/option-sets/:id/rollback', () =>
      post(tokenB, `/option-sets/${owned.set}/rollback`, { version: 1 })],

    // Groups
    ['GET /v1/option-sets/:id/groups', () => get(tokenB, `/option-sets/${owned.set}/groups`)],
    ['POST /v1/option-sets/:id/groups', () =>
      post(tokenB, `/option-sets/${owned.set}/groups`, { label: 'x' })],
    ['POST /v1/option-sets/:id/reorder', () =>
      post(tokenB, `/option-sets/${owned.set}/reorder`, {
        groups: [{ id: owned.group, sortOrder: 10 }],
      })],
    ['GET /v1/groups/:id', () => get(tokenB, `/groups/${owned.group}`)],
    ['PATCH /v1/groups/:id', () => patch(tokenB, `/groups/${owned.group}`, { label: 'x' })],
    ['DELETE /v1/groups/:id', () => del(tokenB, `/groups/${owned.group}`)],
    ['POST /v1/groups/:id/duplicate', () => post(tokenB, `/groups/${owned.group}/duplicate`)],

    // Options
    ['GET /v1/groups/:id/options', () => get(tokenB, `/groups/${owned.group}/options`)],
    ['POST /v1/groups/:id/options', () =>
      post(tokenB, `/groups/${owned.group}/options`, {
        key: 'x',
        label: 'X',
        presentation: 'radio',
      })],
    ['GET /v1/options/:id', () => get(tokenB, `/options/${owned.option}`)],
    ['PATCH /v1/options/:id', () => patch(tokenB, `/options/${owned.option}`, { label: 'x' })],
    ['DELETE /v1/options/:id', () => del(tokenB, `/options/${owned.option}`)],
    ['POST /v1/options/:id/duplicate', () => post(tokenB, `/options/${owned.option}/duplicate`)],
    ['POST /v1/groups/:id/reorder', () =>
      post(tokenB, `/groups/${owned.group}/reorder`, {
        options: [{ id: owned.option, sortOrder: 10 }],
      })],

    /*
     * Presentational items.
     *
     * 🔴 **These six shipped in Phase 14 with no negative test at all.** The
     * routes were registered, the contract never listed them, and
     * `check-isolation` had been failing on them ever since — a gate that is
     * always red is a gate everyone learns to ignore. An item is authored content
     * nested under a group exactly as an option is, so it leaks exactly the same
     * way if the scoping is wrong.
     */
    ['GET /v1/groups/:id/items', () => get(tokenB, `/groups/${owned.group}/items`)],
    ['POST /v1/groups/:id/items', () =>
      post(tokenB, `/groups/${owned.group}/items`, {
        kind: 'heading',
        content: 'X',
      })],
    ['GET /v1/items/:id', () => get(tokenB, `/items/${owned.item}`)],
    ['PATCH /v1/items/:id', () => patch(tokenB, `/items/${owned.item}`, { content: 'x' })],
    ['DELETE /v1/items/:id', () => del(tokenB, `/items/${owned.item}`)],
    ['POST /v1/groups/:id/items/reorder', () =>
      post(tokenB, `/groups/${owned.group}/items/reorder`, {
        items: [{ id: owned.item, sortOrder: 10 }],
      })],

    // Values
    ['GET /v1/options/:id/values', () => get(tokenB, `/options/${owned.option}/values`)],
    ['POST /v1/options/:id/values', () =>
      post(tokenB, `/options/${owned.option}/values`, { valueKey: 'x', label: 'X' })],
    ['GET /v1/values/:id', () => get(tokenB, `/values/${owned.value}`)],
    ['PATCH /v1/values/:id', () => patch(tokenB, `/values/${owned.value}`, { label: 'x' })],
    ['DELETE /v1/values/:id', () => del(tokenB, `/values/${owned.value}`)],
    ['POST /v1/values/:id/duplicate', () => post(tokenB, `/values/${owned.value}/duplicate`)],
    ['POST /v1/options/:id/reorder', () =>
      post(tokenB, `/options/${owned.option}/reorder`, {
        values: [{ id: owned.value, sortOrder: 10 }],
      })],
  ];

  describe('direct access to another tenant’s resource', () => {
    it.each(probes)('%s answers 404', async (_route, call) => {
      const response = await call();

      // 404, never 403: a 403 confirms the resource exists, and walking ids
      // would enumerate another tenant's data without ever reading it.
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }, 60_000);
  });

  describe('after every refused attempt', () => {
    /**
     * The probes above assert the *answer*. This asserts the *effect* — that
     * thirty refused writes changed nothing. A 404 returned while the write
     * succeeded would pass every test above.
     */
    it('leaves tenant A’s data exactly as it was', async () => {
      const set = await get(tokenA, `/option-sets/${owned.set}/detail`);

      expect(set.status).toBe(200);
      expect(set.body.data.name).toBe('A');
      expect(set.body.data.groups).toHaveLength(1);
      expect(set.body.data.groups[0].label).toBe('A group');
      expect(set.body.data.groups[0].options).toHaveLength(1);
      expect(set.body.data.groups[0].options[0].key).toBe('a_option');
      expect(set.body.data.groups[0].options[0].values).toHaveLength(1);
    }, 60_000);

    it('kept the published version history intact', async () => {
      const versions = await get(tokenA, `/option-sets/${owned.set}/versions`);

      expect(versions.body.data.versions).toHaveLength(1);
      expect(versions.body.data.versions[0].version).toBe(1);
    }, 60_000);
  });

  /**
   * Routes that take no foreign id cannot 404. They are covered by asserting
   * the opposite property: tenant B's collection never contains tenant A's rows.
   */
  describe('collections never leak', () => {
    it('GET /v1/option-sets shows tenant B only their own', async () => {
      const response = await get(tokenB, '/option-sets?limit=100');

      expect(response.status).toBe(200);
      expect(
        response.body.data.some((row: { id: string }) => row.id === owned.set),
      ).toBe(false);
    }, 60_000);

    /**
     * The store list is the dashboard's landing screen (M13.3), so a leak here
     * would be the first thing a merchant saw — another tenant's shop URL,
     * plugin version and connection health.
     */
    it('GET /v1/stores shows tenant B only their own', async () => {
      const response = await get(tokenB, '/stores');

      expect(response.status).toBe(200);
      expect(
        response.body.data.some((row: { id: string }) => row.id === storeA),
      ).toBe(false);
    }, 60_000);

    /**
     * The catalogue picker (M13.6) takes a store id, so tenant B can *ask* for
     * tenant A's store directly. It must see an empty catalogue, not tenant A's.
     *
     * A `200` with nothing in it rather than a `404`: the tenant join eliminates
     * the rows, which is not the same as the store being absent, and pretending
     * otherwise would state a contract the code does not implement.
     */
    it('GET /v1/products shows tenant B nothing from tenant A’s store', async () => {
      /*
       * Tenant A's store must actually hold a product, or this passes against an
       * empty table and proves nothing -- the shape of "green test, no coverage"
       * this suite exists to prevent.
       */
      await harness.dataSource.query(
        `INSERT INTO store_products
           (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt)
         VALUES (UUID(), NOW(3), NOW(3), ?, 'wc-1', 'Tenant A Hoodie', 'simple', 'publish', NOW(3))`,
        [storeA],
      );

      const mine = await get(tokenA, `/products?storeId=${storeA}`);
      expect(mine.status).toBe(200);
      expect(mine.body.data).toHaveLength(1);

      const theirs = await get(tokenB, `/products?storeId=${storeA}`);

      expect(theirs.status).toBe(200);
      expect(theirs.body.data).toEqual([]);
    }, 60_000);

    it('GET /v1/audit-logs shows tenant B only their own', async () => {
      const response = await get(tokenB, '/audit-logs?limit=100');

      expect(response.status).toBe(200);

      const ids = response.body.data.map((row: { id: string }) => row.id);
      const [foreign] = await harness.dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs
          WHERE id IN (?) AND tenantId <> (
            SELECT tm.tenantId FROM tenant_members tm JOIN users u ON u.id = tm.userId
             WHERE u.email = ?)`,
        [ids.length > 0 ? ids : ['0'], `${NS}-b@example.com`],
      );

      expect(Number(foreign.n)).toBe(0);
    }, 60_000);

    /**
     * `POST /v1/option-sets` names its store. Attaching a set to another
     * tenant's storefront would make it theirs while pointing somewhere it
     * should not.
     */
    it('POST /v1/option-sets refuses another tenant’s store', async () => {
      const response = await post(tokenB, '/option-sets', {
        name: 'Smuggled',
        storeId: storeA,
      });

      expect(response.status).toBe(404);
    }, 60_000);
  });

  /**
   * The exit criterion M7.7 states as *"User-JWT and store-token realms strictly
   * separated"* (AC8).
   *
   * `JwtService.verify` checks the `aud` claim and a mismatch is a **401, not a
   * 403** — distinguishing "wrong realm" from "expired" tells an attacker which
   * part of their forgery worked. That was built in Phase 6 and nothing asserted
   * it; found while checking Phase 7's exit criteria.
   */
  describe('identity realms stay separate', () => {
    /**
     * A token identical to tenant A's working one **except its audience**.
     *
     * The first version used a made-up `tid` and a made-up subject, and passed
     * even with the audience check removed — the 401 came from a tenant that
     * did not resolve, not from the realm. A negative test that fails for the
     * wrong reason proves nothing, so this carries the real user and the real
     * tenant and changes exactly one thing.
     */
    async function tokenForRealm(audience: string): Promise<string> {
      const [row] = await harness.dataSource.query(
        `SELECT u.id AS userId, tm.tenantId, tm.role
           FROM users u JOIN tenant_members tm ON tm.userId = u.id
          WHERE u.email = ?`,
        [`${NS}-a@example.com`],
      );

      return harness.app
        .get(JwtService)
        .sign(
          { tid: row.tenantId, role: row.role },
          { subject: row.userId, audience, expiresIn: '5m' },
        );
    }

    it.each([['platform'], ['store']])(
      'refuses a %s token on a tenant route',
      async (audience) => {
        const response = await request(harness.app.getHttpServer())
          .get('/v1/option-sets')
          .set('Authorization', `Bearer ${await tokenForRealm(audience)}`);

        // 401, not 403: the token is not merely under-privileged, it is for a
        // different realm entirely.
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('UNAUTHENTICATED');
      },
      60_000,
    );

    /**
     * The control. Same claims, same signature, correct audience — so the
     * rejections above can only be about the realm.
     */
    it('accepts the same claims when the audience is right', async () => {
      const response = await request(harness.app.getHttpServer())
        .get('/v1/option-sets')
        .set('Authorization', `Bearer ${await tokenForRealm('tenant')}`);

      expect(response.status).toBe(200);
    }, 60_000);
  });

  /**
   * A filter or a sort parameter must not become a way to read across tenants.
   * M6.6 names these explicitly, because scoping applied to the base query and
   * forgotten on a filter is a real and quiet way to leak.
   */
  describe('filters and paging cannot widen scope', () => {
    it('a storeId filter naming another tenant’s store returns nothing', async () => {
      const response = await get(tokenB, `/option-sets?storeId=${storeA}&limit=100`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    }, 60_000);

    it('a search term matching another tenant’s set returns nothing', async () => {
      const response = await get(tokenB, '/option-sets?q=A&limit=100');

      expect(
        response.body.data.some((row: { id: string }) => row.id === owned.set),
      ).toBe(false);
    }, 60_000);

    it('a cursor built from another tenant’s row does not widen scope', async () => {
      const forged = Buffer.from(
        `2000-01-01T00:00:00.000Z|${owned.set}`,
        'utf8',
      ).toString('base64url');

      const response = await get(tokenB, `/option-sets?limit=100&cursor=${forged}`);

      expect(response.status).toBe(200);
      expect(
        response.body.data.some((row: { id: string }) => row.id === owned.set),
      ).toBe(false);
    }, 60_000);

    it('an audit filter naming another tenant’s resource returns nothing', async () => {
      const response = await get(tokenB, `/audit-logs?resourceId=${owned.set}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    }, 60_000);
  });
});
