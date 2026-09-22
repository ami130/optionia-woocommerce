import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { createHarness, idOf, type Harness } from './harness';

/**
 * Publish, version history and rollback (M7.4, step 7i).
 *
 * Snapshots are immutable and a storefront reads them, so the properties tested
 * here are the ones a mistake makes permanent: a version number never reused, a
 * snapshot never rewritten, and a config version that only ever advances.
 */
describe('publish (e2e)', () => {
  let harness: Harness;
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'pub7i';

  let token = '';
  let tokenB = '';
  let storeId = '';
  let tenantId = '';

  beforeAll(async () => {
    harness = await createHarness(NS);
    app = harness.app;
    dataSource = harness.dataSource;
    await harness.cleanup();

    token = await harness.tenant('a');
    tokenB = await harness.tenant('b');

    const [row] = await dataSource.query(
      `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email = ?`,
      [`${NS}-a@example.com`],
    );
    tenantId = row.id as string;
    storeId = randomUUID();

    await dataSource.query(
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                           createdAt, updatedAt)
       VALUES (?, ?, 'woocommerce', 'store', ?, 'connected', 0, NOW(3), NOW(3))`,
      [storeId, tenantId, `https://${storeId}.example.com`],
    );
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();
    await harness.close();
  });



  const post = (path: string, body: object = {}, auth = token) =>
    request(app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body);
  const patch = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (path: string, auth = token) =>
    request(app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${auth}`);


  /** A publishable set: one group, one option, one value, one assignment. */
  async function publishable(name = 'Ready'): Promise<{ set: string; option: string; value: string }> {
    const set = idOf(await post('/option-sets', { name, storeId }), 'set');
    const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'G' }), 'group');
    const option = idOf(
      await post(`/groups/${group}/options`, {
        key: 'placement',
        label: 'Placement',
        presentation: 'radio',
      }),
      'option',
    );
    const value = idOf(
      await post(`/options/${option}/values`, { valueKey: 'front', label: 'Front' }),
      'value',
    );

    await dataSource.query(
      `INSERT INTO option_set_assignments (id, optionSetId, mode, targetType, targetRef,
                                           priority, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, 'all', NULL, NULL, 0, NOW(3), NOW(3), '1970-01-01 00:00:00.000')`,
      [randomUUID(), set],
    );

    return { set, option, value };
  }

  async function storeConfigVersion(): Promise<number> {
    const [row] = await dataSource.query(`SELECT configVersion FROM stores WHERE id = ?`, [
      storeId,
    ]);

    return Number(row.configVersion);
  }

  describe('publish-check', () => {
    it('reports nothing blocking for a ready set', async () => {
      const { set } = await publishable();
      const response = await get(`/option-sets/${set}/publish-check`);

      expect(response.status).toBe(200);
      expect(response.body.data.findings.filter((f: { severity: string }) => f.severity === 'blocker')).toEqual([]);
    }, 60_000);

    it('blocks an option with no values, naming it', async () => {
      const set = idOf(await post('/option-sets', { name: 'Empty option', storeId }), 'set');
      const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'G' }), 'group');
      await post(`/groups/${group}/options`, {
        key: 'novalues',
        label: 'Print placement',
        presentation: 'radio',
      });

      const findings = (await get(`/option-sets/${set}/publish-check`)).body.data.findings;
      const blocker = findings.find((f: { code: string }) => f.code === 'OPTION_HAS_NO_VALUES');

      expect(blocker.severity).toBe('blocker');
      expect(blocker.message).toContain('Print placement');
    }, 60_000);

    it('warns when a set is assigned to nothing', async () => {
      const set = idOf(await post('/option-sets', { name: 'Unassigned', storeId }), 'set');
      const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'G' }), 'group');
      const option = idOf(
        await post(`/groups/${group}/options`, { key: 'k', label: 'K', presentation: 'radio' }),
        'option',
      );
      await post(`/options/${option}/values`, { valueKey: 'v', label: 'V' });

      const findings = (await get(`/option-sets/${set}/publish-check`)).body.data.findings;

      expect(
        findings.find((f: { code: string }) => f.code === 'SET_HAS_NO_ASSIGNMENT').severity,
      ).toBe('warning');
    }, 60_000);

    /** Seeing what is wrong is not a privileged act. */
    it('is readable without the publish capability', async () => {
      const { set } = await publishable();

      expect((await get(`/option-sets/${set}/publish-check`)).status).toBe(200);
    }, 60_000);
  });

  describe('publish', () => {
    it('produces version 1 and marks the set published', async () => {
      const { set } = await publishable();
      const response = await post(`/option-sets/${set}/publish`, { note: 'first' });

      expect(response.status).toBe(201);
      expect(response.body.data.version).toBe(1);

      const detail = (await get(`/option-sets/${set}/detail`)).body.data;
      expect(detail.status).toBe('published');
      expect(detail.version).toBe(1);
      expect(detail.publishedAt).not.toBeNull();
      expect(detail.publishedBy).not.toBeNull();
    }, 60_000);

    it('refuses to publish a set with a blocker', async () => {
      const set = idOf(await post('/option-sets', { name: 'Blocked', storeId }), 'set');
      const response = await post(`/option-sets/${set}/publish`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details[0].code).toBe('SET_HAS_NO_OPTIONS');

      // Nothing was written.
      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM option_set_versions WHERE optionSetId = ?`,
        [set],
      );
      expect(Number(row.n)).toBe(0);
    }, 60_000);

    it('publishes despite warnings, and returns them', async () => {
      const set = idOf(await post('/option-sets', { name: 'Warned', storeId }), 'set');
      const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'G' }), 'group');
      const option = idOf(
        await post(`/groups/${group}/options`, { key: 'k', label: 'K', presentation: 'radio' }),
        'option',
      );
      await post(`/options/${option}/values`, { valueKey: 'v', label: 'V' });

      const response = await post(`/option-sets/${set}/publish`);

      expect(response.status).toBe(201);
      expect(
        response.body.data.warnings.some((w: { code: string }) => w.code === 'SET_HAS_NO_ASSIGNMENT'),
      ).toBe(true);
    }, 60_000);

    it('increments the version on each publish', async () => {
      const { set } = await publishable();

      expect((await post(`/option-sets/${set}/publish`)).body.data.version).toBe(1);
      expect((await post(`/option-sets/${set}/publish`)).body.data.version).toBe(2);
      expect((await post(`/option-sets/${set}/publish`)).body.data.version).toBe(3);
    }, 90_000);

    /** The plugin polls this number to decide whether to re-fetch. */
    it('advances the store’s config version', async () => {
      const { set } = await publishable();
      const before = await storeConfigVersion();

      const response = await post(`/option-sets/${set}/publish`);

      expect(await storeConfigVersion()).toBeGreaterThan(before);
      expect(response.body.data.configVersion).toBe(await storeConfigVersion());
    }, 60_000);

    /**
     * The whole point of the draft state: a merchant edits safely on a live
     * store, and the storefront keeps reading the last published snapshot.
     */
    it('does not let an edit reach the published snapshot', async () => {
      const { set, option } = await publishable();
      await post(`/option-sets/${set}/publish`);

      await patch(`/options/${option}`, { label: 'Renamed after publish' });

      const snapshot = (await get(`/option-sets/${set}/versions/1`)).body.data;
      const label = snapshot.groups[0].options[0].label;

      expect(label).toBe('Placement');

      // The editor shows the edit; the snapshot does not.
      const detail = (await get(`/option-sets/${set}/detail`)).body.data;
      expect(detail.groups[0].options[0].label).toBe('Renamed after publish');
    }, 90_000);

    it('refuses another tenant’s set as a 404', async () => {
      const { set } = await publishable();

      expect((await post(`/option-sets/${set}/publish`, {}, tokenB)).status).toBe(404);
    }, 60_000);
  });

  describe('version history', () => {
    it('lists versions newest first, without snapshots', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`, { note: 'one' });
      await post(`/option-sets/${set}/publish`, { note: 'two' });

      const versions = (await get(`/option-sets/${set}/versions`)).body.data.versions;

      expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(versions[0].note).toBe('two');
      expect(versions[0]).not.toHaveProperty('snapshot');
    }, 90_000);

    it('returns one snapshot as the storefront received it', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);

      const snapshot = (await get(`/option-sets/${set}/versions/1`)).body.data;

      expect(snapshot.version).toBe(1);
      expect(snapshot.groups[0].options[0].key).toBe('placement');
      // The published shape, not the authoring one.
      expect(snapshot.groups[0].options[0]).toHaveProperty('is_required');
      expect(JSON.stringify(snapshot)).not.toContain('tenantId');
    }, 60_000);

    it('answers 404 for a version that does not exist', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);

      expect((await get(`/option-sets/${set}/versions/99`)).status).toBe(404);
    }, 60_000);

    it('refuses another tenant’s history', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);

      expect((await get(`/option-sets/${set}/versions`, tokenB)).status).toBe(404);
      expect((await get(`/option-sets/${set}/versions/1`, tokenB)).status).toBe(404);
    }, 60_000);
  });

  describe('rollback', () => {
    /**
     * Rolling 2 back to 1 produces 3 whose content matches 1. Rewriting history
     * would make the trail a lie, and the merchant who needs rollback at 9pm is
     * the one who will later need to know what happened.
     */
    it('publishes a prior snapshot as a new version', async () => {
      const { set, option } = await publishable();
      await post(`/option-sets/${set}/publish`, { note: 'original' });

      await patch(`/options/${option}`, { label: 'Broken' });
      await post(`/option-sets/${set}/publish`, { note: 'broke it' });

      const response = await post(`/option-sets/${set}/rollback`, { version: 1 });

      expect(response.status).toBe(201);
      expect(response.body.data.version).toBe(3);

      const restored = (await get(`/option-sets/${set}/versions/3`)).body.data;
      expect(restored.groups[0].options[0].label).toBe('Placement');
      expect(restored.version).toBe(3);

      // History is intact: version 2 still says what it said.
      const broken = (await get(`/option-sets/${set}/versions/2`)).body.data;
      expect(broken.groups[0].options[0].label).toBe('Broken');
    }, 120_000);

    /**
     * Rollback changes what storefronts receive, not what the editor shows —
     * overwriting the draft would destroy the edits a merchant was making when
     * they hit the problem they are rolling back from.
     */
    it('leaves the working draft untouched', async () => {
      const { set, option } = await publishable();
      await post(`/option-sets/${set}/publish`);
      await patch(`/options/${option}`, { label: 'In progress' });

      await post(`/option-sets/${set}/rollback`, { version: 1 });

      const detail = (await get(`/option-sets/${set}/detail`)).body.data;
      expect(detail.groups[0].options[0].label).toBe('In progress');
    }, 90_000);

    it('records why in the history', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);
      await post(`/option-sets/${set}/rollback`, { version: 1, note: 'holiday pricing was wrong' });

      const versions = (await get(`/option-sets/${set}/versions`)).body.data.versions;

      expect(versions[0].note).toBe('holiday pricing was wrong');
    }, 90_000);

    it('defaults the note to name the restored version', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);
      await post(`/option-sets/${set}/rollback`, { version: 1 });

      const versions = (await get(`/option-sets/${set}/versions`)).body.data.versions;

      expect(versions[0].note).toContain('version 1');
    }, 90_000);

    it('answers 404 for a version that never existed', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);

      expect((await post(`/option-sets/${set}/rollback`, { version: 99 })).status).toBe(404);
    }, 60_000);

    it('advances the store’s config version', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);
      const before = await storeConfigVersion();

      await post(`/option-sets/${set}/rollback`, { version: 1 });

      expect(await storeConfigVersion()).toBeGreaterThan(before);
    }, 90_000);
  });

  describe('immutability and concurrency', () => {
    /** A snapshot is written once. Nothing in the API may update one. */
    it('never rewrites a snapshot', async () => {
      const { set, option } = await publishable();
      await post(`/option-sets/${set}/publish`);

      const before = JSON.stringify((await get(`/option-sets/${set}/versions/1`)).body.data);

      await patch(`/options/${option}`, { label: 'Changed' });
      await post(`/option-sets/${set}/publish`);
      await post(`/option-sets/${set}/rollback`, { version: 1 });

      const after = JSON.stringify((await get(`/option-sets/${set}/versions/1`)).body.data);

      expect(after).toBe(before);
    }, 120_000);

    /**
     * M7.4b: two simultaneous publishes must not interleave into a half-built
     * snapshot, and the second must see the first's version rather than reusing
     * it. `uq_option_set_versions` is the backstop if the lock ever fails.
     */
    it('serializes concurrent publishes', async () => {
      const { set } = await publishable();

      const responses = await Promise.all([
        post(`/option-sets/${set}/publish`),
        post(`/option-sets/${set}/publish`),
        post(`/option-sets/${set}/publish`),
      ]);

      /**
       * **All three succeed**, and that is the requirement rather than an
       * accident. M7.4b says "the second waits and then sees the first's
       * version" — waiting is what the row lock buys.
       *
       * Without it the unique constraint on `(option_set_id, version)` still
       * keeps the data correct, but the losers get a 409 and a merchant who
       * pressed publish twice is told their publish failed when it did not.
       * Asserting only "no version was reused" accepted both, so this asserts
       * the behaviour M7.4b actually promises.
       */
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);

      const versions = responses.map((response) => response.body.data.version).sort();

      expect(versions).toEqual([1, 2, 3]);

      const rows = await dataSource.query(
        `SELECT version FROM option_set_versions WHERE optionSetId = ? ORDER BY version`,
        [set],
      );
      expect(rows.map((r: { version: number }) => r.version)).toEqual([1, 2, 3]);
    }, 120_000);
  });

  describe('audit', () => {
    it('records a publish and a rollback with the version', async () => {
      const { set } = await publishable();
      await post(`/option-sets/${set}/publish`);
      await post(`/option-sets/${set}/rollback`, { version: 1 });

      const rows = await dataSource.query(
        `SELECT action, changes, userId, ip FROM audit_logs WHERE resourceId = ?
          AND action IN ('option_set.published', 'option_set.rolled_back') ORDER BY createdAt`,
        [set],
      );

      expect(rows.map((r: { action: string }) => r.action)).toEqual([
        'option_set.published',
        'option_set.rolled_back',
      ]);
      expect(rows[0].changes.version).toEqual({ from: 0, to: 1 });
      expect(rows[1].changes.restoredFrom).toBe(1);
      rows.forEach((row: { userId: string | null; ip: Buffer | null }) => {
        expect(row.userId).not.toBeNull();
        expect(row.ip).not.toBeNull();
      });
    }, 120_000);

    /**
     * A count answers "were there any?". Support is asked "did anyone know this
     * set was assigned to nothing when it went live?", and only the codes answer
     * that.
     */
    it('records which warnings a publish proceeded with, not how many', async () => {
      const { set } = await publishable();

      // `publishable` assigns the set, so remove that to raise a warning the
      // publish will proceed through.
      await dataSource.query(`DELETE FROM option_set_assignments WHERE optionSetId = ?`, [set]);

      await post(`/option-sets/${set}/publish`);

      const [row] = await dataSource.query(
        `SELECT changes FROM audit_logs WHERE resourceId = ? AND action = 'option_set.published'`,
        [set],
      );

      expect(row.changes.warnings).toEqual([
        { code: 'SET_HAS_NO_ASSIGNMENT', subject: `set:${set}` },
      ]);
    }, 120_000);

    /** A clean publish records an empty list, not a missing field. */
    it('records an empty warning list when nothing was wrong', async () => {
      const { set } = await publishable();

      await post(`/option-sets/${set}/publish`);

      const [row] = await dataSource.query(
        `SELECT changes FROM audit_logs WHERE resourceId = ? AND action = 'option_set.published'`,
        [set],
      );

      expect(row.changes.warnings).toEqual([]);
    }, 120_000);
  });
});
