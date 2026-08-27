import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';
import { AuditAction } from '../src/audit/audit.service';

/**
 * Audit coverage (M7.6, step 7l).
 *
 * *"Every option-set mutation recorded with actor, diff, IP."* The word that
 * decides this step is **every** — a trail with a hole is worse than none,
 * because it is trusted.
 *
 * So this drives each mutating route through HTTP and asserts a row appeared,
 * rather than checking that services call `record()`. A spy on the service
 * cannot tell a successful write from one that threw and was swallowed, which
 * `AuditService` does by design.
 */
describe('audit coverage (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'aud7l';
  const PASSWORD = 'a-sufficiently-long-password';

  let token = '';
  let tenantId = '';
  let storeId = '';

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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    dataSource = app.get(DataSource);
    await cleanup();

    token = await tenant('a');

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
    await cleanup();
    await app?.close();
  });

  async function cleanup(): Promise<void> {
    const owned = `SELECT id FROM tenants WHERE slug LIKE '${NS}-%'`;

    await dataSource.query(`DELETE FROM audit_logs WHERE tenantId IN (${owned})`);
    await dataSource.query(
      `DELETE vv FROM option_set_versions vv JOIN option_sets s ON s.id = vv.optionSetId
        WHERE s.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE r FROM option_rules r JOIN option_sets s ON s.id = r.optionSetId
        WHERE s.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE p FROM presentational_items p JOIN option_groups g ON g.id = p.optionGroupId
         JOIN option_sets s ON s.id = g.optionSetId WHERE s.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE v FROM option_values v JOIN options o ON o.id = v.optionId
         JOIN option_groups g ON g.id = o.optionGroupId
         JOIN option_sets s ON s.id = g.optionSetId WHERE s.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE o FROM options o JOIN option_groups g ON g.id = o.optionGroupId
         JOIN option_sets s ON s.id = g.optionSetId WHERE s.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE g FROM option_groups g JOIN option_sets s ON s.id = g.optionSetId
        WHERE s.tenantId IN (${owned})`,
    );
    await dataSource.query(`DELETE FROM option_sets WHERE tenantId IN (${owned})`);
    await dataSource.query(`DELETE FROM stores WHERE tenantId IN (${owned})`);
    await dataSource.query(
      `DELETE tm FROM tenant_members tm JOIN users u ON u.id = tm.userId WHERE u.email LIKE '${NS}-%'`,
    );
    await dataSource.query(`DELETE FROM users WHERE email LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenants WHERE slug LIKE '${NS}-%'`);
  }

  async function tenant(which: string): Promise<string> {
    const email = `${NS}-${which}@example.com`;

    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: which, tenantName: `${NS}-${which}` });
    await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [email]);
    await dataSource.query(
      `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
         JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
      [`${NS}-${which}`, email],
    );

    return (
      await request(app.getHttpServer()).post('/v1/auth/login').send({ email, password: PASSWORD })
    ).body.data.accessToken as string;
  }

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
  const del = (path: string) =>
    request(app.getHttpServer()).delete(`/v1${path}`).set('Authorization', `Bearer ${token}`);

  function idOf(response: request.Response, what: string): string {
    if (response.status !== 201) {
      throw new Error(
        `Fixture failed to create a ${what}: ${response.status} ` +
          `${JSON.stringify(response.body?.error ?? response.body)}`,
      );
    }

    return response.body.data.id as string;
  }

  /** Actions recorded for one resource. */
  async function actionsFor(resourceId: string): Promise<string[]> {
    const rows = await dataSource.query(
      `SELECT action FROM audit_logs WHERE resourceId = ? ORDER BY createdAt`,
      [resourceId],
    );

    return rows.map((row: { action: string }) => row.action);
  }

  /** Every audit row this tenant has, with the fields M7.6 names. */
  async function allRows(): Promise<
    Array<{ action: string; userId: string | null; ip: Buffer | null; changes: unknown }>
  > {
    return dataSource.query(
      `SELECT action, userId, ip, changes FROM audit_logs WHERE tenantId = ?`,
      [tenantId],
    );
  }

  /**
   * Drives every mutating route once. Returned ids let each assertion name the
   * resource it expects a row for.
   */
  async function exerciseEveryMutation(): Promise<Record<string, string>> {
    const set = idOf(await post('/option-sets', { name: 'Audited', storeId }), 'set');
    await patch(`/option-sets/${set}`, { name: 'Audited II' });

    const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'G' }), 'group');
    await patch(`/groups/${group}`, { label: 'G2' });

    const option = idOf(
      await post(`/groups/${group}/options`, {
        key: 'audited',
        label: 'Audited',
        presentation: 'radio',
      }),
      'option',
    );
    await patch(`/options/${option}`, { label: 'Audited II' });

    const value = idOf(
      await post(`/options/${option}/values`, { valueKey: 'v', label: 'V' }),
      'value',
    );
    await patch(`/values/${value}`, { label: 'V2' });

    const groupCopy = idOf(await post(`/groups/${group}/duplicate`), 'group copy');
    const optionCopy = idOf(await post(`/options/${option}/duplicate`), 'option copy');
    const setCopy = idOf(await post(`/option-sets/${set}/duplicate`), 'set copy');

    await post(`/option-sets/${set}/reorder`, { groups: [{ id: group, sortOrder: 20 }] });

    const published = await post(`/option-sets/${set}/publish`, {});

    if (published.status !== 201) {
      throw new Error(`Fixture failed to publish: ${JSON.stringify(published.body)}`);
    }

    await post(`/option-sets/${set}/rollback`, { version: 1 });

    // Deletes last: they take their children with them.
    await del(`/values/${value}`);
    await del(`/options/${option}`);
    await del(`/groups/${group}`);
    await del(`/option-sets/${setCopy}`);
    await del(`/option-sets/${setCopy}/permanent`);

    return { set, group, option, value, groupCopy, optionCopy, setCopy };
  }

  describe('every mutation is recorded', () => {
    let ids: Record<string, string>;

    beforeAll(async () => {
      ids = await exerciseEveryMutation();
    }, 240_000);

    it('records the option-set lifecycle', async () => {
      expect(await actionsFor(ids.set)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_SET_CREATED,
          AuditAction.OPTION_SET_UPDATED,
          AuditAction.OPTION_SET_REORDERED,
          AuditAction.OPTION_SET_PUBLISHED,
          AuditAction.OPTION_SET_ROLLED_BACK,
        ]),
      );
    }, 60_000);

    it('records a duplicate, a delete and a purge', async () => {
      expect(await actionsFor(ids.setCopy)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_SET_DUPLICATED,
          AuditAction.OPTION_SET_DELETED,
          AuditAction.OPTION_SET_PURGED,
        ]),
      );
    }, 60_000);

    it('records the group lifecycle', async () => {
      expect(await actionsFor(ids.group)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_GROUP_CREATED,
          AuditAction.OPTION_GROUP_UPDATED,
          AuditAction.OPTION_GROUP_DELETED,
        ]),
      );
      expect(await actionsFor(ids.groupCopy)).toContain(AuditAction.OPTION_GROUP_DUPLICATED);
    }, 60_000);

    it('records the option lifecycle', async () => {
      expect(await actionsFor(ids.option)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_CREATED,
          AuditAction.OPTION_UPDATED,
          AuditAction.OPTION_DELETED,
        ]),
      );
      expect(await actionsFor(ids.optionCopy)).toContain(AuditAction.OPTION_DUPLICATED);
    }, 60_000);

    it('records the value lifecycle', async () => {
      expect(await actionsFor(ids.value)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_VALUE_CREATED,
          AuditAction.OPTION_VALUE_UPDATED,
          AuditAction.OPTION_VALUE_DELETED,
        ]),
      );
    }, 60_000);

    /**
     * The check that makes this a coverage test rather than a list.
     *
     * Every action the codebase defines must be produced by driving routes, or
     * be listed below as covered elsewhere with a reason. An action defined and
     * never reachable is a hole in the trail nobody notices, because the
     * constant looks like proof it works.
     *
     * **This originally filtered to `^option[_.]` and so could not see the
     * `member.*` actions at all** — which is how `member.joined` came to be
     * defined and recorded nowhere while this test passed. It now covers every
     * action, and anything not exercised here must be named.
     */
    it('leaves no audit action defined but unreachable', async () => {
      const produced = new Set((await allRows()).map((row) => row.action));

      /**
       * Covered by another suite, each for a stated reason. A name may only
       * appear here if driving it from this suite is genuinely impossible.
       */
      const coveredElsewhere: Record<string, string> = {
        // Needs a rule targeting the value; the cascade suite creates one.
        [AuditAction.OPTION_VALUE_DELETE_REFUSED]: 'cascade.e2e-spec',
        // Team lifecycle: a second user, an invitation and its acceptance.
        [AuditAction.MEMBER_INVITED]: 'team.e2e-spec',
        [AuditAction.MEMBER_JOINED]: 'team.e2e-spec',
        [AuditAction.MEMBER_ROLE_CHANGED]: 'team.e2e-spec',
        [AuditAction.MEMBER_REMOVED]: 'team.e2e-spec',
      };

      const unaccounted = Object.values(AuditAction).filter(
        (action) => !produced.has(action) && !(action in coveredElsewhere),
      );

      expect(unaccounted).toEqual([]);
    }, 60_000);

    /**
     * The other half of the same guarantee: every name claimed as "covered
     * elsewhere" must actually be recorded by something.
     *
     * Without this, moving an action into that list is a way to silence the
     * check above rather than satisfy it.
     */
    it('records every action claimed as covered elsewhere', async () => {
      const claimed = [
        AuditAction.OPTION_VALUE_DELETE_REFUSED,
        AuditAction.MEMBER_INVITED,
        AuditAction.MEMBER_JOINED,
        AuditAction.MEMBER_ROLE_CHANGED,
        AuditAction.MEMBER_REMOVED,
      ];

      const source = readFileSync('src/tenants/team.service.ts', 'utf8');
      const values = readFileSync('src/option-sets/option-values.service.ts', 'utf8');
      const both = source + values;

      claimed.forEach((action) => {
        const constant = Object.entries(AuditAction).find(([, value]) => value === action)?.[0];

        expect(both).toContain(`AuditAction.${constant}`);
      });
    }, 60_000);
  });

  /**
   * Reading it back.
   *
   * The trail was write-only: `AUDIT_LOG_VIEW` was granted to owner and admin
   * and no route consumed it, so the data a merchant is told is kept for their
   * protection could not be shown to them.
   */
  describe('reading the trail', () => {
    const get = (path: string, auth = token) =>
      request(app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${auth}`);

    beforeAll(async () => {
      await exerciseEveryMutation();
    }, 240_000);

    it('returns entries newest first', async () => {
      const response = await get('/audit-logs');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);

      const ids = response.body.data.map((entry: { id: string }) => Number(entry.id));
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
    }, 60_000);

    /** A `VARBINARY` read straight out of MySQL is unreadable. */
    it('returns the IP readable, not as packed bytes', async () => {
      const [entry] = (await get('/audit-logs')).body.data;

      expect(entry.ip).toMatch(/^[\d.]+$|^[\da-f:]+$/);
      expect(entry.userId).not.toBeNull();
      expect(entry.changes).not.toBeNull();
    }, 60_000);

    it('filters by action', async () => {
      const response = await get(`/audit-logs?action=${AuditAction.OPTION_SET_PUBLISHED}`);

      expect(response.body.data.length).toBeGreaterThan(0);
      response.body.data.forEach((entry: { action: string }) =>
        expect(entry.action).toBe(AuditAction.OPTION_SET_PUBLISHED),
      );
    }, 60_000);

    it('filters by resource', async () => {
      const set = idOf(await post('/option-sets', { name: 'Filtered', storeId }), 'set');

      const response = await get(`/audit-logs?resourceId=${set}`);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].action).toBe(AuditAction.OPTION_SET_CREATED);
    }, 60_000);

    it('pages without repeating or skipping a row', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const response = await get(`/audit-logs?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
        response.body.data.forEach((entry: { id: string }) => seen.push(entry.id));
        cursor = response.body.meta.pagination.cursor as string | null;
        pages += 1;
      } while (cursor && pages < 20);

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeGreaterThan(5);
    }, 120_000);

    /** Same reasoning as every other cursor: silent restart is an infinite loop. */
    it.each([['garbage', '@@@'], ['a non-numeric id', Buffer.from('abc').toString('base64url')]])(
      'refuses %s as a cursor',
      async (_label, cursor) => {
        const response = await get(`/audit-logs?cursor=${encodeURIComponent(cursor)}`);

        expect(response.status).toBe(400);
        expect(response.body.error.details).toEqual([
          { field: 'cursor', code: 'INVALID_CURSOR' },
        ]);
      },
      60_000,
    );

    /**
     * Who did what, from which address, is an ownership question — and the
     * trail carries personal data.
     */
    it('refuses an editor and a viewer', async () => {
      for (const role of ['editor', 'viewer']) {
        const email = `${NS}-${role}@example.com`;

        await request(app.getHttpServer())
          .post('/v1/auth/register')
          .send({ email, password: PASSWORD, name: role, tenantName: `${NS}-${role}` });
        await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [
          email,
        ]);
        await dataSource.query(
          `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
             JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
          [`${NS}-${role}`, email],
        );
        await dataSource.query(
          `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
              SET tm.tenantId = ?, tm.role = ? WHERE u.email = ?`,
          [tenantId, role, email],
        );

        const theirToken = (
          await request(app.getHttpServer())
            .post('/v1/auth/login')
            .send({ email, password: PASSWORD })
        ).body.data.accessToken as string;

        const response = await get('/audit-logs', theirToken);

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
      }
    }, 180_000);

    it('refuses an unauthenticated request', async () => {
      expect((await request(app.getHttpServer()).get('/v1/audit-logs')).status).toBe(401);
    }, 60_000);

    /**
     * A trail that leaked across tenants would be worse than none, because it
     * is trusted.
     *
     * Asserted against a **second tenant that actually has entries**. Checking
     * only that this tenant's rows come back cannot fail when no other tenant
     * has any — removing the scoping predicate passed that version of this
     * test, which is exactly the shape of hole this codebase keeps finding.
     */
    it('never shows another tenant’s entries', async () => {
      // A second workspace with a trail of its own.
      const otherEmail = `${NS}-other@example.com`;

      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({
          email: otherEmail,
          password: PASSWORD,
          name: 'other',
          tenantName: `${NS}-other`,
        });
      await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [
        otherEmail,
      ]);
      await dataSource.query(
        `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
           JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
        [`${NS}-other`, otherEmail],
      );

      const otherToken = (
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .send({ email: otherEmail, password: PASSWORD })
      ).body.data.accessToken as string;

      const [otherTenant] = await dataSource.query(
        `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
          WHERE u.email = ?`,
        [otherEmail],
      );

      // Give them a store and a set, so they have entries to leak.
      const otherStore = randomUUID();
      await dataSource.query(
        `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                             createdAt, updatedAt)
         VALUES (?, ?, 'woocommerce', 'theirs', ?, 'connected', 0, NOW(3), NOW(3))`,
        [otherStore, otherTenant.id, `https://${otherStore}.example.com`],
      );
      await request(app.getHttpServer())
        .post('/v1/option-sets')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ name: 'Theirs', storeId: otherStore });

      const [theirRows] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE tenantId = ?`,
        [otherTenant.id],
      );
      expect(Number(theirRows.n)).toBeGreaterThan(0);

      // Now read as the first tenant: none of theirs may appear.
      const mine = await get('/audit-logs?limit=100');
      const ids = mine.body.data.map((entry: { id: string }) => entry.id);

      const [leaked] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE id IN (?) AND tenantId <> ?`,
        [ids.length > 0 ? ids : ['0'], tenantId],
      );

      expect(Number(leaked.n)).toBe(0);

      // And the reverse: they see theirs, not ours.
      const theirs = await get('/audit-logs?limit=100', otherToken);
      expect(theirs.body.data.length).toBe(Number(theirRows.n));
    }, 180_000);
  });

  describe('actor, diff and IP — the three M7.6 names', () => {
    beforeAll(async () => {
      await exerciseEveryMutation();
    }, 240_000);

    it('stamps an actor on every row', async () => {
      const rows = await allRows();

      expect(rows.length).toBeGreaterThan(15);
      rows.forEach((row) => expect(row.userId).not.toBeNull());
    }, 60_000);

    it('stamps an IP on every row, packed to 16 bytes', async () => {
      const rows = await allRows();

      rows.forEach((row) => {
        expect(row.ip).not.toBeNull();
        expect(row.ip).toHaveLength(16);
      });
    }, 60_000);

    it('records a diff on every row', async () => {
      const rows = await allRows();

      rows.forEach((row) => {
        expect(row.changes).not.toBeNull();
        expect(Object.keys(row.changes as object).length).toBeGreaterThan(0);
      });
    }, 60_000);
  });
});
