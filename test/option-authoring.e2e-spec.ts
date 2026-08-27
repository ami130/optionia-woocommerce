import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';

/**
 * Group, option and value authoring over HTTP (M7.2, M7.3).
 *
 * **Two tenants throughout.** None of these paths names a tenant — `/values/:id`
 * reaches one through three joins — so a suite using a single tenant proves
 * nothing about the scoping that is the entire point of the parent-scoped
 * repository.
 */
describe('option authoring (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'oauth7f';
  const PASSWORD = 'a-sufficiently-long-password';

  let tokenA = '';
  let tokenB = '';
  let setA = '';

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

    tokenA = await tenant('a');
    tokenB = await tenant('b');
    setA = await seedSet('a');
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  async function cleanup(): Promise<void> {
    const owned = `SELECT id FROM tenants WHERE slug LIKE '${NS}-%'`;

    await dataSource.query(`DELETE FROM audit_logs WHERE tenantId IN (${owned})`);
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

    return row.id as string;
  }

  async function seedSet(which: string): Promise<string> {
    const tenantId = await tenantIdOf(which);
    const storeId = randomUUID();
    const setId = randomUUID();

    await dataSource.query(
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                           createdAt, updatedAt)
       VALUES (?, ?, 'woocommerce', ?, ?, 'connected', 0, NOW(3), NOW(3))`,
      // The URL is unique per tenant (`uq_stores_tenant_url`), and this helper is
      // called repeatedly to give a test a set of its own — so the store id makes
      // it distinct rather than a fixed hostname.
      [storeId, tenantId, which, `https://${which}-${storeId}.example.com`],
    );
    await dataSource.query(
      `INSERT INTO option_sets (id, tenantId, storeId, name, status, version, rowVersion,
                                publishedConfigVersion, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, 'draft', 1, 1, 0, NOW(3), NOW(3), '1970-01-01 00:00:00.000')`,
      [setId, tenantId, storeId, `${which} set`],
    );

    return setId;
  }

  const post = (token: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const patch = (token: string, path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (token: string, path: string) =>
    request(app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${token}`);
  const del = (token: string, path: string) =>
    request(app.getHttpServer()).delete(`/v1${path}`).set('Authorization', `Bearer ${token}`);

  /** A fresh group in tenant A's set. */
  /**
   * Fixture builders that **fail loudly**.
   *
   * Reading `.body.data.id` without checking the status returns `undefined`
   * when a create fails, and the test then runs against a parent that does not
   * exist — where a duplicate key genuinely does not collide, because the two
   * rows are attached to different (missing) parents. That turns a fixture
   * problem into a false assertion about the product, which is how an
   * intermittent "duplicate value key returned 201" reached this suite.
   */
  function idOf(response: request.Response, what: string): string {
    if (response.status !== 201) {
      throw new Error(
        `Fixture failed to create a ${what}: ${response.status} ` +
          `${JSON.stringify(response.body?.error ?? response.body)}`,
      );
    }

    return response.body.data.id as string;
  }

  /**
   * Create a fixture and insist it worked.
   *
   * `await post(...)` without checking the status lets a 409 — which a
   * concurrent writer can legitimately produce — silently reduce a fixture. A
   * duplicate test then copies one value instead of two and reports a product
   * defect that is really a missing row.
   */
  async function mustCreate(path: string, body: object, what: string): Promise<string> {
    return idOf(await post(tokenA, path, body), what);
  }

  async function newGroup(label = 'Group'): Promise<string> {
    const response = await post(tokenA, `/option-sets/${setA}/groups`, { label });

    /**
     * A 404 here means the parent set is not visible, which is the one failure
     * this helper cannot diagnose from the response alone. Reported with the
     * set's actual state, because "creating a group returned 404" and "the set
     * it belongs to was deleted" are very different problems and only the second
     * is actionable.
     *
     * Added after an intermittent cross-suite failure (roughly one run in six)
     * that the plain message could not explain.
     */
    if (response.status === 404) {
      const [row] = await dataSource.query(
        `SELECT status, deletedAt, tenantId FROM option_sets WHERE id = ?`,
        [setA],
      );

      throw new Error(
        `Fixture failed to create a group: the set ${setA} is not visible. ` +
          `Row: ${row ? JSON.stringify(row) : 'MISSING ENTIRELY'}`,
      );
    }

    return idOf(response, 'group');
  }

  async function newOption(groupId: string, key: string): Promise<string> {
    return idOf(
      await post(tokenA, `/groups/${groupId}/options`, {
        key,
        label: 'Print placement',
        presentation: 'radio',
      }),
      'option',
    );
  }

  describe('groups', () => {
    it('creates a group appended to the end of the set', async () => {
      const first = await post(tokenA, `/option-sets/${setA}/groups`, { label: 'First' });
      const second = await post(tokenA, `/option-sets/${setA}/groups`, { label: 'Second' });

      expect(first.status).toBe(201);
      expect(second.body.data.sortOrder).toBeGreaterThan(first.body.data.sortOrder);
    }, 30_000);

    it('defaults display type, collapsibility and enabled state', async () => {
      const created = await post(tokenA, `/option-sets/${setA}/groups`, { label: 'Defaults' });

      expect(created.body.data.displayType).toBe('inline');
      expect(created.body.data.isCollapsible).toBe(false);
      expect(created.body.data.isEnabled).toBe(true);
    }, 30_000);

    it('renames and disables a group', async () => {
      const id = await newGroup('Before');
      const updated = await patch(tokenA, `/groups/${id}`, {
        label: 'After',
        isEnabled: false,
      });

      expect(updated.body.data.label).toBe('After');
      expect(updated.body.data.isEnabled).toBe(false);
    }, 30_000);

    it('lists a set’s groups in sort order', async () => {
      const set = await seedSetForA();
      await mustCreate(`/option-sets/${set}/groups`, { label: 'One' }, 'group');
      await mustCreate(`/option-sets/${set}/groups`, { label: 'Two' }, 'group');

      const listed = await get(tokenA, `/option-sets/${set}/groups`);
      const orders = listed.body.data.map((g: { sortOrder: number }) => g.sortOrder);

      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(listed.body.data).toHaveLength(2);
    }, 30_000);

    it('soft-deletes a group and hides it from the list', async () => {
      const set = await seedSetForA();
      const id = (await post(tokenA, `/option-sets/${set}/groups`, { label: 'Doomed' })).body.data
        .id as string;

      expect((await del(tokenA, `/groups/${id}`)).status).toBe(204);
      expect((await get(tokenA, `/groups/${id}`)).status).toBe(404);
      expect((await get(tokenA, `/option-sets/${set}/groups`)).body.data).toHaveLength(0);
    }, 30_000);

    it('rejects an empty label', async () => {
      const response = await post(tokenA, `/option-sets/${setA}/groups`, { label: '' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }, 30_000);
  });

  /** A set of tenant A's own, so a list assertion is not disturbed by other tests. */
  async function seedSetForA(): Promise<string> {
    return seedSet('a');
  }

  describe('options', () => {
    it('creates an option and fills the axes from the registry', async () => {
      const group = await newGroup();
      const created = await post(tokenA, `/groups/${group}/options`, {
        key: 'placement',
        label: 'Placement',
        presentation: 'radio',
      });

      expect(created.status).toBe(201);
      // The registry says radio is choice/one. A caller that does not say so
      // must still get a row the evaluator can interpret.
      expect(created.body.data.valueKind).toBe('choice');
      expect(created.body.data.cardinality).toBe('one');
    }, 30_000);

    it('refuses an unregistered option type', async () => {
      const group = await newGroup();
      const response = await post(tokenA, `/groups/${group}/options`, {
        key: 'k',
        label: 'Nope',
        presentation: 'colour_swatch',
      });

      expect(response.status).toBe(400);
    }, 30_000);

    it('refuses axes that contradict the type', async () => {
      const group = await newGroup();
      const response = await post(tokenA, `/groups/${group}/options`, {
        key: 'k',
        label: 'Contradiction',
        presentation: 'radio',
        cardinality: 'many',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }, 30_000);

    it('refuses a duplicate key in one group', async () => {
      const group = await newGroup();
      await newOption(group, 'same_key');

      const second = await post(tokenA, `/groups/${group}/options`, {
        key: 'same_key',
        label: 'Second',
        presentation: 'radio',
      });

      expect(second.status).toBe(400);
      expect(second.body.error.details[0].code).toBe('DUPLICATE_KEY');
    }, 30_000);

    it('allows the same key in a different group', async () => {
      const one = await newGroup('One');
      const two = await newGroup('Two');
      await newOption(one, 'shared_key');

      expect((await post(tokenA, `/groups/${two}/options`, {
        key: 'shared_key',
        label: 'Elsewhere',
        presentation: 'radio',
      })).status).toBe(201);
    }, 30_000);

    /** `uq_options_group_key` includes `deletedAt`, so a delete frees the key. */
    it('frees a key for reuse after a soft delete', async () => {
      const group = await newGroup();
      const id = await newOption(group, 'recycled');
      await del(tokenA, `/options/${id}`);

      expect((await post(tokenA, `/groups/${group}/options`, {
        key: 'recycled',
        label: 'Reused',
        presentation: 'radio',
      })).status).toBe(201);
    }, 30_000);

    it('does not accept a key change', async () => {
      const group = await newGroup();
      const id = await newOption(group, 'immutable');

      const response = await patch(tokenA, `/options/${id}`, { key: 'changed' });

      // `forbidNonWhitelisted` rejects it: order meta stores `option_key`, so a
      // key that can change makes historic orders unreadable (M7.2).
      expect(response.status).toBe(400);
    }, 30_000);
  });

  describe('option type validation (M7.3)', () => {
    /** The acceptance M7.3 asks for, at the boundary it names. */
    it('rejects a malformed pricing config on a value', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'priced');

      const response = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'bad',
        label: 'Bad',
        priceConfig: { type: 'fixed' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }, 30_000);

    it('accepts a well-formed fixed price', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'priced_ok');

      const response = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'good',
        label: 'Good',
        priceConfig: { type: 'fixed', amountMinor: 1000 },
      });

      expect(response.status).toBe(201);
    }, 30_000);

    it('rejects an unknown pricing type', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'priced_unknown');

      const response = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'weird',
        label: 'Weird',
        priceConfig: { type: 'interpretive_dance', amountMinor: 1 },
      });

      expect(response.status).toBe(400);
    }, 30_000);

    /** Money is integer minor units (ADR-013). A float is not a price. */
    it('rejects a fractional price amount', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'fractional');

      const response = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'half',
        label: 'Half',
        priceAmountMinor: 10.5,
      });

      expect(response.status).toBe(400);
    }, 30_000);
  });

  describe('values', () => {
    it('creates a value with a default price of zero', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'valued');
      const created = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'none',
        label: 'None',
      });

      expect(created.status).toBe(201);
      expect(created.body.data.priceAmountMinor).toBe(0);
      expect(created.body.data.priceType).toBe('fixed');
    }, 30_000);

    it('refuses a duplicate value key on one option', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'dupes');
      // Asserted, not assumed: if the first create fails the second cannot
      // collide with it, and the test would "pass" against a missing parent.
      expect(
        (await post(tokenA, `/options/${option}/values`, { valueKey: 'red', label: 'Red' })).status,
      ).toBe(201);

      const second = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'red',
        label: 'Red again',
      });

      expect(second.status).toBe(400);
      expect(second.body.error.details[0].code).toBe('DUPLICATE_KEY');
    }, 30_000);

    /**
     * Two defaults on one radio would pre-select two mutually exclusive choices,
     * which is not a state a storefront can render.
     */
    it('keeps at most one default per option', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'defaults');
      await post(tokenA, `/options/${option}/values`, {
        valueKey: 'first',
        label: 'First',
        isDefault: true,
      });
      await post(tokenA, `/options/${option}/values`, {
        valueKey: 'second',
        label: 'Second',
        isDefault: true,
      });

      const listed = await get(tokenA, `/options/${option}/values`);
      const defaults = listed.body.data.filter((v: { isDefault: boolean }) => v.isDefault);

      expect(defaults).toHaveLength(1);
      expect(defaults[0].valueKey).toBe('second');
    }, 30_000);

    it('accepts a negative price as a discount', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'discounted');

      const created = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'less',
        label: 'Less',
        priceAmountMinor: -500,
      });

      expect(created.status).toBe(201);
      expect(created.body.data.priceAmountMinor).toBe(-500);
    }, 30_000);

    it('rejects a malformed colour', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'coloured');

      expect((await post(tokenA, `/options/${option}/values`, {
        valueKey: 'c',
        label: 'C',
        colorHex: 'red',
      })).status).toBe(400);
    }, 30_000);
  });

  describe('duplicate', () => {
    it('deep-copies a group with its options and values', async () => {
      const group = await newGroup('Original');
      const option = await newOption(group, 'copied');
      await mustCreate(`/options/${option}/values`, { valueKey: 'a', label: 'A' }, 'value');
      await mustCreate(`/options/${option}/values`, { valueKey: 'b', label: 'B' }, 'value');

      const copy = await post(tokenA, `/groups/${group}/duplicate`);

      expect(copy.status).toBe(201);
      expect(copy.body.data.label).toBe('Original (copy)');

      const copiedOptions = await get(tokenA, `/groups/${copy.body.data.id}/options`);
      expect(copiedOptions.body.data).toHaveLength(1);

      const copiedValues = await get(
        tokenA,
        `/options/${copiedOptions.body.data[0].id}/values`,
      );
      expect(copiedValues.body.data).toHaveLength(2);
    }, 60_000);

    /** A copy lands in the same group, where the key must not repeat. */
    it('gives a duplicated option a free key', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'twin');

      const copy = await post(tokenA, `/options/${option}/duplicate`);

      expect(copy.status).toBe(201);
      expect(copy.body.data.key).toBe('twin-copy');
    }, 30_000);

    it('copies an option’s values', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'with_values');
      await mustCreate(`/options/${option}/values`, { valueKey: 'x', label: 'X' }, 'value');

      const copy = await post(tokenA, `/options/${option}/duplicate`);
      const values = await get(tokenA, `/options/${copy.body.data.id}/values`);

      expect(values.body.data).toHaveLength(1);
      expect(values.body.data[0].valueKey).toBe('x');
    }, 30_000);

    it('keeps a disabled group disabled in the copy', async () => {
      const group = await newGroup('Disabled');
      await patch(tokenA, `/groups/${group}`, { isEnabled: false });

      const copy = await post(tokenA, `/groups/${group}/duplicate`);

      expect(copy.body.data.isEnabled).toBe(false);
    }, 30_000);
  });

  /**
   * M7.2's lifecycle table is inherited by every level. Duplicate was built for
   * groups and options and missed for values; reorder was built for groups
   * only — so a merchant could rearrange groups but not the options inside one,
   * nor the values a customer reads in order.
   */
  describe('the lifecycle set, at every level', () => {
    it('duplicates a value within its option', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'dup_values');
      const value = idOf(
        await post(tokenA, `/options/${option}/values`, {
          valueKey: 'red',
          label: 'Red',
          priceAmountMinor: 500,
        }),
        'value',
      );

      const copy = await post(tokenA, `/values/${value}/duplicate`);

      expect(copy.status).toBe(201);
      expect(copy.body.data.valueKey).toBe('red-copy');
      expect(copy.body.data.label).toBe('Red (copy)');
      // Everything else is carried across.
      expect(copy.body.data.priceAmountMinor).toBe(500);
    }, 60_000);

    /** Two defaults on one option is a state no storefront can render. */
    it('never lets a copy claim the default', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'dup_default');
      const value = idOf(
        await post(tokenA, `/options/${option}/values`, {
          valueKey: 'only',
          label: 'Only',
          isDefault: true,
        }),
        'value',
      );

      const copy = await post(tokenA, `/values/${value}/duplicate`);

      expect(copy.body.data.isDefault).toBe(false);

      const values = await get(tokenA, `/options/${option}/values`);
      expect(
        values.body.data.filter((v: { isDefault: boolean }) => v.isDefault),
      ).toHaveLength(1);
    }, 60_000);

    it('accepts an explicit key for the copy', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'dup_named');
      const value = idOf(
        await post(tokenA, `/options/${option}/values`, { valueKey: 'a', label: 'A' }),
        'value',
      );

      const copy = await post(tokenA, `/values/${value}/duplicate`, { valueKey: 'b' });

      expect(copy.body.data.valueKey).toBe('b');
    }, 60_000);

    it('reorders options within a group', async () => {
      const group = await newGroup();
      const first = await newOption(group, 'first');
      const second = await newOption(group, 'second');

      const response = await post(tokenA, `/groups/${group}/reorder`, {
        options: [
          { id: second, sortOrder: 10 },
          { id: first, sortOrder: 20 },
        ],
      });

      expect(response.status).toBe(201);

      const listed = await get(tokenA, `/groups/${group}/options`);
      expect(listed.body.data.map((o: { id: string }) => o.id)).toEqual([second, first]);
    }, 60_000);

    it('reorders values within an option', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'ordered_values');
      const small = idOf(
        await post(tokenA, `/options/${option}/values`, { valueKey: 's', label: 'Small' }),
        'value',
      );
      const large = idOf(
        await post(tokenA, `/options/${option}/values`, { valueKey: 'l', label: 'Large' }),
        'value',
      );

      await post(tokenA, `/options/${option}/reorder`, {
        values: [
          { id: large, sortOrder: 10 },
          { id: small, sortOrder: 20 },
        ],
      });

      const listed = await get(tokenA, `/options/${option}/values`);
      expect(listed.body.data.map((v: { id: string }) => v.id)).toEqual([large, small]);
    }, 60_000);

    /** A partial reorder leaves an arrangement nobody asked for. */
    it.each([
      ['options', 'groups', 'options'],
      ['values', 'options', 'values'],
    ])('refuses a whole %s reorder when an id is foreign', async (_label, parent, field) => {
      const group = await newGroup();
      const option = await newOption(group, `foreign_${field}`);
      const value = idOf(
        await post(tokenA, `/options/${option}/values`, { valueKey: 'v', label: 'V' }),
        'value',
      );

      const path = parent === 'groups' ? `/groups/${group}/reorder` : `/options/${option}/reorder`;
      const mine = parent === 'groups' ? option : value;

      const response = await post(tokenA, path, {
        [field]: [
          { id: mine, sortOrder: 999 },
          { id: randomUUID(), sortOrder: 1 },
        ],
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }, 90_000);
  });

  describe('reorder', () => {
    it('applies new sort orders in one request', async () => {
      const set = await seedSetForA();
      const one = (await post(tokenA, `/option-sets/${set}/groups`, { label: 'One' })).body.data
        .id as string;
      const two = (await post(tokenA, `/option-sets/${set}/groups`, { label: 'Two' })).body.data
        .id as string;

      const response = await post(tokenA, `/option-sets/${set}/reorder`, {
        groups: [
          { id: two, sortOrder: 10 },
          { id: one, sortOrder: 20 },
        ],
      });

      expect(response.status).toBe(201);
      const listed = await get(tokenA, `/option-sets/${set}/groups`);
      expect(listed.body.data.map((g: { id: string }) => g.id)).toEqual([two, one]);
    }, 60_000);

    /**
     * A partial reorder leaves an order the merchant did not ask for and cannot
     * easily undo, so an unknown id fails the whole request.
     */
    it('rejects the whole request when an id is not in the set', async () => {
      const set = await seedSetForA();
      const foreignSet = await seedSet('b');
      const foreignGroupId = idOf(
        await post(tokenB, `/option-sets/${foreignSet}/groups`, { label: 'Theirs' }),
        'foreign group',
      );
      const mine = (await post(tokenA, `/option-sets/${set}/groups`, { label: 'Mine' })).body.data
        .id as string;
      const before = (await get(tokenA, `/option-sets/${set}/groups`)).body.data[0].sortOrder;

      const response = await post(tokenA, `/option-sets/${set}/reorder`, {
        groups: [
          { id: mine, sortOrder: 999 },
          { id: foreignGroupId, sortOrder: 1 },
        ],
      });

      expect(response.status).toBe(400);
      const after = (await get(tokenA, `/option-sets/${set}/groups`)).body.data[0].sortOrder;
      expect(after).toBe(before);
    }, 60_000);
  });

  /**
   * The claim the parent-scoped repository exists to make. Every one of these is
   * a 404 rather than a 403: a 403 confirms the resource exists (ADR-010).
   *
   * **Each probe builds its own fixtures.** Sharing them made these tests mask
   * each other: with scoping deliberately broken, the `DELETE /groups/:id` probe
   * *succeeded* and soft-deleted the shared group, so every later probe met a
   * genuinely deleted parent and returned 404 for the wrong reason. Eleven of
   * fifteen kept passing against unscoped code — proving nothing while looking
   * thorough.
   */
  describe('tenant isolation', () => {
    /** A fresh group/option/value owned by tenant B. */
    async function foreign(): Promise<{ group: string; option: string; value: string }> {
      const set = await seedSet('b');
      // `idOf` rather than reading `.body.data.id`: a create can be answered 409
      // when a concurrent writer deadlocks, and an `undefined` id would send the
      // probe to `/values/undefined` — a 400 that looks like an isolation
      // failure and is not one.
      const groupResponse = await post(tokenB, `/option-sets/${set}/groups`, { label: 'B group' });

      /**
       * Diagnostics kept deliberately.
       *
       * This create has been seen to answer 404 roughly once in eight full runs
       * — the set exists, the token is tenant B's, and the API cannot see it.
       * It has not reproduced under instrumentation, so rather than guess at a
       * cause the failure now prints the state that would identify one: whose
       * tenant owns the set, whether it is deleted, and which tenant the member
       * belongs to. A rare failure that explains itself is worth more than a
       * rare failure someone has to reproduce first.
       */
      if (groupResponse.status !== 201) {
        const [row] = await dataSource.query(
          `SELECT tenantId, deletedAt FROM option_sets WHERE id = ?`,
          [set],
        );
        const [member] = await dataSource.query(
          `SELECT tm.tenantId FROM tenant_members tm JOIN users u ON u.id = tm.userId WHERE u.email = ?`,
          [`${NS}-b@example.com`],
        );

        console.log(
          `FOREIGN FIXTURE FAILED status=${groupResponse.status} set=${set} ` +
            `setTenant=${row?.tenantId} setDeleted=${row?.deletedAt} ` +
            `memberTenant=${member?.tenantId}`,
        );
      }

      const group = idOf(groupResponse, 'foreign group');
      const option = idOf(
        await post(tokenB, `/groups/${group}/options`, {
          key: 'b_option',
          label: 'B option',
          presentation: 'radio',
        }),
        'foreign option',
      );
      const value = idOf(
        await post(tokenB, `/options/${option}/values`, { valueKey: 'b_value', label: 'B value' }),
        'foreign value',
      );

      return { group, option, value };
    }


    type Probe = (ids: { group: string; option: string; value: string }) => request.Test;

    it.each<[string, Probe]>([
      ['GET    /groups/:id', (b) => get(tokenA, `/groups/${b.group}`)],
      ['PATCH  /groups/:id', (b) => patch(tokenA, `/groups/${b.group}`, { label: 'Stolen' })],
      ['DELETE /groups/:id', (b) => del(tokenA, `/groups/${b.group}`)],
      ['POST   /groups/:id/duplicate', (b) => post(tokenA, `/groups/${b.group}/duplicate`)],
      ['GET    /groups/:id/options', (b) => get(tokenA, `/groups/${b.group}/options`)],
      ['POST   /groups/:id/options', (b) =>
        post(tokenA, `/groups/${b.group}/options`, {
          key: 'x',
          label: 'X',
          presentation: 'radio',
        })],
      ['GET    /options/:id', (b) => get(tokenA, `/options/${b.option}`)],
      ['PATCH  /options/:id', (b) => patch(tokenA, `/options/${b.option}`, { label: 'Stolen' })],
      ['DELETE /options/:id', (b) => del(tokenA, `/options/${b.option}`)],
      ['POST   /options/:id/duplicate', (b) => post(tokenA, `/options/${b.option}/duplicate`)],
      ['GET    /options/:id/values', (b) => get(tokenA, `/options/${b.option}/values`)],
      ['POST   /options/:id/values', (b) =>
        post(tokenA, `/options/${b.option}/values`, { valueKey: 'x', label: 'X' })],
      ['GET    /values/:id', (b) => get(tokenA, `/values/${b.value}`)],
      ['PATCH  /values/:id', (b) => patch(tokenA, `/values/${b.value}`, { label: 'Stolen' })],
      ['DELETE /values/:id', (b) => del(tokenA, `/values/${b.value}`)],
    ])('%s refuses another tenant', async (_label, probe) => {
      expect((await probe(await foreign())).status).toBe(404);
    }, 60_000);

    it('leaves the other tenant’s data untouched after a refused write', async () => {
      const b = await foreign();

      await patch(tokenA, `/groups/${b.group}`, { label: 'Stolen' });
      await del(tokenA, `/values/${b.value}`);

      expect((await get(tokenB, `/groups/${b.group}`)).body.data.label).toBe('B group');
      expect((await get(tokenB, `/values/${b.value}`)).status).toBe(200);
    }, 60_000);
  });

  /**
   * Behaviour under simultaneous writes to one parent.
   *
   * These are the cases a sequential suite cannot reach: every defect here
   * passed every serial test before it was found by a concurrent probe.
   */
  describe('concurrency', () => {
    /**
     * A check-then-insert has a window; the constraint closes it. What must not
     * happen is the loser getting a 500 for a collision that returns a clean
     * error when it happens serially.
     */
    it('answers a raced duplicate key with a conflict, never a 500', async () => {
      const group = await newGroup();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          post(tokenA, `/groups/${group}/options`, {
            key: 'racy',
            label: 'Racy',
            presentation: 'radio',
          }),
        ),
      );

      const statuses = responses.map((response) => response.status);

      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses).not.toContain(500);
      // Whatever the losers got, it names the field rather than leaking SQL.
      responses
        .filter((response) => response.status !== 201)
        .forEach((response) => {
          expect(['VALIDATION_FAILED', 'CONFLICT']).toContain(response.body.error.code);
          expect(JSON.stringify(response.body)).not.toContain('Duplicate entry');
        });
      expect((await get(tokenA, `/groups/${group}/options`)).body.data).toHaveLength(1);
    }, 120_000);

    it('answers a raced duplicate value key the same way', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'raced_values');

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          post(tokenA, `/options/${option}/values`, { valueKey: 'same', label: 'Same' }),
        ),
      );

      expect(responses.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
      expect(responses.map((r) => r.status)).not.toContain(500);
      expect((await get(tokenA, `/options/${option}/values`)).body.data).toHaveLength(1);
    }, 120_000);

    /**
     * The defect this replaced left **zero** defaults, not two: each concurrent
     * request cleared the flags of rows the others had just inserted. A radio
     * with nothing pre-selected, where the merchant set a default.
     */
    it('leaves exactly one default when several are created at once', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'concurrent_defaults');

      const responses = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          post(tokenA, `/options/${option}/values`, {
            valueKey: `d${index}`,
            label: `D${index}`,
            isDefault: true,
          }),
        ),
      );

      const values = await get(tokenA, `/options/${option}/values`);
      const defaults = values.body.data.filter((v: { isDefault: boolean }) => v.isDefault);
      const created = responses.filter((response) => response.status === 201);

      // A concurrent writer may be rolled back and answered 409; that is a retry
      // instruction, not a broken invariant. What must never happen is two
      // defaults, or a row that was reported created going missing.
      responses
        .filter((response) => response.status !== 201)
        .forEach((response) => expect(response.status).toBe(409));

      expect(values.body.data).toHaveLength(created.length);
      expect(defaults.length).toBeLessThanOrEqual(1);

      if (created.length > 0) {
        expect(defaults).toHaveLength(1);
      }
    }, 120_000);

    it('leaves exactly one default when several are set at once by PATCH', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'concurrent_patch');
      const ids: string[] = [];

      for (let index = 0; index < 4; index += 1) {
        ids.push(
          idOf(
            await post(tokenA, `/options/${option}/values`, {
              valueKey: `p${index}`,
              label: `P${index}`,
            }),
            'value',
          ),
        );
      }

      const responses = await Promise.all(
        ids.map((id) => patch(tokenA, `/values/${id}`, { isDefault: true })),
      );

      const values = await get(tokenA, `/options/${option}/values`);
      const defaults = values.body.data.filter((v: { isDefault: boolean }) => v.isDefault);

      /**
       * **Never more than one** is the invariant. Exactly one requires that at
       * least one PATCH committed, and it need not: four writers touching the
       * same rows can deadlock, and a rolled-back write is a `409` telling the
       * caller to retry — not a failure of the rule under test. Asserting a
       * flat `1` made this suite fail roughly once in ten for a reason that had
       * nothing to do with defaults.
       */
      expect(defaults.length).toBeLessThanOrEqual(1);

      const succeeded = responses.filter((response) => response.status === 200);

      responses
        .filter((response) => response.status !== 200)
        .forEach((response) => expect(response.status).toBe(409));

      if (succeeded.length > 0) {
        expect(defaults).toHaveLength(1);
      }
    }, 120_000);

    /** The scoped-by-hand statement in `makeSoleDefault` needs its own probe. */
    it('cannot clear another tenant’s defaults', async () => {
      const foreignSet = await seedSet('b');
      const foreignGroup = idOf(
        await post(tokenB, `/option-sets/${foreignSet}/groups`, { label: 'Theirs' }),
        'foreign group',
      );
      const foreignOption = idOf(
        await post(tokenB, `/groups/${foreignGroup}/options`, {
          key: 'theirs',
          label: 'Theirs',
          presentation: 'radio',
        }),
        'foreign option',
      );
      await post(tokenB, `/options/${foreignOption}/values`, {
        valueKey: 'keep',
        label: 'Keep',
        isDefault: true,
      });

      // Tenant A tries to add a default to tenant B's option.
      expect(
        (
          await post(tokenA, `/options/${foreignOption}/values`, {
            valueKey: 'mine',
            label: 'Mine',
            isDefault: true,
          })
        ).status,
      ).toBe(404);

      const theirs = await get(tokenB, `/options/${foreignOption}/values`);

      expect(theirs.body.data.filter((v: { isDefault: boolean }) => v.isDefault)).toHaveLength(1);
    }, 120_000);
  });

  /**
   * Structural ceilings, not plan quotas.
   *
   * `duplicate` copies a subtree inside one transaction and the child lists are
   * unpaginated — both assume a parent holds a bounded number of children, and
   * nothing enforced that assumption until these limits existed.
   */
  describe('limits', () => {
    it('refuses a value beyond the ceiling', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'bounded');

      // Fill the table directly: the point is the boundary, not 500 HTTP calls.
      const [{ count }] = await dataSource.query(
        `SELECT COUNT(*) AS count FROM option_values WHERE optionId = ?`,
        [option],
      );
      const rows: string[] = [];

      for (let index = Number(count); index < 500; index += 1) {
        rows.push(
          `('${randomUUID()}','${option}','k${index}','L${index}',${index},'fixed',0,0,NOW(3),NOW(3),'1970-01-01 00:00:00.000')`,
        );
      }

      await dataSource.query(
        `INSERT INTO option_values (id, optionId, valueKey, label, sortOrder, priceType,
                                    priceAmountMinor, isDefault, createdAt, updatedAt, deletedAt)
         VALUES ${rows.join(',')}`,
      );

      const response = await post(tokenA, `/options/${option}/values`, {
        valueKey: 'one_too_many',
        label: 'Too many',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].code).toBe('LIMIT_REACHED');
    }, 120_000);

    it('allows a create below the ceiling', async () => {
      const group = await newGroup();
      const option = await newOption(group, 'unbounded_ok');

      expect(
        (await post(tokenA, `/options/${option}/values`, { valueKey: 'fine', label: 'Fine' }))
          .status,
      ).toBe(201);
    }, 60_000);
  });

  describe('parent version', () => {
    async function rowVersionOf(setId: string): Promise<number> {
      const [row] = await dataSource.query(`SELECT rowVersion FROM option_sets WHERE id = ?`, [
        setId,
      ]);

      return row.rowVersion as number;
    }

    /**
     * A group, option or value is part of its set, so editing one *is* editing
     * the set. Without this, two people editing different groups of one set
     * would never see a conflict — the silent overwrite M7.4b prevents,
     * arriving one level down where nobody looked.
     */
    it('advances the set’s rowVersion when a child changes', async () => {
      const set = await seedSetForA();
      const start = await rowVersionOf(set);

      const group = (await post(tokenA, `/option-sets/${set}/groups`, { label: 'Child' })).body.data
        .id as string;
      const afterGroup = await rowVersionOf(set);

      const option = await newOption(group, 'child_option');
      const afterOption = await rowVersionOf(set);

      await post(tokenA, `/options/${option}/values`, { valueKey: 'v', label: 'V' });
      const afterValue = await rowVersionOf(set);

      expect(afterGroup).toBeGreaterThan(start);
      expect(afterOption).toBeGreaterThan(afterGroup);
      expect(afterValue).toBeGreaterThan(afterOption);
    }, 60_000);
  });

  describe('audit trail', () => {
    it('records every level with an actor and an IP', async () => {
      const group = await newGroup('Audited');
      const option = await newOption(group, 'audited');
      const value = idOf(
        await post(tokenA, `/options/${option}/values`, { valueKey: 'v', label: 'V' }),
        'value',
      );

      const rows = await dataSource.query(
        `SELECT action, userId, ip FROM audit_logs WHERE resourceId IN (?, ?, ?)`,
        [group, option, value],
      );
      const actions = rows.map((r: { action: string }) => r.action).sort();

      expect(actions).toEqual(['option.created', 'option_group.created', 'option_value.created']);
      rows.forEach((row: { userId: string | null; ip: Buffer | null }) => {
        expect(row.userId).not.toBeNull();
        expect(row.ip).not.toBeNull();
      });
    }, 60_000);
  });

  describe('authorization', () => {
    /**
     * Capability enforcement on **these** routes.
     *
     * `guards.e2e-spec.ts` proves `CapabilityGuard` works, but it does so
     * against a synthetic probe controller. Every route added in 7f declares a
     * capability, and until this test nothing asserted that any of those
     * declarations is enforced — which is exactly how the earlier fail-open
     * guard reached production-shaped code with a comment claiming a test that
     * did not exist.
     */
    describe('a viewer', () => {
      let viewerToken = '';
      let group = '';
      let option = '';
      let value = '';
      let viewerSet = '';

      beforeAll(async () => {
        // A member of their own tenant, demoted to viewer — so the fixtures
        // below are theirs to see and a 403 cannot be confused with a 404.
        const email = `${NS}-viewer@example.com`;

        await request(app.getHttpServer())
          .post('/v1/auth/register')
          .send({ email, password: PASSWORD, name: 'viewer', tenantName: `${NS}-viewer` });
        await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [email]);
        await dataSource.query(
          `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
             JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
          [`${NS}-viewer`, email],
        );

        const owner = (
          await request(app.getHttpServer())
            .post('/v1/auth/login')
            .send({ email, password: PASSWORD })
        ).body.data.accessToken as string;

        viewerSet = await seedSet('viewer');
        group = (await post(owner, `/option-sets/${viewerSet}/groups`, { label: 'V' })).body.data
          .id as string;
        option = idOf(
          await post(owner, `/groups/${group}/options`, {
            key: 'vk',
            label: 'V',
            presentation: 'radio',
          }),
          'option',
        );
        value = (await post(owner, `/options/${option}/values`, { valueKey: 'vv', label: 'V' })).body
          .data.id as string;

        await dataSource.query(
          `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
              SET tm.role = 'viewer' WHERE u.email = ?`,
          [email],
        );

        viewerToken = (
          await request(app.getHttpServer())
            .post('/v1/auth/login')
            .send({ email, password: PASSWORD })
        ).body.data.accessToken as string;
      }, 120_000);

      it.each<[string, () => request.Test]>([
        ['POST   /option-sets/:id/groups', () =>
          post(viewerToken, `/option-sets/${viewerSet}/groups`, { label: 'X' })],
        ['PATCH  /groups/:id', () => patch(viewerToken, `/groups/${group}`, { label: 'X' })],
        ['DELETE /groups/:id', () => del(viewerToken, `/groups/${group}`)],
        ['POST   /groups/:id/duplicate', () => post(viewerToken, `/groups/${group}/duplicate`)],
        ['POST   /option-sets/:id/reorder', () =>
          post(viewerToken, `/option-sets/${viewerSet}/reorder`, {
            groups: [{ id: group, sortOrder: 10 }],
          })],
        ['POST   /groups/:id/options', () =>
          post(viewerToken, `/groups/${group}/options`, {
            key: 'x',
            label: 'X',
            presentation: 'radio',
          })],
        ['PATCH  /options/:id', () => patch(viewerToken, `/options/${option}`, { label: 'X' })],
        ['DELETE /options/:id', () => del(viewerToken, `/options/${option}`)],
        ['POST   /options/:id/duplicate', () => post(viewerToken, `/options/${option}/duplicate`)],
        ['POST   /options/:id/values', () =>
          post(viewerToken, `/options/${option}/values`, { valueKey: 'x', label: 'X' })],
        ['PATCH  /values/:id', () => patch(viewerToken, `/values/${value}`, { label: 'X' })],
        ['DELETE /values/:id', () => del(viewerToken, `/values/${value}`)],
      ])('is refused %s', async (_label, call) => {
        const response = await call();

        // 403, not 404: the caller is a legitimate member and the resource
        // plainly exists. Cross-*tenant* is the case that gets a 404.
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
      }, 60_000);

      it('can still read every level', async () => {
        expect((await get(viewerToken, `/option-sets/${viewerSet}/groups`)).status).toBe(200);
        expect((await get(viewerToken, `/groups/${group}/options`)).status).toBe(200);
        expect((await get(viewerToken, `/options/${option}/values`)).status).toBe(200);
        expect((await get(viewerToken, `/values/${value}`)).status).toBe(200);
      }, 60_000);
    });

    it('refuses an unauthenticated request', async () => {
      const response = await request(app.getHttpServer()).get(`/v1/groups/${randomUUID()}`);

      expect(response.status).toBe(401);
    }, 30_000);
  });
});
