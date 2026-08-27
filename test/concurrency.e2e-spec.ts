import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { createHarness, idOf, type Harness } from './harness';

/**
 * Optimistic locking (M7.4b, step 7j).
 *
 * The acceptance is specific: two concurrent editors both save, the second gets
 * a 409 with a usable choice, and no write is silently lost. "Silently" is the
 * word that matters — the failure this designs out is not data corruption, it is
 * an afternoon's work disappearing with no error anywhere.
 */
describe('optimistic locking (e2e)', () => {
  let harness: Harness;
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'lock7j';

  let token = '';
  let storeId = '';

  beforeAll(async () => {
    harness = await createHarness(NS);
    app = harness.app;
    dataSource = harness.dataSource;
    await harness.cleanup();

    token = await harness.tenant('a');

    const [row] = await dataSource.query(
      `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email = ?`,
      [`${NS}-a@example.com`],
    );
    storeId = randomUUID();

    await dataSource.query(
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                           createdAt, updatedAt)
       VALUES (?, ?, 'woocommerce', 'store', ?, 'connected', 0, NOW(3), NOW(3))`,
      [storeId, row.id, `https://${storeId}.example.com`],
    );
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();
    await harness.close();
  });



  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const patch = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (path: string) =>
    request(app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${token}`);
  const del = (path: string) =>
    request(app.getHttpServer()).delete(`/v1${path}`).set('Authorization', `Bearer ${token}`);


  /** A set, and the version a client would have loaded. */
  async function loaded(name = 'Shared'): Promise<{ id: string; rowVersion: number }> {
    const id = idOf(await post('/option-sets', { name, storeId }), 'set');
    const set = (await get(`/option-sets/${id}`)).body.data;

    return { id, rowVersion: set.rowVersion as number };
  }

  describe('the acceptance', () => {
    /**
     * Two editors load the same set; the first saves; the second saves what they
     * loaded. The second must be refused.
     */
    it('refuses the second of two editors, and keeps the first’s write', async () => {
      const { id, rowVersion } = await loaded();

      const first = await patch(`/option-sets/${id}`, { name: 'First', rowVersion });
      const second = await patch(`/option-sets/${id}`, { name: 'Second', rowVersion });

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('VERSION_MISMATCH');

      // No write silently lost: the first editor's change is what stands.
      expect((await get(`/option-sets/${id}`)).body.data.name).toBe('First');
    }, 60_000);

    /** A 409 that only says "stale" leaves a dashboard with an error toast. */
    it('tells the client which version to reload', async () => {
      const { id, rowVersion } = await loaded();
      await patch(`/option-sets/${id}`, { name: 'Moved on', rowVersion });

      const conflict = await patch(`/option-sets/${id}`, { name: 'Stale', rowVersion });
      const current = (await get(`/option-sets/${id}`)).body.data.rowVersion;

      expect(conflict.body.error.details).toEqual([
        { field: 'rowVersion', code: 'STALE', params: { current } },
      ]);
    }, 60_000);

    it('accepts the retry once the client reloads', async () => {
      const { id, rowVersion } = await loaded();
      await patch(`/option-sets/${id}`, { name: 'First', rowVersion });

      const reloaded = (await get(`/option-sets/${id}`)).body.data.rowVersion;
      const retry = await patch(`/option-sets/${id}`, { name: 'Second', rowVersion: reloaded });

      expect(retry.status).toBe(200);
      expect((await get(`/option-sets/${id}`)).body.data.name).toBe('Second');
    }, 60_000);

    /**
     * The window a read-compare-write cannot close: both requests in flight at
     * once, both holding the same loaded version.
     *
     * Repeated, because a single pair can be serialized by chance — the request
     * that would expose the gap is the one whose read lands before the other's
     * write and whose write lands after it, and that interleaving is not
     * guaranteed on any given attempt.
     */
    it('lets exactly one of two simultaneous saves through', async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const { id, rowVersion } = await loaded(`Race ${attempt}`);

        const responses = await Promise.all([
          patch(`/option-sets/${id}`, { name: 'A', rowVersion }),
          patch(`/option-sets/${id}`, { name: 'B', rowVersion }),
        ]);

        const statuses = responses.map((response) => response.status).sort();

        // Exactly one write. Never two — which would be the silent overwrite —
        // and never zero.
        expect(statuses).toEqual([200, 409]);

        // Whichever won, the set carries its name: never a blend, never neither.
        const set = (await get(`/option-sets/${id}`)).body.data;
        expect(['A', 'B']).toContain(set.name);

        // And the version advanced exactly once, not twice.
        expect(set.rowVersion).toBe(rowVersion + 1);
      }
    }, 180_000);
  });

  describe('what carries a version', () => {
    it('refuses a stale delete', async () => {
      const { id, rowVersion } = await loaded();
      await patch(`/option-sets/${id}`, { name: 'Changed', rowVersion });

      const conflict = await del(`/option-sets/${id}?rowVersion=${rowVersion}`);

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('VERSION_MISMATCH');
      // Still there.
      expect((await get(`/option-sets/${id}`)).status).toBe(200);
    }, 60_000);

    it('allows a delete carrying the current version', async () => {
      const { id, rowVersion } = await loaded();
      const response = await del(`/option-sets/${id}?rowVersion=${rowVersion}`);

      // Reports the body on failure: a bare status tells you a delete was
      // refused, not which validator refused it.
      expect(
        response.status === 204 ? 204 : `${response.status} ${JSON.stringify(response.body)}`,
      ).toBe(204);
    }, 60_000);

    /**
     * Publishing a draft a colleague changed puts work in front of customers
     * that the publisher never reviewed.
     */
    it('refuses a stale publish', async () => {
      const { id, rowVersion } = await loaded();
      const group = idOf(await post(`/option-sets/${id}/groups`, { label: 'G' }), 'group');
      const option = idOf(
        await post(`/groups/${group}/options`, { key: 'k', label: 'K', presentation: 'radio' }),
        'option',
      );
      await post(`/options/${option}/values`, { valueKey: 'v', label: 'V' });

      const conflict = await post(`/option-sets/${id}/publish`, { rowVersion });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('VERSION_MISMATCH');

      // Nothing was published.
      expect((await get(`/option-sets/${id}/versions`)).body.data.versions).toEqual([]);
    }, 90_000);

    it('publishes when the version is current', async () => {
      const { id } = await loaded();
      const group = idOf(await post(`/option-sets/${id}/groups`, { label: 'G' }), 'group');
      const option = idOf(
        await post(`/groups/${group}/options`, { key: 'k', label: 'K', presentation: 'radio' }),
        'option',
      );
      await post(`/options/${option}/values`, { valueKey: 'v', label: 'V' });

      const current = (await get(`/option-sets/${id}`)).body.data.rowVersion;

      expect((await post(`/option-sets/${id}/publish`, { rowVersion: current })).status).toBe(201);
    }, 90_000);
  });

  describe('rollback', () => {
    /** A set with two published versions, and the version a client would hold. */
    async function published(): Promise<{ id: string; rowVersion: number }> {
      const id = idOf(await post('/option-sets', { name: 'Rollable', storeId }), 'set');
      const group = idOf(await post(`/option-sets/${id}/groups`, { label: 'G' }), 'group');
      const option = idOf(
        await post(`/groups/${group}/options`, { key: 'k', label: 'K', presentation: 'radio' }),
        'option',
      );
      await post(`/options/${option}/values`, { valueKey: 'v', label: 'V' });

      await post(`/option-sets/${id}/publish`, {});
      await post(`/option-sets/${id}/publish`, {});

      return { id, rowVersion: (await get(`/option-sets/${id}`)).body.data.rowVersion as number };
    }

    /**
     * The most consequential write on a set: it changes what every storefront
     * receives, and the merchant picks a version from a list that may have moved.
     */
    it('refuses a rollback whose history was stale', async () => {
      const { id, rowVersion } = await published();

      // A colleague publishes again; the merchant's history list is now stale.
      await post(`/option-sets/${id}/publish`, {});

      const conflict = await post(`/option-sets/${id}/rollback`, { version: 1, rowVersion });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('VERSION_MISMATCH');
    }, 120_000);

    it('rolls back when the version is current', async () => {
      const { id, rowVersion } = await published();

      const response = await post(`/option-sets/${id}/rollback`, { version: 1, rowVersion });

      expect(response.status).toBe(201);
      // A new version, not a rewrite: 2 published + 1 rollback = 3.
      expect(response.body.data.version).toBe(3);
    }, 120_000);

    it('accepts a rollback with no version, like every other write', async () => {
      const { id } = await published();

      expect((await post(`/option-sets/${id}/rollback`, { version: 1 })).status).toBe(201);
    }, 120_000);

    /**
     * Rollback changes what storefronts receive, not what the editor shows — a
     * rollback that overwrote the draft would destroy the edits the merchant was
     * making when they hit the problem.
     */
    it('leaves the working draft untouched', async () => {
      const { id, rowVersion } = await published();

      const added = idOf(
        await post(`/option-sets/${id}/groups`, { label: 'Draft work' }),
        'group',
      );
      const current = (await get(`/option-sets/${id}`)).body.data.rowVersion;

      await post(`/option-sets/${id}/rollback`, { version: 1, rowVersion: current });

      const groups = (await get(`/option-sets/${id}/groups`)).body.data as Array<{ id: string }>;

      expect(groups.some((group) => group.id === added)).toBe(true);
      void rowVersion;
    }, 120_000);
  });

  describe('when no version is sent', () => {
    /**
     * Scripts, migrations and background jobs have no loaded version. Requiring
     * one would break them to protect against a failure only editors have.
     */
    it('allows a write with no version at all', async () => {
      const { id } = await loaded();

      expect((await patch(`/option-sets/${id}`, { name: 'Unversioned' })).status).toBe(200);
    }, 60_000);
  });

  describe('edge cases', () => {
    /**
     * A stale client saving an unchanged name must still be told. Returning
     * early because nothing differs hides a real conflict, and the next save —
     * on a value that does differ — is the silent overwrite.
     */
    it('refuses a stale save even when nothing would change', async () => {
      const { id, rowVersion } = await loaded('Original');

      // A colleague adds a group: the set's version moves, its *name* does not.
      await post(`/option-sets/${id}/groups`, { label: 'Their work' });

      /**
       * The stale client saves the name it loaded — which is still the current
       * name. Only the version check can refuse this: a no-op guard that runs
       * first sees nothing to change and answers 200, hiding the conflict. The
       * client then believes it is current, and its *next* save — on a value
       * that does differ — is the silent overwrite.
       */
      const conflict = await patch(`/option-sets/${id}`, { name: 'Original', rowVersion });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('VERSION_MISMATCH');
    }, 60_000);

    /** A no-op save must not invalidate every other editor's loaded copy. */
    it('does not advance the version for a save that changes nothing', async () => {
      const { id, rowVersion } = await loaded('Same');

      expect((await patch(`/option-sets/${id}`, { name: 'Same', rowVersion })).status).toBe(200);
      expect((await get(`/option-sets/${id}`)).body.data.rowVersion).toBe(rowVersion);
    }, 60_000);

    it('refuses a version from the future', async () => {
      const { id, rowVersion } = await loaded();

      expect((await patch(`/option-sets/${id}`, { name: 'x', rowVersion: rowVersion + 99 })).status).toBe(
        409,
      );
    }, 60_000);

    it('rejects a non-numeric version before it reaches the lock', async () => {
      const { id } = await loaded();
      const response = await patch(`/option-sets/${id}`, { name: 'x', rowVersion: 'four' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }, 60_000);

    /** A conflict is not a 404: the caller may see the set, they are just stale. */
    it('answers 404 rather than 409 for another tenant’s set', async () => {
      const other = await harness.tenant('b');
      const { id, rowVersion } = await loaded();

      const response = await request(app.getHttpServer())
        .patch(`/v1/option-sets/${id}`)
        .set('Authorization', `Bearer ${other}`)
        .send({ name: 'Stolen', rowVersion });

      expect(response.status).toBe(404);
    }, 60_000);
  });

  describe('child edits', () => {
    /**
     * A group, option or value is part of its set, so editing one advances the
     * set's version — and a set-level save loaded before that edit is stale.
     * Without this, two people editing different parts of one set would never
     * see each other.
     */
    it('makes a set-level version stale after a child changes', async () => {
      const { id, rowVersion } = await loaded();

      await post(`/option-sets/${id}/groups`, { label: 'Added by a colleague' });

      expect((await patch(`/option-sets/${id}`, { name: 'Renamed', rowVersion })).status).toBe(409);
    }, 60_000);
  });
});
