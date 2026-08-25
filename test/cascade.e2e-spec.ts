import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';

/**
 * Cascade rules and hard delete (M7.2, step 7g).
 *
 * The four rules have four different shapes — one cascades down, two cascade
 * *and* flag sideways, one refuses outright — so each is tested as itself rather
 * than inferred from a delete appearing to work.
 */
describe('cascade and hard delete (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'casc';
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

    const email = `${NS}-a@example.com`;

    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: NS, tenantName: NS });
    await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [email]);
    await dataSource.query(
      `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
         JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
      [`${NS}-a`, email],
    );

    token = (
      await request(app.getHttpServer()).post('/v1/auth/login').send({ email, password: PASSWORD })
    ).body.data.accessToken as string;

    const [row] = await dataSource.query(
      `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email = ?`,
      [email],
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
    const stores = `SELECT id FROM stores WHERE tenantId IN (${owned})`;

    await dataSource.query(`DELETE FROM audit_logs WHERE tenantId IN (${owned})`);
    await dataSource.query(
      `DELETE os FROM order_selections os JOIN order_events oe ON oe.id = os.orderEventId
        WHERE oe.storeId IN (${stores})`,
    );
    await dataSource.query(`DELETE FROM order_events WHERE storeId IN (${stores})`);
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
    await dataSource.query(
      `DELETE r FROM option_rules r JOIN option_sets s ON s.id = r.optionSetId
        WHERE s.tenantId IN (${owned})`,
    );
    await dataSource.query(
      `DELETE a FROM option_set_assignments a JOIN option_sets s ON s.id = a.optionSetId
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

  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (path: string) =>
    request(app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${token}`);
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

  /** A set with one group, one option and two values. */
  async function tree(): Promise<{
    set: string;
    group: string;
    option: string;
    values: [string, string];
  }> {
    const set = idOf(await post('/option-sets', { name: 'Tree', storeId }), 'set');
    const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'G' }), 'group');
    const option = idOf(
      await post(`/groups/${group}/options`, {
        key: `k${Date.now().toString(36)}`,
        label: 'O',
        presentation: 'radio',
      }),
      'option',
    );
    const first = idOf(await post(`/options/${option}/values`, { valueKey: 'a', label: 'A' }), 'value');
    const second = idOf(await post(`/options/${option}/values`, { valueKey: 'b', label: 'B' }), 'value');

    return { set, group, option, values: [first, second] };
  }

  /** A rule targeting something, written directly — the rules API is Phase 17. */
  async function seedRule(
    optionSetId: string,
    targetType: 'group' | 'option' | 'value',
    targetId: string,
    isEnabled = true,
  ): Promise<string> {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO option_rules (id, optionSetId, targetType, targetId, action, conditions,
                                 matchType, sortOrder, isEnabled, disabledReason,
                                 createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, 'hide', '{}', 'all', 0, ?, NULL, NOW(3), NOW(3),
               '1970-01-01 00:00:00.000')`,
      [id, optionSetId, targetType, targetId, isEnabled ? 1 : 0],
    );

    return id;
  }

  async function ruleRow(
    id: string,
  ): Promise<{ isEnabled: number; disabledReason: string | null }> {
    const [row] = await dataSource.query(
      `SELECT isEnabled, disabledReason FROM option_rules WHERE id = ?`,
      [id],
    );

    return row;
  }

  async function isLive(table: string, id: string): Promise<boolean> {
    const [row] = await dataSource.query(
      `SELECT deletedAt = '1970-01-01 00:00:00.000' AS live FROM \`${table}\` WHERE id = ?`,
      [id],
    );

    return Boolean(row && Number(row.live) === 1);
  }

  describe('delete option_set', () => {
    it('soft-deletes groups, options, values, rules and assignments', async () => {
      const { set, group, option, values } = await tree();
      const rule = await seedRule(set, 'option', option);
      const assignment = randomUUID();

      await dataSource.query(
        `INSERT INTO option_set_assignments (id, optionSetId, mode, targetType, targetRef,
                                             priority, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'all', NULL, NULL, 0, NOW(3), NOW(3), '1970-01-01 00:00:00.000')`,
        [assignment, set],
      );

      expect((await del(`/option-sets/${set}`)).status).toBe(204);

      expect(await isLive('option_groups', group)).toBe(false);
      expect(await isLive('options', option)).toBe(false);
      expect(await isLive('option_values', values[0])).toBe(false);
      expect(await isLive('option_values', values[1])).toBe(false);
      expect(await isLive('option_rules', rule)).toBe(false);
      expect(await isLive('option_set_assignments', assignment)).toBe(false);
    }, 60_000);

    it('records what the cascade touched', async () => {
      const { set } = await tree();

      await del(`/option-sets/${set}`);

      const [row] = await dataSource.query(
        `SELECT changes FROM audit_logs WHERE resourceId = ? AND action = 'option_set.deleted'`,
        [set],
      );

      expect(row.changes.cascaded).toMatchObject({ groups: 1, options: 1, values: 2 });
    }, 60_000);
  });

  describe('delete group', () => {
    it('soft-deletes its options and their values', async () => {
      const { group, option, values } = await tree();

      expect((await del(`/groups/${group}`)).status).toBe(204);

      expect(await isLive('options', option)).toBe(false);
      expect(await isLive('option_values', values[0])).toBe(false);
    }, 60_000);

    it('disables and flags a rule targeting the group', async () => {
      const { set, group } = await tree();
      const rule = await seedRule(set, 'group', group);

      await del(`/groups/${group}`);

      const row = await ruleRow(rule);

      expect(Number(row.isEnabled)).toBe(0);
      expect(row.disabledReason).toBe('target_deleted');
      // Disabled, not deleted: it is work the merchant did.
      expect(await isLive('option_rules', rule)).toBe(true);
    }, 60_000);

    it('disables rules targeting options and values inside the group', async () => {
      const { set, group, option, values } = await tree();
      const onOption = await seedRule(set, 'option', option);
      const onValue = await seedRule(set, 'value', values[0]);

      await del(`/groups/${group}`);

      expect(Number((await ruleRow(onOption)).isEnabled)).toBe(0);
      expect(Number((await ruleRow(onValue)).isEnabled)).toBe(0);
    }, 60_000);

    /** Overwriting the reason would misreport who disabled it. */
    it('leaves a rule the merchant already disabled untouched', async () => {
      const { set, group } = await tree();
      const rule = await seedRule(set, 'group', group, false);

      await del(`/groups/${group}`);

      expect((await ruleRow(rule)).disabledReason).toBeNull();
    }, 60_000);
  });

  describe('delete option', () => {
    it('soft-deletes its values and disables rules referencing it', async () => {
      const { set, option, values } = await tree();
      const rule = await seedRule(set, 'option', option);

      expect((await del(`/options/${option}`)).status).toBe(204);

      expect(await isLive('option_values', values[0])).toBe(false);
      expect(Number((await ruleRow(rule)).isEnabled)).toBe(0);
    }, 60_000);

    /**
     * Deleting the option is an unambiguous instruction about the whole thing,
     * so a rule targeting one of its values is disabled rather than blocking.
     */
    it('disables a rule targeting one of its values', async () => {
      const { set, option, values } = await tree();
      const rule = await seedRule(set, 'value', values[0]);

      expect((await del(`/options/${option}`)).status).toBe(204);
      expect(Number((await ruleRow(rule)).isEnabled)).toBe(0);
    }, 60_000);
  });

  describe('delete value', () => {
    /**
     * The one rule that refuses. Disabling the rule instead would silently
     * change what the storefront shows.
     */
    it('is blocked when an enabled rule targets it', async () => {
      const { set, values } = await tree();
      await seedRule(set, 'value', values[0]);

      const response = await del(`/values/${values[0]}`);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(await isLive('option_values', values[0])).toBe(true);
    }, 60_000);

    it('is allowed when the rule targeting it is disabled', async () => {
      const { set, values } = await tree();
      await seedRule(set, 'value', values[0], false);

      expect((await del(`/values/${values[0]}`)).status).toBe(204);
    }, 60_000);

    it('is allowed when no rule targets it', async () => {
      const { values } = await tree();

      expect((await del(`/values/${values[1]}`)).status).toBe(204);
    }, 60_000);

    it('is not blocked by a rule targeting a different value', async () => {
      const { set, values } = await tree();
      await seedRule(set, 'value', values[0]);

      expect((await del(`/values/${values[1]}`)).status).toBe(204);
    }, 60_000);
  });

  describe('hard delete', () => {
    /** An order line naming an option key that no longer exists. */
    async function seedOrder(optionKey: string): Promise<void> {
      const eventId = randomUUID();

      await dataSource.query(
        `INSERT INTO order_events (id, storeId, externalOrderId, orderTotalMinor, currency,
                                   optionRevenueMinor, occurredAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 1000, 'GBP', 0, NOW(3), NOW(3), NOW(3))`,
        [eventId, storeId, randomUUID().slice(0, 12)],
      );
      await dataSource.query(
        `INSERT INTO order_selections (id, orderEventId, optionKey, optionLabel, valueKey,
                                       valueLabel, priceDeltaMinor, configVersion,
                                       createdAt, updatedAt)
         VALUES (?, ?, ?, 'Label', 'a', 'A', 0, 1, NOW(3), NOW(3))`,
        [randomUUID(), eventId, optionKey],
      );
    }

    it('erases the set and everything under it', async () => {
      const { set, group, option, values } = await tree();
      const rule = await seedRule(set, 'option', option);

      const response = await del(`/option-sets/${set}/permanent`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ groups: 1, options: 1, values: 2, rules: 1 });

      const [remaining] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM option_sets WHERE id = ?`,
        [set],
      );
      expect(Number(remaining.n)).toBe(0);
      for (const [table, id] of [
        ['option_groups', group],
        ['options', option],
        ['option_values', values[0]],
        ['option_rules', rule],
      ] as const) {
        const [row] = await dataSource.query(
          `SELECT COUNT(*) AS n FROM \`${table}\` WHERE id = ?`,
          [id],
        );
        expect(Number(row.n)).toBe(0);
      }
    }, 60_000);

    /** The protection ADR-016 leaves to this check. */
    it('refuses when an order ever referenced one of its option keys', async () => {
      const { set, option } = await tree();
      const [row] = await dataSource.query(`SELECT \`key\` FROM options WHERE id = ?`, [option]);
      await seedOrder(row.key as string);

      const response = await del(`/option-sets/${set}/permanent`);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(await isLive('option_sets', set)).toBe(true);
    }, 60_000);

    /**
     * A two-step delete must not erase what a one-step delete refuses: the
     * option is already soft-deleted when the purge is attempted.
     */
    it('still refuses after the referenced option was soft-deleted', async () => {
      const { set, option } = await tree();
      const [row] = await dataSource.query(`SELECT \`key\` FROM options WHERE id = ?`, [option]);
      await seedOrder(row.key as string);
      await del(`/options/${option}`);

      expect((await del(`/option-sets/${set}/permanent`)).status).toBe(409);
    }, 60_000);

    /**
     * The set's children are already soft-deleted when the purge runs — which is
     * the normal path, since deleting the set cascades to them first.
     *
     * A purge that only saw live rows would leave every child behind: the parent
     * row would go and its groups, options and values would remain, unreachable
     * and unerasable. Mutating `withDeleted` proved nothing tested this.
     */
    it('erases children that were already soft-deleted', async () => {
      const { set, group, option, values } = await tree();

      // Cascades: group, option and values are all soft-deleted after this.
      await del(`/option-sets/${set}`);

      expect((await del(`/option-sets/${set}/permanent`)).status).toBe(200);

      for (const [table, id] of [
        ['option_groups', group],
        ['options', option],
        ['option_values', values[0]],
        ['option_values', values[1]],
      ] as const) {
        const [row] = await dataSource.query(
          `SELECT COUNT(*) AS n FROM \`${table}\` WHERE id = ?`,
          [id],
        );

        expect(Number(row.n)).toBe(0);
      }
    }, 60_000);

    it('purges a soft-deleted set', async () => {
      const { set } = await tree();
      await del(`/option-sets/${set}`);

      expect((await del(`/option-sets/${set}/permanent`)).status).toBe(200);
    }, 60_000);

    it('is not blocked by an order in another store', async () => {
      const { set, option } = await tree();
      const [row] = await dataSource.query(`SELECT \`key\` FROM options WHERE id = ?`, [option]);

      const otherStore = randomUUID();
      await dataSource.query(
        `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                             createdAt, updatedAt)
         VALUES (?, ?, 'woocommerce', 'other', ?, 'connected', 0, NOW(3), NOW(3))`,
        [otherStore, tenantId, `https://${otherStore}.example.com`],
      );

      const eventId = randomUUID();
      await dataSource.query(
        `INSERT INTO order_events (id, storeId, externalOrderId, orderTotalMinor, currency,
                                   optionRevenueMinor, occurredAt, createdAt, updatedAt)
         VALUES (?, ?, ?, 1000, 'GBP', 0, NOW(3), NOW(3), NOW(3))`,
        [eventId, otherStore, randomUUID().slice(0, 12)],
      );
      await dataSource.query(
        `INSERT INTO order_selections (id, orderEventId, optionKey, optionLabel, valueKey,
                                       valueLabel, priceDeltaMinor, configVersion,
                                       createdAt, updatedAt)
         VALUES (?, ?, ?, 'Label', 'a', 'A', 0, 1, NOW(3), NOW(3))`,
        [randomUUID(), eventId, row.key],
      );

      expect((await del(`/option-sets/${set}/permanent`)).status).toBe(200);
    }, 60_000);

    it('refuses another tenant’s set as a 404', async () => {
      expect((await del(`/option-sets/${randomUUID()}/permanent`)).status).toBe(404);
    }, 60_000);
  });

  describe('reads after a cascade', () => {
    it('hides everything under a deleted set', async () => {
      const { set, group, option } = await tree();

      await del(`/option-sets/${set}`);

      expect((await get(`/option-sets/${set}`)).status).toBe(404);
      expect((await get(`/groups/${group}`)).status).toBe(404);
      expect((await get(`/options/${option}`)).status).toBe(404);
    }, 60_000);
  });
});
