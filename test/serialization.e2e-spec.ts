import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { createHarness, idOf, type Harness } from './harness';

/**
 * The serializer over HTTP, against real rows (M7.2b, step 7h).
 *
 * Unit tests build entities by hand; a database returns `null` where a literal
 * has `undefined`, strings where a column is `bigint`, and dates through a
 * driver. 7d's validator passed 48 unit tests while rejecting all 45 stored
 * rows — so both projections are asserted here against rows that made the round
 * trip through MySQL.
 */
describe('serialization (e2e)', () => {
  let harness: Harness;
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'ser7h';

  let token = '';
  let tokenB = '';
  let storeId = '';
  let setId = '';
  let groupId = '';
  let optionId = '';

  beforeAll(async () => {
    harness = await createHarness(NS);
    app = harness.app;
    dataSource = harness.dataSource;
    await harness.cleanup();

    token = await harness.tenant('a');
    tokenB = await harness.tenant('b');
    storeId = await harness.store('a');

    setId = idOf(await post('/option-sets', { name: 'Serialized', storeId }), 'set');
    groupId = idOf(
      await post(`/option-sets/${setId}/groups`, { label: 'Customization' }),
      'group',
    );
    optionId = idOf(
      await post(`/groups/${groupId}/options`, {
        key: 'print_placement',
        label: 'Print',
        presentation: 'radio',
        isRequired: true,
      }),
      'option',
    );
    idOf(
      await post(`/options/${optionId}/values`, {
        valueKey: 'front',
        label: 'Front',
        priceAmountMinor: 1000,
        isDefault: true,
      }),
      'value',
    );
    idOf(
      await post(`/options/${optionId}/values`, { valueKey: 'none', label: 'None' }),
      'value',
    );

    // The presentational-items API is Phase 14.
    await dataSource.query(
      `INSERT INTO presentational_items (id, optionGroupId, kind, content, sortOrder, display,
                                         createdAt, updatedAt, deletedAt)
       VALUES (?, ?, 'heading', 'Make it yours', 5, NULL, NOW(3), NOW(3),
               '1970-01-01 00:00:00.000')`,
      [randomUUID(), groupId],
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


  describe('authoring projection', () => {
    it('returns the whole tree in one request', async () => {
      const response = await get(`/option-sets/${setId}/detail`);

      expect(response.status).toBe(200);
      expect(response.body.data.groups).toHaveLength(1);
      expect(response.body.data.groups[0].options).toHaveLength(1);
      expect(response.body.data.groups[0].options[0].values).toHaveLength(2);
      expect(response.body.data.groups[0].items).toHaveLength(1);
    }, 60_000);

    /** What a database returns, not what a literal contains. */
    it('never exposes tenancy or the soft-delete sentinel', async () => {
      const body = JSON.stringify((await get(`/option-sets/${setId}/detail`)).body.data);

      expect(body).not.toContain('tenantId');
      expect(body).not.toContain('1970-01-01');
      expect(body).not.toContain('deletedAt');
    }, 60_000);

    it('orders children by sort order', async () => {
      const values = (await get(`/option-sets/${setId}/detail`)).body.data.groups[0].options[0]
        .values as Array<{ sortOrder: number }>;

      expect(values.map((value) => value.sortOrder)).toEqual(
        [...values.map((value) => value.sortOrder)].sort((a, b) => a - b),
      );
    }, 60_000);

    it('refuses another tenant’s set as a 404', async () => {
      expect((await get(`/option-sets/${setId}/detail`, tokenB)).status).toBe(404);
    }, 60_000);
  });

  describe('published projection', () => {
    it('returns the config document’s shape', async () => {
      const response = await get(`/option-sets/${setId}/preview`);

      expect(response.status).toBe(200);

      const group = response.body.data.groups[0];
      expect(group).toMatchObject({ label: 'Customization', display_type: 'inline' });

      const option = group.options[0];
      expect(option).toMatchObject({ key: 'print_placement', type: 'radio', is_required: true });

      const value = option.values.find((v: { value_key: string }) => v.value_key === 'front');
      expect(value.price_config).toEqual({ type: 'fixed', amount_minor: 1000 });
      expect(value.is_default).toBe(true);
    }, 60_000);

    /**
     * `price_amount_minor` is a `bigint` column. A driver that returned it as a
     * string would put `"1000"` in a document a PHP evaluator adds up.
     */
    it('keeps money an integer after the database round trip', async () => {
      const option = (await get(`/option-sets/${setId}/preview`)).body.data.groups[0].options[0];
      const amount = option.values.find(
        (v: { value_key: string }) => v.value_key === 'front',
      ).price_config.amount_minor;

      expect(typeof amount).toBe('number');
      expect(Number.isInteger(amount)).toBe(true);
    }, 60_000);

    it.each([
      ['tenancy', 'tenantId'],
      ['the row version', 'rowVersion'],
      ['audit timestamps', 'createdAt'],
      ['enable flags', 'isEnabled'],
      ['parent ids', 'optionGroupId'],
      ['the sentinel', '1970-01-01'],
    ])('omits %s', async (_label, needle) => {
      const body = JSON.stringify((await get(`/option-sets/${setId}/preview`)).body.data);

      expect(body).not.toContain(needle);
    }, 60_000);

    /** Dropped, not flagged — a flag is something every consumer must remember. */
    it('drops a disabled option', async () => {
      const group = idOf(
        await post(`/option-sets/${setId}/groups`, { label: 'Temporary' }),
        'group',
      );
      const option = idOf(
        await post(`/groups/${group}/options`, {
          key: 'seasonal',
          label: 'Seasonal',
          presentation: 'radio',
        }),
        'option',
      );

      const before = (await get(`/option-sets/${setId}/preview`)).body.data.groups.find(
        (g: { id: string }) => g.id === group,
      );
      expect(before.options).toHaveLength(1);

      await patch(`/options/${option}`, { isEnabled: false });

      const after = (await get(`/option-sets/${setId}/preview`)).body.data.groups.find(
        (g: { id: string }) => g.id === group,
      );
      expect(after.options).toHaveLength(0);

      // The editor still sees it: that is the difference between the two shapes.
      const authoring = (await get(`/option-sets/${setId}/detail`)).body.data.groups.find(
        (g: { id: string }) => g.id === group,
      );
      expect(authoring.options).toHaveLength(1);
      expect(authoring.options[0].isEnabled).toBe(false);
    }, 90_000);

    it('excludes a soft-deleted group from both projections', async () => {
      const group = idOf(await post(`/option-sets/${setId}/groups`, { label: 'Doomed' }), 'group');

      await request(app.getHttpServer())
        .delete(`/v1/groups/${group}`)
        .set('Authorization', `Bearer ${token}`);

      const published = (await get(`/option-sets/${setId}/preview`)).body.data;
      const authoring = (await get(`/option-sets/${setId}/detail`)).body.data;

      expect(published.groups.some((g: { id: string }) => g.id === group)).toBe(false);
      expect(authoring.groups.some((g: { id: string }) => g.id === group)).toBe(false);
    }, 90_000);

    /**
     * Empty until Phase 13 and Phase 17, and present from the first release so a
     * plugin never has to learn a key that appears later.
     */
    it('carries the full document envelope, including what is not built yet', async () => {
      const document = (await get(`/option-sets/${setId}/preview`)).body.data;

      expect(Object.keys(document).sort()).toEqual(['assignments', 'groups', 'id', 'rules', 'version']);
      expect(document.assignments).toEqual([]);
      expect(document.rules).toEqual([]);
    }, 60_000);

    /**
     * The stored JSON is camelCase because its schema is TypeScript; the
     * document is snake_case because its reader is PHP. A value priced through
     * `price_config` and one priced through the columns must not spell the same
     * field two ways in one document.
     */
    it('uses one spelling for every price, whichever path produced it', async () => {
      const group = idOf(await post(`/option-sets/${setId}/groups`, { label: 'Pricing' }), 'group');
      const option = idOf(
        await post(`/groups/${group}/options`, {
          key: 'priced',
          label: 'Priced',
          presentation: 'radio',
        }),
        'option',
      );

      idOf(
        await post(`/options/${option}/values`, {
          valueKey: 'from_columns',
          label: 'Columns',
          priceAmountMinor: 500,
        }),
        'value',
      );
      idOf(
        await post(`/options/${option}/values`, {
          valueKey: 'from_json',
          label: 'Json',
          priceConfig: { type: 'fixed', amountMinor: 250 },
        }),
        'value',
      );

      const published = (await get(`/option-sets/${setId}/preview`)).body.data;
      const values = published.groups.find((g: { id: string }) => g.id === group).options[0]
        .values as Array<{ value_key: string; price_config: Record<string, unknown> }>;

      expect(values).toHaveLength(2);
      values.forEach((value) => {
        expect(value.price_config).toHaveProperty('amount_minor');
        expect(value.price_config).not.toHaveProperty('amountMinor');
      });

      // And no camelCase anywhere in the document.
      expect(JSON.stringify(published)).not.toMatch(/"[a-z]+[A-Z][a-zA-Z]*":/);
    }, 90_000);

    it('refuses another tenant’s set as a 404', async () => {
      expect((await get(`/option-sets/${setId}/preview`, tokenB)).status).toBe(404);
    }, 60_000);
  });

  describe('round trip', () => {
    /**
     * Two rows sharing a `sort_order` is normal — a bulk reorder can assign the
     * same value, and nothing forbids it. Without a tie-break the storage engine
     * chooses, and a config document that differs between two builds of
     * unchanged data makes every snapshot diff ([7i]) untrustworthy.
     *
     * ⚠️ This asserts the *property*, and cannot currently fail: removing the
     * `id` tie-break from the loader still passes, because InnoDB returns these
     * rows in primary-key order regardless. The clause is kept because that is
     * a coincidence of the current query plan, not a guarantee — and this test
     * will start earning its place the moment a plan changes.
     */
    it('orders ties deterministically', async () => {
      const group = idOf(await post(`/option-sets/${setId}/groups`, { label: 'Ties' }), 'group');
      const first = idOf(
        await post(`/groups/${group}/options`, {
          key: 'tie_a',
          label: 'A',
          presentation: 'radio',
        }),
        'option',
      );
      const second = idOf(
        await post(`/groups/${group}/options`, {
          key: 'tie_b',
          label: 'B',
          presentation: 'radio',
        }),
        'option',
      );

      // Force the tie the sort order would otherwise break.
      await dataSource.query(`UPDATE options SET sortOrder = 0 WHERE id IN (?, ?)`, [
        first,
        second,
      ]);

      const reads = await Promise.all([
        get(`/option-sets/${setId}/preview`),
        get(`/option-sets/${setId}/preview`),
        get(`/option-sets/${setId}/preview`),
      ]);

      const orders = reads.map((read) =>
        read.body.data.groups
          .find((g: { id: string }) => g.id === group)
          .options.map((option: { key: string }) => option.key)
          .join(','),
      );

      expect(new Set(orders).size).toBe(1);
      // Ordered by id, which is UUIDv7 and therefore creation order.
      expect(orders[0]).toBe('tie_a,tie_b');
    }, 90_000);

    it('is byte-identical across two builds of unchanged data', async () => {
      const first = await get(`/option-sets/${setId}/preview`);
      const second = await get(`/option-sets/${setId}/preview`);

      expect(JSON.stringify(first.body.data)).toBe(JSON.stringify(second.body.data));
    }, 60_000);
  });
});
