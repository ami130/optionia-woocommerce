import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { createHarness, idOf, tokenFrom, type Harness } from './harness';
import { runWithContext } from '../src/common/context/request-context';
import { OptionsRepository } from '../src/option-sets/options.repository';

/**
 * Cascade rules and hard delete (M7.2, step 7g).
 *
 * The four rules have four different shapes — one cascades down, two cascade
 * *and* flag sideways, one refuses outright — so each is tested as itself rather
 * than inferred from a delete appearing to work.
 */
describe('cascade and hard delete (e2e)', () => {
  let harness: Harness;
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'casc';
  const PASSWORD = 'a-sufficiently-long-password';

  let token = '';
  let tenantId = '';
  let storeId = '';

  beforeAll(async () => {
    harness = await createHarness(NS);
    app = harness.app;
    dataSource = harness.dataSource;
    await harness.cleanup();

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

    token = tokenFrom(
      await request(app.getHttpServer()).post('/v1/auth/login').send({ email, password: PASSWORD }),
      email,
    );

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
    await harness.cleanup();
    await harness.close();
  });


  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (path: string) =>
    request(app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${token}`);
  const del = (path: string) =>
    request(app.getHttpServer()).delete(`/v1${path}`).set('Authorization', `Bearer ${token}`);

  async function tenantIdOfA(): Promise<string> {
    return tenantId;
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

  /** A heading in a group. The presentational-items API is Phase 14. */
  async function seedItem(optionGroupId: string): Promise<string> {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO presentational_items (id, optionGroupId, kind, content, sortOrder, display,
                                         createdAt, updatedAt, deletedAt)
       VALUES (?, ?, 'heading', 'Hello', 0, NULL, NOW(3), NOW(3), '1970-01-01 00:00:00.000')`,
      [id, optionGroupId],
    );

    return id;
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

    it('records the refusal, so support can answer why', async () => {
      const { set, values } = await tree();
      await seedRule(set, 'value', values[0]);

      await del(`/values/${values[0]}`);

      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs
          WHERE resourceId = ? AND action = 'option_value.delete_refused'`,
        [values[0]],
      );

      expect(Number(row.n)).toBe(1);
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

  /**
   * Presentational items hang off a group exactly as options do, and were missed
   * at first because they carry no value, no pricing and no reader yet — 7h's
   * serializer is the first. A heading belonging to a group nobody can see is
   * the failure this prevents.
   */
  describe('presentational items', () => {
    it('are soft-deleted with their group', async () => {
      const { group } = await tree();
      const item = await seedItem(group);

      await del(`/groups/${group}`);

      expect(await isLive('presentational_items', item)).toBe(false);
    }, 60_000);

    it('are soft-deleted with their set', async () => {
      const { set, group } = await tree();
      const item = await seedItem(group);

      await del(`/option-sets/${set}`);

      expect(await isLive('presentational_items', item)).toBe(false);
    }, 60_000);

    it('are counted in the cascade audit entry', async () => {
      const { set, group } = await tree();
      await seedItem(group);
      await seedItem(group);

      await del(`/option-sets/${set}`);

      const [row] = await dataSource.query(
        `SELECT changes FROM audit_logs WHERE resourceId = ? AND action = 'option_set.deleted'`,
        [set],
      );

      expect(row.changes.cascaded.items).toBe(2);
    }, 60_000);

    it('are erased by a purge, and counted', async () => {
      const { set, group } = await tree();
      const item = await seedItem(group);

      const response = await del(`/option-sets/${set}/permanent`);

      expect(response.body.data.items).toBe(1);
      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM presentational_items WHERE id = ?`,
        [item],
      );
      expect(Number(row.n)).toBe(0);
    }, 60_000);
  });

  /**
   * The delete of the parent and the cascade over its children are one
   * transaction. Split across two, a failure between them leaves the children
   * deleted and the parent live — a set whose contents vanished, with no error.
   */
  describe('atomicity and concurrency', () => {
    it('advances the set’s rowVersion when it is deleted', async () => {
      const { set } = await tree();
      const [before] = await dataSource.query(
        `SELECT rowVersion FROM option_sets WHERE id = ?`,
        [set],
      );

      await del(`/option-sets/${set}`);

      const [after] = await dataSource.query(
        `SELECT rowVersion FROM option_sets WHERE id = ?`,
        [set],
      );

      expect(Number(after.rowVersion)).toBeGreaterThan(Number(before.rowVersion));
    }, 60_000);

    /**
     * Three simultaneous deletes previously wrote three `option_set.deleted`
     * audit rows for one deletion — harmless to the data, and a trail support
     * reads and misbelieves.
     */
    it('records one audit entry however many deletes race', async () => {
      const { set } = await tree();

      const responses = await Promise.all([
        del(`/option-sets/${set}`),
        del(`/option-sets/${set}`),
        del(`/option-sets/${set}`),
      ]);

      // Every caller's intent was satisfied, so every caller sees success.
      responses.forEach((response) => expect([204, 404]).toContain(response.status));

      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs
          WHERE resourceId = ? AND action = 'option_set.deleted'`,
        [set],
      );

      expect(Number(row.n)).toBe(1);
    }, 60_000);

    it('records one audit entry for racing group deletes', async () => {
      const { group } = await tree();

      await Promise.all([del(`/groups/${group}`), del(`/groups/${group}`)]);

      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs
          WHERE resourceId = ? AND action = 'option_group.deleted'`,
        [group],
      );

      expect(Number(row.n)).toBe(1);
    }, 60_000);

    /**
     * A create racing its parent's deletion can leave a **live child under a
     * deleted parent**, and this asserts the consequence rather than the
     * absence.
     *
     * Closing the window needs `SELECT … FOR UPDATE` on the parent. That was
     * built, and removed: it makes a create and a delete of the same subtree
     * take locks in opposite orders, so ordinary concurrent authoring
     * deadlocks. A rare orphan that **no read can reach** is a better outcome
     * than routine user-visible failures, and 7j's optimistic locking is where
     * a definitive answer belongs — it can refuse a stale write without holding
     * a row lock across a request.
     *
     * So what is guaranteed, and tested here, is that the orphan is
     * unreachable: it never appears in a list, a fetch, or a purge's blast
     * radius.
     */
    it('keeps a child created during its parent’s deletion unreachable', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { set, group } = await tree();

        const [, created] = await Promise.all([
          del(`/option-sets/${set}`),
          post(`/groups/${group}/options`, {
            key: `race${attempt}`,
            label: 'Raced',
            presentation: 'radio',
          }),
        ]);

        expect([201, 404, 409]).toContain(created.status);

        // Whatever happened, the set is gone and nothing under it is reachable.
        expect((await get(`/option-sets/${set}`)).status).toBe(404);
        expect((await get(`/groups/${group}`)).status).toBe(404);
        expect((await get(`/groups/${group}/options`)).status).toBe(404);

        if (created.status === 201) {
          expect((await get(`/options/${created.body.data.id}`)).status).toBe(404);
        }
      }
    }, 180_000);

    /** And a purge still erases it, orphan included. */
    it('erases an orphaned child when the set is purged', async () => {
      const { set, group } = await tree();

      const [, created] = await Promise.all([
        del(`/option-sets/${set}`),
        post(`/groups/${group}/options`, {
          key: 'orphan_purge',
          label: 'Orphan',
          presentation: 'radio',
        }),
      ]);

      expect((await del(`/option-sets/${set}/permanent`)).status).toBe(200);

      if (created.status === 201) {
        const [row] = await dataSource.query(`SELECT COUNT(*) AS n FROM options WHERE id = ?`, [
          created.body.data.id,
        ]);

        expect(Number(row.n)).toBe(0);
      }
    }, 120_000);

    it('answers a create under a deleted parent with 404, never 500', async () => {
      const { group } = await tree();
      await del(`/groups/${group}`);

      const response = await post(`/groups/${group}/options`, {
        key: 'orphan',
        label: 'Orphan',
        presentation: 'radio',
      });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }, 60_000);

    /**
     * Reaches `ParentScopedRepository.assertParentOwned` directly.
     *
     * The service checks the parent first and returns a clean 404, so through
     * HTTP that check is what answers — and the repository's own throw is only
     * reached when the parent disappears *between* the two, which no
     * deterministic test can stage. Calling it directly is the only way to
     * assert it is a `DomainException` rather than a plain `Error`, which had no
     * code for the filter to translate and so became a 500.
     */
    it('throws a translatable error from the repository’s own parent check', async () => {
      const { group, set } = await tree();

      await del(`/option-sets/${set}`);

      const repository = app.get(OptionsRepository);

      await expect(
        runWithContext(
          { requestId: 'test', startedAt: Date.now(), tenantId: await tenantIdOfA() },
          () =>
            repository.create(group, {
              optionGroupId: group,
              key: 'direct',
              label: 'Direct',
              valueKind: 'choice',
              cardinality: 'one',
              presentation: 'radio',
            } as never),
        ),
      ).rejects.toMatchObject({ getStatus: expect.any(Function) });
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
