import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import { deleteTenantsBySlug } from './cleanup-tenants';
import { bootstrapTestApp } from './harness';


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
    app = await bootstrapTestApp();

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
    await deleteTenantsBySlug(dataSource, NS);
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

    if (login.status !== 200) {
      // See the note in `guards.e2e-spec.ts`: an unchecked login turns a
      // throttled request into `Bearer undefined`, and a permission test that
      // sends no credential can pass for the wrong reason.
      throw new Error(
        `Failed to sign in ${email}: ${login.status} ` +
          `${JSON.stringify(login.body?.error ?? login.body)}`,
      );
    }

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
      /*
       * ⚠️ **The URL is per STORE, not per tenant.** `uq_stores_tenant_url`
       * allows one tenant several storefronts only at different addresses, and
       * seeding two with `https://a.example.com` collided — which is the
       * constraint modelling reality, since M20.8's whole point is a merchant
       * running more than one shop.
       */
      [id, await tenantIdOf(which), which, `https://${which}-${id}.example.com`],
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
      // A fresh id rather than a fixed one: a hardcoded UUID can be created by
      // another suite, and then "missing" is not missing. That happened — the
      // comparison passed `undefined` against `NOT_FOUND` because `?.` quietly
      // absorbed a 200, so the test failed for a reason unrelated to scoping.
      const foreign = await asA('get', `/${setB}`);
      const missing = await asA('get', `/${randomUUID()}`);

      // Asserted absolutely, not just against each other: two identical wrong
      // answers would satisfy an equality check.
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body.error.code).toBe('NOT_FOUND');
      expect(missing.body.error.code).toBe('NOT_FOUND');
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

  describe('import', () => {
    const doc = (over: Record<string, unknown> = {}) => ({
      version: 1,
      name: 'Imported',
      groups: [
        {
          label: 'Finish',
          description: null,
          displayType: 'inline',
          isCollapsible: false,
          isEnabled: true,
          sortOrder: 0,
          options: [
            {
              key: 'colour',
              label: 'Colour',
              presentation: 'dropdown',
              isRequired: false,
              isEnabled: true,
              sortOrder: 0,
              values: [
                {
                  valueKey: 'gold',
                  label: 'Gold',
                  sortOrder: 0,
                  priceType: 'fixed',
                  priceAmountMinor: 500,
                  skuSuffix: '-GD',
                },
              ],
            },
          ],
          items: [],
        },
      ],
      rules: [],
      ...over,
    });

    it('builds a set from a document', async () => {
      const response = await asA('post', '/import').send({ storeId: storeA, document: doc() });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ name: 'Imported', status: 'draft' });
    }, 30_000);

    it('builds the whole tree', async () => {
      const created = await asA('post', '/import').send({ storeId: storeA, document: doc() });
      const detail = await asA('get', `/${created.body.data.id}/detail`);

      const group = detail.body.data.groups[0];

      expect(group.label).toBe('Finish');
      expect(group.options[0].key).toBe('colour');
      expect(group.options[0].values[0]).toMatchObject({ valueKey: 'gold', skuSuffix: '-GD' });
    }, 30_000);

    /**
     * 🔴 **The whole reason this is a backend endpoint.** Rebuilding from the
     * dashboard would be a sequence of creates with no transaction: a document
     * failing partway leaves a set nobody authored, and a create is a shape
     * change that clears the undo log. One transaction means a bad document
     * creates **nothing**.
     */
    it('creates nothing when a document is invalid partway through', async () => {
      const before = await asA('get', '');

      const bad = doc();

      /* The second option names a presentation the registry does not have. */
      (bad.groups[0] as { options: unknown[] }).options.push({
        key: 'shape',
        label: 'Shape',
        presentation: 'hologram',
        isRequired: false,
        isEnabled: true,
        sortOrder: 1,
        values: [],
      });

      const response = await asA('post', '/import').send({ storeId: storeA, document: bad });

      expect(response.status).toBe(400);

      const after = await asA('get', '');

      expect(after.body.data.length).toBe(before.body.data.length);
    }, 30_000);

    /**
     * 🔴 **A failure in a LATER group, after earlier ones are written.**
     *
     * The test above fails on the second option of the *first* group, so only
     * one group had been saved when the transaction rolled back. This one
     * writes a whole valid group, its option and its value — then fails in the
     * second group, which is the case that actually exercises the rollback
     * across several `manager.save` calls.
     */
    it('rolls back groups already written when a later one fails', async () => {
      const before = await asA('get', '');

      const bad = doc();

      (bad.groups as Record<string, unknown>[]).push({
        label: 'Second',
        description: null,
        displayType: 'inline',
        isCollapsible: false,
        isEnabled: true,
        sortOrder: 20,
        options: [
          {
            key: 'broken',
            label: 'Broken',
            presentation: 'hologram',
            isRequired: false,
            isEnabled: true,
            sortOrder: 10,
            values: [],
          },
        ],
        items: [],
      });

      const response = await asA('post', '/import').send({ storeId: storeA, document: bad });

      expect(response.status).toBe(400);

      const after = await asA('get', '');

      expect(after.body.data.length).toBe(before.body.data.length);
    }, 30_000);

    /** ⚠️ A target store in another tenant is a 404, as everywhere else. */
    it('refuses a store belonging to another tenant', async () => {
      const response = await asA('post', '/import').send({ storeId: storeB, document: doc() });

      expect(response.status).toBe(404);
    }, 30_000);

    /**
     * 🔴 **A valueless type must refuse values, and the import did not.**
     *
     * `option-values.service.ts` states the rule and the reason: *"a merchant
     * could add three values to a text field, the publish check would
     * deliberately look past them, and the storefront would render an input
     * that ignores them. Rows that exist, validate, publish, and mean
     * nothing."*
     *
     * Measured before this test existed: `status=201 values=1`. The import
     * wrote rows through `manager.save` directly and never called
     * `takesValues` — and neither did the dashboard's own validator, so the
     * defect was reachable through the ordinary UI.
     *
     * ⚠️ **Our own export cannot produce such a file**, because the tree cannot
     * hold that shape. It takes a hand-edited document — which is exactly what
     * import exists to accept.
     */
    it('refuses values on a type that takes none', async () => {
      const bad = doc();

      (bad.groups[0] as { options: Record<string, unknown>[] }).options[0]!.presentation =
        'text_field';

      const response = await asA('post', '/import').send({ storeId: storeA, document: bad });

      expect(response.status).toBe(400);
    }, 30_000);

    /** ⚠️ And a text field with no values imports fine — the rule is about values. */
    it('imports a valueless type that carries no values', async () => {
      const fine = doc();
      const option = (fine.groups[0] as { options: Record<string, unknown>[] }).options[0]!;

      option.presentation = 'text_field';
      option.values = [];

      const response = await asA('post', '/import').send({ storeId: storeA, document: fine });

      expect(response.status).toBe(201);
    }, 30_000);

    /**
     * 🔴 **The limits the API owns, enforced by the API.**
     *
     * The dashboard checks them before sending, which makes the UI path safe —
     * but a client check is never the boundary, and this endpoint is guarded by
     * a capability rather than by a client.
     */
    it('refuses more values than the limit allows', async () => {
      const bad = doc();
      const option = (bad.groups[0] as { options: Record<string, unknown>[] }).options[0]!;

      option.values = Array.from({ length: 501 }, (_, i) => ({
        valueKey: `v${i}`,
        label: `V${i}`,
        sortOrder: i,
        priceType: 'fixed',
        priceAmountMinor: 0,
      }));

      const response = await asA('post', '/import').send({ storeId: storeA, document: bad });

      expect(response.status).toBe(400);
    }, 30_000);

    it('refuses more options than the limit allows', async () => {
      const bad = doc();
      const group = bad.groups[0] as { options: Record<string, unknown>[] };

      group.options = Array.from({ length: 201 }, (_, i) => ({
        key: `k${i}`,
        label: `K${i}`,
        presentation: 'dropdown',
        isRequired: false,
        isEnabled: true,
        sortOrder: i,
        values: [{ valueKey: 'a', label: 'A', sortOrder: 0, priceType: 'fixed', priceAmountMinor: 0 }],
      }));

      const response = await asA('post', '/import').send({ storeId: storeA, document: bad });

      expect(response.status).toBe(400);
    }, 30_000);

    /**
     * 🔴 **A duplicate key reached the database and became a 500.** The unique
     * index caught it, so nothing was corrupted — but a merchant met a server
     * error where the create path gives them a named field.
     */
    it('refuses two values sharing a key with a 400, not a 500', async () => {
      const bad = doc();
      const option = (bad.groups[0] as { options: Record<string, unknown>[] }).options[0]!;

      (option.values as Record<string, unknown>[]).push({
        valueKey: 'gold',
        label: 'Gold again',
        sortOrder: 1,
        priceType: 'fixed',
        priceAmountMinor: 0,
      });

      const response = await asA('post', '/import').send({ storeId: storeA, document: bad });

      expect(response.status).toBe(400);
    }, 30_000);

    /**
     * 🔴 **Every starter template must survive the real endpoint** (M20.7, M20b.4).
     *
     * A template a merchant meets as an error on their **first action** is the
     * worst possible first run — and the dashboard's own tests validate them
     * against `parsePortable`, which is a client check rather than the boundary.
     *
     * ✏️ **Driven by a fixture emitted from `templates.ts`, not a hand copy.**
     * The previous version pasted the engraving document into this file and
     * tested that one alone. It had already drifted — the pasted copy carried a
     * single option where the real template carries two — which is exactly the
     * failure a hand copy invites, and it left three of the four templates with
     * no proof at all.
     *
     * `bin/check-template-fixture.sh` keeps the fixture and the dashboard's
     * source in step, so this cannot quietly test a stale document again.
     *
     * 📌 **`fixtures/dashboard/`, not `fixtures/shared/`.** That directory means
     * *shared with the plugin* — `check-fixture-parity.sh` requires every file in
     * it to exist in both repositories — and the plugin never imports a template.
     */
    describe('the starter templates', () => {
      const templates: Record<string, Record<string, unknown>> = JSON.parse(
        readFileSync(join(__dirname, 'fixtures/dashboard/starter-templates.json'), 'utf8'),
      ) as Record<string, Record<string, unknown>>;

      /* A gate that iterates an empty object passes for the wrong reason. */
      it('covers the four the plan names', () => {
        expect(Object.keys(templates).sort()).toEqual([
          'dimensions',
          'engraving',
          'gift-wrap',
          'tshirt',
        ]);
      });

      it.each(Object.keys(templates))('imports the %s template', async (id) => {
        const response = await asA('post', '/import').send({
          storeId: storeA,
          document: templates[id],
        });

        expect(response.status).toBe(201);

        /*
         * ⚠️ Asserted on the **stored tree**, not on the create response: an
         * import that answered `201` and wrote nothing would satisfy a status
         * check, and a merchant would open an empty set.
         *
         * ✏️ **Counted against the document, not against zero.** This asserted
         * `options.length > 0`, which is satisfied by an endpoint that imported
         * one option out of five. Comparing to the sent document means every
         * option in it must arrive.
         *
         * ⚠️ **This cannot detect fixture drift, and is not meant to.** Both
         * sides of the comparison come from the same file, so a thinned fixture
         * shrinks the expectation with it — verified, it passes. What it proves
         * is that the *endpoint* honours the document it was given. That the
         * document still matches `templates.ts` is
         * `templates.fixture.test.ts`'s job, in the only repository that can
         * rebuild it.
         */
        const detail = await asA('get', `/${response.body.data.id}/detail`);
        const groups = detail.body.data.groups as Array<{ options: unknown[] }>;
        const wanted = templates[id] as unknown as {
          groups: Array<{ options: unknown[] }>;
        };

        expect(groups).toHaveLength(wanted.groups.length);
        wanted.groups.forEach((group, index) => {
          expect(groups[index].options).toHaveLength(group.options.length);
        });
      }, 30_000);

      /**
       * The engraving template is the richest — option-level `per_char` pricing,
       * a length limit, a derived counter and a charset rule — so its fields are
       * asserted individually rather than only counted.
       */
      it('preserves the engraving template’s pricing and validation', async () => {
        const response = await asA('post', '/import').send({
          storeId: storeA,
          document: templates.engraving,
        });

        expect(response.status).toBe(201);

        const detail = await asA('get', `/${response.body.data.id}/detail`);
        const options = detail.body.data.groups[0].options as Array<{
          presentation: string;
          pricing?: Record<string, unknown>;
          validation?: Record<string, unknown>;
        }>;
        const text = options.find((option) => option.presentation === 'text_field');

        expect(text?.pricing).toMatchObject({ type: 'per_char', amountMinor: 50 });
        expect(text?.validation).toMatchObject({ maxLength: 30 });
      }, 30_000);
    });

    /** 📌 An imported set is always a draft, whatever the document claims. */
    it('imports as a draft', async () => {
      const response = await asA('post', '/import').send({
        storeId: storeA,
        document: doc({ status: 'published', version: 9 }),
      });

      expect(response.body.data).toMatchObject({ status: 'draft', version: 0 });
    }, 30_000);
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

    /**
     * Copying into a **second store of the same tenant** (M20.8).
     *
     * 🔴 **The multi-store differentiator [D5] promises**, and `duplicate`
     * hardcoded `storeId: source.storeId` — so a merchant running three
     * storefronts rebuilt the same option set by hand for each.
     *
     * ⚠️ **Assignments are deliberately NOT copied**, and that is what makes
     * this safe: they name products by external id, which means nothing in
     * another store. The copy arrives unassigned, which is the honest state.
     */
    it('copies into another store of the same tenant', async () => {
      const storeA2 = await store('a');
      const created = await asA('post').send({ name: 'Shared', storeId: storeA });

      const response = await asA('post', `/${created.body.data.id}/duplicate`).send({
        storeId: storeA2,
      });

      expect(response.status).toBe(201);
      expect(response.body.data.storeId).toBe(storeA2);
      expect(response.body.data.status).toBe('draft');
    }, 30_000);

    it('stays in the source store when no target is named', async () => {
      const created = await asA('post').send({ name: 'Local', storeId: storeA });
      const response = await asA('post', `/${created.body.data.id}/duplicate`).send({});

      expect(response.body.data.storeId).toBe(storeA);
    }, 30_000);

    /**
     * 🔴 **The tenant-isolation surface this milestone opens.**
     *
     * A target store is a caller-supplied id, so without a check a merchant
     * could copy their option set **into another tenant's storefront** — the
     * copy would be stamped with the caller's tenant while pointing at someone
     * else's shop.
     *
     * ⚠️ **404, not 403**, matching `assertStoreBelongsToTenant`: a store id in
     * another tenant must not be distinguishable from one that does not exist,
     * or the error itself confirms the store is real.
     */
    it('refuses a target store belonging to another tenant', async () => {
      const created = await asA('post').send({ name: 'Smuggle', storeId: storeA });

      const response = await asA('post', `/${created.body.data.id}/duplicate`).send({
        storeId: storeB,
      });

      expect(response.status).toBe(404);
    }, 30_000);

    it('refuses a target store that does not exist', async () => {
      const created = await asA('post').send({ name: 'Ghost', storeId: storeA });

      const response = await asA('post', `/${created.body.data.id}/duplicate`).send({
        storeId: randomUUID(),
      });

      expect(response.status).toBe(404);
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
      // Zero because `version` counts publishes, and a copy has made none —
      // the first publish of the copy produces version 1.
      expect(copy.body.data.version).toBe(0);
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
     * 🔴 **Rules were copied by nothing, and every suite stayed green.**
     *
     * Found by auditing Stage 17-1: `duplicate()` carried groups, options,
     * values and items and **no rules at all**, so a merchant duplicating a
     * configured set got one with its conditional logic silently removed.
     *
     * The unit guard in `duplication.spec.ts` asserts the *field list* is
     * complete. This asserts the row actually arrives — and, more importantly,
     * that its ids were **remapped**: a rule copied verbatim would point at the
     * source set's rows, which is worse than dropping it, because it would
     * evaluate and govern the wrong document.
     */
    it('copies rules, repointing them at the copy rather than the source', async () => {
      const created = await asA('post').send({ name: 'Conditional', storeId: storeA });
      const setId = created.body.data.id as string;

      const groupId = randomUUID();
      const optionId = randomUUID();
      const ruleId = randomUUID();
      const S = `'1970-01-01 00:00:00.000'`;

      await dataSource.query(
        `INSERT INTO option_groups (id, optionSetId, label, description, displayType,
                                    sortOrder, isCollapsible, isEnabled, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'Engraving', '', 'inline', 0, 0, 1, NOW(3), NOW(3), ${S})`,
        [groupId, setId],
      );
      await dataSource.query(
        `INSERT INTO options (id, optionGroupId, \`key\`, valueKind, cardinality, presentation,
                              label, description, placeholder, helpText, isRequired, sortOrder,
                              isEnabled, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'wants_engraving', 'choice', 'one', 'radio', 'Engrave?', '', '', '', 1, 0, 1,
                 NOW(3), NOW(3), ${S})`,
        [optionId, groupId],
      );

      /*
       * Targets the option, and its condition names that same option.
       *
       * ⚠️ **Inserted as SQL, with an action the API no longer accepts.**
       * `show` was withdrawn by ADR-056, so this row cannot be authored through
       * the API — which is exactly the case worth covering here: rows written
       * before a withdrawal still exist, and duplicating a set must carry them
       * verbatim rather than dropping or rewriting them. A storefront then
       * ignores the action, as every evaluator does for one it does not know
       * (AC4).
       */
      await dataSource.query(
        `INSERT INTO option_rules (id, optionSetId, targetType, targetId, action, conditions,
                                   matchType, sortOrder, isEnabled, disabledReason,
                                   createdAt, updatedAt, deletedAt)
         VALUES (?, ?, 'option', ?, 'show', ?, 'all', 0, 1, NULL, NOW(3), NOW(3), ${S})`,
        [
          ruleId,
          setId,
          optionId,
          JSON.stringify([{ optionId, operator: 'equals', value: 'yes' }]),
        ],
      );

      const copy = await asA('post', `/${setId}/duplicate`).send({});
      const copyId = copy.body.data.id as string;

      const rules = await dataSource.query(
        `SELECT targetId, conditions, action, matchType, isEnabled
           FROM option_rules WHERE optionSetId = ?`,
        [copyId],
      );

      expect(rules).toHaveLength(1);

      const [rule] = rules;

      /* What the rule DOES is carried verbatim — a withdrawn action included. */
      expect(rule.action).toBe('show');
      expect(rule.matchType).toBe('all');
      expect(Number(rule.isEnabled)).toBe(1);

      /* The copied option's id, discovered rather than assumed. */
      const [copiedOption] = await dataSource.query(
        `SELECT o.id FROM options o
           JOIN option_groups g ON g.id = o.optionGroupId
          WHERE g.optionSetId = ?`,
        [copyId],
      );

      /*
       * 🔴 The assertion that matters: the rule points at the COPY's option,
       * not the source's. Equality with `optionId` here would mean a rule
       * silently governing another set.
       */
      expect(rule.targetId).toBe(copiedOption.id);
      expect(rule.targetId).not.toBe(optionId);

      const conditions =
        typeof rule.conditions === 'string' ? JSON.parse(rule.conditions) : rule.conditions;

      expect(conditions).toEqual([
        { optionId: copiedOption.id, operator: 'equals', value: 'yes' },
      ]);
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
