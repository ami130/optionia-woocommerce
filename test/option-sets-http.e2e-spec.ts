import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import * as request from 'supertest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';

/**
 * Option set CRUD over HTTP (M7.1).
 *
 * Two tenants throughout, because `/option-sets/:id` names no tenant and the
 * scoping is entirely the data layer's job — a controller test that only ever
 * uses one tenant proves nothing about that.
 */
describe('option sets (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'oshttp';
  const PASSWORD = 'a-sufficiently-long-password';

  let tokenA = '';
  let tokenB = '';
  let storeA = '';
  let storeB = '';
  let setB = '';

  beforeAll(async () => {
    loadDotenv();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    const context = new RequestContextMiddleware();
    app.use(context.use.bind(context));
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        // Mirrors main.ts. Query parameters arrive as strings, so without this
        // `?limit=2` fails `@IsInt` and the suite tests a pipe the application
        // does not use — the same mistake as omitting the global prefix.
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    await cleanup();

    tokenA = await tenant('a');
    tokenB = await tenant('b');
    storeA = await store('a');
    storeB = await store('b');
    setB = await seedSet('b', storeB, 'B set');
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM audit_logs WHERE tenantId IN (SELECT id FROM tenants WHERE slug LIKE '${NS}-%')`);
    // Keyed on the tenant, because fixture ids are real UUIDs rather than
    // prefixed strings — the DTO requires a UUID and the fixture must look like
    // what the API accepts.
    const owned = `SELECT id FROM tenants WHERE slug LIKE '${NS}-%'`;

    await dataSource.query(
      `DELETE v FROM option_values v JOIN options o ON o.id = v.optionId
         JOIN option_groups g ON g.id = o.optionGroupId
         JOIN option_sets os ON os.id = g.optionSetId WHERE os.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE o FROM options o JOIN option_groups g ON g.id = o.optionGroupId
         JOIN option_sets os ON os.id = g.optionSetId WHERE os.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE g FROM option_groups g JOIN option_sets os ON os.id = g.optionSetId
        WHERE os.tenantId IN (${owned})`,
    );
    await dataSource.query(`DELETE FROM option_sets WHERE tenantId IN (${owned})`);
    await dataSource.query(`DELETE FROM stores WHERE tenantId IN (${owned})`);
    await dataSource.query(
      `DELETE tm FROM tenant_members tm JOIN users u ON u.id = tm.userId WHERE u.email LIKE '${NS}-%'`,
    );
    await dataSource.query(`DELETE FROM users WHERE email LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenants WHERE slug LIKE '${NS}-%'`);
  }

  /** Register, verify, log in — returns an access token. */
  async function tenant(which: string): Promise<string> {
    const email = `${NS}-${which}@example.com`;

    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: `${NS}-${which}`, tenantName: `${NS}-${which}` });
    await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [email]);
    await dataSource.query(
      `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
         JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
      [`${NS}-${which}`, email],
    );

    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD });

    return login.body.data.accessToken as string;
  }

  async function tenantIdOf(which: string): Promise<string> {
    const [row] = await dataSource.query(
      `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email = ?`,
      [`${NS}-${which}@example.com`],
    );

    return row.id;
  }

  async function store(which: string): Promise<string> {
    // A real UUID, because `storeId` is `@IsUUID()` on the DTO and a readable
    // fixture id is rejected at validation — correctly. Tracked for cleanup by
    // its tenant rather than by an id prefix.
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                           createdAt, updatedAt)
       VALUES (?, ?, 'woocommerce', ?, ?, 'connected', 0, NOW(3), NOW(3))`,
      [id, await tenantIdOf(which), which, `https://${which}.example.com`],
    );

    return id;
  }

  async function seedSet(which: string, storeId: string, name: string): Promise<string> {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO option_sets (id, tenantId, storeId, name, status, version, rowVersion,
                                publishedConfigVersion, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, 'draft', 1, 1, 0, NOW(3), NOW(3), '1970-01-01 00:00:00.000')`,
      [id, await tenantIdOf(which), storeId, name],
    );

    return id;
  }

  const asA = (method: 'get' | 'post' | 'patch' | 'delete', path = '') =>
    request(app.getHttpServer())[method](`/v1/option-sets${path}`).set(
      'Authorization',
      `Bearer ${tokenA}`,
    );

  describe('create', () => {
    it('creates a draft', async () => {
      const response = await asA('post').send({ name: 'Engraving', storeId: storeA });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ name: 'Engraving', status: 'draft' });
    }, 20_000);

    /**
     * A create names its store. Without a check, a caller could attach a set to
     * another tenant's storefront — the row would be theirs while pointing
     * somewhere it should not.
     */
    it('refuses another tenant’s store, as not found', async () => {
      const response = await asA('post').send({ name: 'Smuggled', storeId: storeB });

      expect(response.status).toBe(404);
    }, 20_000);

    it('rejects a missing name', async () => {
      expect((await asA('post').send({ storeId: storeA })).status).toBe(400);
    });

    it('rejects an unknown field', async () => {
      const response = await asA('post').send({
        name: 'x',
        storeId: storeA,
        status: 'published',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('read', () => {
    it('lists only this tenant’s sets', async () => {
      const response = await asA('get');

      expect(response.status).toBe(200);
      expect(response.body.data.every((s: { tenantId: string }) => s.tenantId !== setB)).toBe(
        true,
      );
      expect(response.body.data.map((s: { id: string }) => s.id)).not.toContain(setB);
    }, 20_000);

    it('paginates with a cursor', async () => {
      for (const name of ['P1', 'P2', 'P3']) {
        await asA('post').send({ name, storeId: storeA });
      }

      const first = await asA('get', '?limit=2');

      expect(first.body.data).toHaveLength(2);
      expect(first.body.meta.pagination.hasMore).toBe(true);

      const second = await asA('get', `?limit=2&cursor=${first.body.meta.pagination.cursor}`);
      const firstIds = first.body.data.map((s: { id: string }) => s.id);

      // No overlap: keyset paging must not repeat a row.
      second.body.data.forEach((s: { id: string }) => expect(firstIds).not.toContain(s.id));
    }, 40_000);

    it('filters by name prefix', async () => {
      await asA('post').send({ name: 'Filterable', storeId: storeA });

      const response = await asA('get', '?q=Filter');

      expect(response.body.data.every((s: { name: string }) => s.name.startsWith('Filter'))).toBe(
        true,
      );
    }, 20_000);

    /**
     * A malformed cursor is an error, not page one.
     *
     * Silently restarting would make a client's paging loop re-read page one
     * forever without ever seeing a failure. Each case below decodes without
     * throwing, so none of them is caught by a bare try/catch:
     * `@@@` yields an empty string, valid base64 may simply lack the separator,
     * and a well-formed pair can still carry a non-UUID or a partial date.
     */
    it.each([
      ['not valid base64', '@@@'],
      ['base64 without a separator', Buffer.from('nonsense').toString('base64url')],
      ['a non-UUID id', Buffer.from('2020-01-01T00:00:00.000Z|nope').toString('base64url')],
      ['a partial timestamp', Buffer.from('2020|01a03333-0000-7000-8000-000000000000').toString('base64url')],
      ['extra separators', Buffer.from('2020-01-01T00:00:00.000Z|a|b').toString('base64url')],
      ['an empty cursor', ''],
    ])('rejects %s', async (_label, cursor) => {
      const response = await asA('get', `?cursor=${encodeURIComponent(cursor)}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details).toEqual([{ field: 'cursor', code: 'INVALID_CURSOR' }]);
    }, 20_000);

    it('accepts the cursor it just issued', async () => {
      const first = await asA('get', '?limit=1');

      expect((await asA('get', `?limit=1&cursor=${first.body.meta.pagination.cursor}`)).status).toBe(
        200,
      );
    }, 20_000);

    it('refuses another tenant’s set exactly as a missing one', async () => {
      const foreign = await asA('get', `/${setB}`);
      const missing = await asA('get', '/01a03333-0000-7000-8000-000000000000');

      expect(foreign.status).toBe(missing.status);
      expect(foreign.body.error?.code).toBe(missing.body.error?.code);
    }, 20_000);
  });

  describe('update and delete', () => {
    async function make(name: string): Promise<string> {
      const response = await asA('post').send({ name, storeId: storeA });

      return response.body.data.id as string;
    }

    it('renames a set', async () => {
      const id = await make('Before');
      const response = await asA('patch', `/${id}`).send({ name: 'After' });

      expect(response.body.data.name).toBe('After');
    }, 20_000);

    async function rowVersionOf(id: string): Promise<number> {
      const [row] = await dataSource.query(`SELECT rowVersion FROM option_sets WHERE id = ?`, [id]);

      return row.rowVersion as number;
    }

    /**
     * `rowVersion` is the optimistic lock 7j turns into a 409. If a mutation
     * does not advance it, a stale client looks current — the exact failure
     * optimistic locking exists to prevent — so it is verified here, at the
     * step that writes it, rather than assumed by the step that reads it.
     */
    it('advances rowVersion on every mutation', async () => {
      const id = await make('Versioned');
      const created = await rowVersionOf(id);

      await asA('patch', `/${id}`).send({ name: 'Versioned II' });
      const afterUpdate = await rowVersionOf(id);

      await asA('delete', `/${id}`);
      const afterDelete = await rowVersionOf(id);

      expect(afterUpdate).toBeGreaterThan(created);
      expect(afterDelete).toBeGreaterThan(afterUpdate);
    }, 30_000);

    it('does not advance rowVersion for a rename that changes nothing', async () => {
      const id = await make('Same');
      const before = await rowVersionOf(id);

      await asA('patch', `/${id}`).send({ name: 'Same' });

      expect(await rowVersionOf(id)).toBe(before);
    }, 20_000);

    /**
     * `applyChange` restates the tenant predicate by hand in order to compute
     * `rowVersion` in SQL, so it is the one write in this class not scoped by
     * the shared helper. That makes it worth an isolation test of its own.
     */
    it('cannot advance another tenant’s rowVersion', async () => {
      const before = await rowVersionOf(setB);

      const response = await asA('patch', `/${setB}`).send({ name: 'Hijacked' });

      expect(response.status).toBe(404);
      expect(await rowVersionOf(setB)).toBe(before);
      const [row] = await dataSource.query(`SELECT name FROM option_sets WHERE id = ?`, [setB]);
      expect(row.name).not.toBe('Hijacked');
    }, 20_000);

    it('cannot rename another tenant’s set', async () => {
      expect((await asA('patch', `/${setB}`).send({ name: 'Hijacked' })).status).toBe(404);
    }, 20_000);

    it('soft deletes, and the set stops appearing', async () => {
      const id = await make('Doomed');

      expect((await asA('delete', `/${id}`)).status).toBe(204);
      expect((await asA('get', `/${id}`)).status).toBe(404);
    }, 20_000);

    it('cannot delete another tenant’s set', async () => {
      expect((await asA('delete', `/${setB}`)).status).toBe(404);

      const [row] = await dataSource.query(
        `SELECT deletedAt FROM option_sets WHERE id = ?`,
        [setB],
      );

      expect(new Date(row.deletedAt).getFullYear()).toBe(1970);
    }, 20_000);
  });

  describe('duplicate', () => {
    it('copies a set as a draft', async () => {
      const created = await asA('post').send({ name: 'Original', storeId: storeA });
      const response = await asA('post', `/${created.body.data.id}/duplicate`).send({});

      expect(response.status).toBe(201);
      expect(response.body.data.name).toBe('Original (copy)');
      expect(response.body.data.status).toBe('draft');
      expect(response.body.data.id).not.toBe(created.body.data.id);
    }, 30_000);

    it('accepts a name for the copy', async () => {
      const created = await asA('post').send({ name: 'Source', storeId: storeA });
      const response = await asA('post', `/${created.body.data.id}/duplicate`).send({
        name: 'Chosen',
      });

      expect(response.body.data.name).toBe('Chosen');
    }, 30_000);

    /**
     * **A copy is always a draft, whatever the original was.**
     *
     * Duplicating a published set and having the copy go live immediately would
     * publish work nobody reviewed — onto a storefront customers are buying from.
     * The earlier tests all copied a draft, so a mutation that preserved the
     * source status passed unnoticed.
     */
    it('copies a published set as a draft', async () => {
      const created = await asA('post').send({ name: 'Live', storeId: storeA });

      await dataSource.query(
        `UPDATE option_sets SET status = 'published', version = 4, publishedAt = NOW(3)
          WHERE id = ?`,
        [created.body.data.id],
      );

      const copy = await asA('post', `/${created.body.data.id}/duplicate`).send({});

      expect(copy.body.data.status).toBe('draft');
      // And it starts its own history rather than inheriting the original's.
      expect(copy.body.data.version).toBe(1);
      expect(copy.body.data.publishedAt).toBeNull();
    }, 30_000);

    /**
     * A deep copy, and a partial one is worse than none: the merchant sees
     * something that looks finished and is missing values they will not notice
     * until a customer cannot pick one.
     */
    it('copies groups, options and values', async () => {
      const created = await asA('post').send({ name: 'Deep', storeId: storeA });
      const setId = created.body.data.id as string;

      const groupId = randomUUID();
      const optionId = randomUUID();
      const S = `'1970-01-01 00:00:00.000'`;

      await dataSource.query(
        `INSERT INTO option_groups (id, optionSetId, label, description, displayType,
                                    sortOrder, isCollapsible, isEnabled, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'Group', '', 'inline', 0, 0, 1, NOW(3), NOW(3), ${S})`,
        [groupId, setId],
      );
      await dataSource.query(
        `INSERT INTO options (id, optionGroupId, \`key\`, valueKind, cardinality, presentation,
                              label, description, placeholder, helpText, isRequired, sortOrder,
                              isEnabled, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'size', 'choice', 'one', 'radio', 'Size', '', '', '', 1, 0, 0,
                 NOW(3), NOW(3), ${S})`,
        [optionId, groupId],
      );
      await dataSource.query(
        `INSERT INTO option_values (id, optionId, valueKey, label, sortOrder, priceType,
                                    priceAmountMinor, isDefault, isEnabled, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'small', 'Small', 0, 'fixed', 0, 1, 1, NOW(3), NOW(3), ${S})`,
        [randomUUID(), optionId],
      );

      const copy = await asA('post', `/${setId}/duplicate`).send({});

      const [counts] = await dataSource.query(
        // `groups`, `options` and `values` are reserved in MySQL 9.
        `SELECT COUNT(DISTINCT g.id) AS groupCount, COUNT(DISTINCT o.id) AS optionCount,
                COUNT(DISTINCT v.id) AS valueCount
           FROM option_groups g
           LEFT JOIN options o ON o.optionGroupId = g.id
           LEFT JOIN option_values v ON v.optionId = o.id
          WHERE g.optionSetId = ?`,
        [copy.body.data.id],
      );

      expect(Number(counts.groupCount)).toBe(1);
      expect(Number(counts.optionCount)).toBe(1);
      expect(Number(counts.valueCount)).toBe(1);
    }, 40_000);

    /**
     * A disabled option stays disabled in the copy. Silently enabling work a
     * merchant turned off would republish it on the copy's first publish.
     */
    it('preserves the enabled state of what it copies', async () => {
      const created = await asA('post').send({ name: 'Toggles', storeId: storeA });
      const setId = created.body.data.id as string;

      const groupId = randomUUID();
      const S = `'1970-01-01 00:00:00.000'`;

      await dataSource.query(
        `INSERT INTO option_groups (id, optionSetId, label, description, displayType,
                                    sortOrder, isCollapsible, isEnabled, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'Off', '', 'inline', 0, 0, 0, NOW(3), NOW(3), ${S})`,
        [groupId, setId],
      );

      const copy = await asA('post', `/${setId}/duplicate`).send({});

      const [row] = await dataSource.query(
        `SELECT isEnabled FROM option_groups WHERE optionSetId = ?`,
        [copy.body.data.id],
      );

      expect(Boolean(row.isEnabled)).toBe(false);
    }, 30_000);

    it('cannot duplicate another tenant’s set', async () => {
      expect((await asA('post', `/${setB}/duplicate`).send({})).status).toBe(404);
    }, 20_000);
  });

  describe('authentication and authorization', () => {
    it('refuses every route without a token', async () => {
      const server = app.getHttpServer();

      expect((await request(server).get('/v1/option-sets')).status).toBe(401);
      expect((await request(server).post('/v1/option-sets').send({})).status).toBe(401);
    });

    /**
     * `editor` can create and edit but not delete. The split is the permission
     * matrix's, and this asserts the API enforces it rather than the dashboard.
     */
    it('lets an editor create but not delete', async () => {
      await dataSource.query(
        `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
            SET tm.role = 'editor' WHERE u.email = ?`,
        [`${NS}-b@example.com`],
      );

      const asEditor = (method: 'post' | 'delete', path = '') =>
        request(app.getHttpServer())[method](`/v1/option-sets${path}`).set(
          'Authorization',
          `Bearer ${tokenB}`,
        );

      const created = await asEditor('post').send({ name: 'Editor made', storeId: storeB });
      expect(created.status).toBe(201);

      const deleted = await asEditor('delete', `/${created.body.data.id}`);
      expect(deleted.status).toBe(403);
      expect(deleted.body.error?.code).toBe('INSUFFICIENT_ROLE');
    }, 30_000);
  });

  /**
   * These read `audit_logs` directly and deliberately.
   *
   * `AuditService.record` swallows its own failures by design — the recorded
   * action has already happened, so failing it afterwards is worse. The cost is
   * that a spy on `record()` cannot tell a successful write from one that threw
   * and was logged. Only the table can.
   */
  describe('audit trail', () => {
    async function auditRowsFor(resourceId: string): Promise<
      Array<{ action: string; changes: Record<string, { from: unknown; to: unknown }>; userId: string | null; ip: Buffer | null; userAgent: string | null }>
    > {
      return dataSource.query(
        `SELECT action, changes, userId, ip, userAgent FROM audit_logs
         WHERE resourceId = ? ORDER BY createdAt`,
        [resourceId],
      );
    }

    it('records a create as a diff from nothing', async () => {
      const created = await asA('post').send({ name: 'Audited', storeId: storeA });
      const [row] = await auditRowsFor(created.body.data.id);

      expect(row.action).toBe('option_set.created');
      expect(row.changes.name).toEqual({ from: null, to: 'Audited' });
    }, 20_000);

    it('records an update as before and after', async () => {
      const created = await asA('post').send({ name: 'Before', storeId: storeA });
      const id = created.body.data.id as string;
      await asA('patch', `/${id}`).send({ name: 'After' });

      const rows = await auditRowsFor(id);
      const updated = rows.find((r) => r.action === 'option_set.updated');

      expect(updated?.changes.name).toEqual({ from: 'Before', to: 'After' });
    }, 20_000);

    it('records a delete as a transition to deleted', async () => {
      const created = await asA('post').send({ name: 'Doomed', storeId: storeA });
      const id = created.body.data.id as string;
      await asA('delete', `/${id}`);

      const rows = await auditRowsFor(id);
      const removed = rows.find((r) => r.action === 'option_set.deleted');

      expect(removed?.changes.deleted).toEqual({ from: false, to: true });
    }, 20_000);

    /** M7.6 requires actor, diff and IP. All three, on every mutation. */
    it('stamps actor, IP and user agent on every mutation', async () => {
      const created = await asA('post')
        .set('User-Agent', 'optionia-test/1.0')
        .send({ name: 'Attributed', storeId: storeA });
      const id = created.body.data.id as string;
      await asA('patch', `/${id}`).send({ name: 'Attributed II' });
      await asA('delete', `/${id}`);

      const rows = await auditRowsFor(id);

      expect(rows.length).toBeGreaterThanOrEqual(3);
      rows.forEach((row) => {
        expect(row.userId).not.toBeNull();
        expect(row.ip).not.toBeNull();
        expect(row.ip).toHaveLength(16);
      });
      expect(rows[0].userAgent).toBe('optionia-test/1.0');
    }, 30_000);

    /** An unchanged rename is not a change, and must not fabricate a trail. */
    it('records nothing for a rename to the same name', async () => {
      const created = await asA('post').send({ name: 'Unchanged', storeId: storeA });
      const id = created.body.data.id as string;
      await asA('patch', `/${id}`).send({ name: 'Unchanged' });

      const rows = await auditRowsFor(id);

      expect(rows.filter((r) => r.action === 'option_set.updated')).toHaveLength(0);
    }, 20_000);
  });
});
