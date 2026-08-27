import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';
import { runWithContext } from '../src/common/context/request-context';
import {
  CONFIG_SCHEMA_VERSION,
  ConfigDocumentBuilder,
} from '../src/option-sets/serialization/config-document';
import type { ConfigDocument } from '../src/option-sets/serialization/projections';

/**
 * The config document (M7.5, step 7k).
 *
 * `docs/CONFIG-CONTRACT.md` is the reference for both the TypeScript that
 * produces this and the PHP that consumes it. A contract nothing verifies is a
 * wish, so these tests assert the document against the claims the document
 * makes — including reading the contract file itself, so the two cannot drift.
 */
describe('config document (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let builder: ConfigDocumentBuilder;

  const NS = 'cfg7k';
  const PASSWORD = 'a-sufficiently-long-password';
  const CONTRACT = readFileSync('docs/CONFIG-CONTRACT.md', 'utf8');

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
    builder = app.get(ConfigDocumentBuilder);
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

  function idOf(response: request.Response, what: string): string {
    if (response.status !== 201) {
      throw new Error(
        `Fixture failed to create a ${what}: ${response.status} ` +
          `${JSON.stringify(response.body?.error ?? response.body)}`,
      );
    }

    return response.body.data.id as string;
  }

  /** A published set with one group, one option and two values. */
  async function publishedSet(name: string): Promise<string> {
    const set = idOf(await post('/option-sets', { name, storeId }), 'set');
    const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'Customization' }), 'group');
    const option = idOf(
      await post(`/groups/${group}/options`, {
        key: `k${randomUUID().slice(0, 8)}`,
        label: 'Print placement',
        presentation: 'radio',
        isRequired: true,
      }),
      'option',
    );
    idOf(
      await post(`/options/${option}/values`, {
        valueKey: 'none',
        label: 'None',
        isDefault: true,
      }),
      'value',
    );
    idOf(
      await post(`/options/${option}/values`, {
        valueKey: 'front',
        label: 'Front',
        priceAmountMinor: 1000,
      }),
      'value',
    );

    await dataSource.query(
      `INSERT INTO presentational_items (id, optionGroupId, kind, content, sortOrder, display,
                                         createdAt, updatedAt, deletedAt)
       VALUES (?, ?, 'heading', 'Make it yours', 5, NULL, NOW(3), NOW(3),
               '1970-01-01 00:00:00.000')`,
      [randomUUID(), group],
    );

    const published = await post(`/option-sets/${set}/publish`, {});

    if (published.status !== 201) {
      throw new Error(`Fixture failed to publish: ${JSON.stringify(published.body)}`);
    }

    return set;
  }

  /** The builder runs under a store token in production; here, with a tenant. */
  async function build(): Promise<ConfigDocument> {
    return runWithContext({ requestId: 'test', startedAt: Date.now(), tenantId }, () =>
      builder.build(storeId),
    );
  }

  describe('the envelope', () => {
    it('carries exactly the five documented fields', async () => {
      await publishedSet('Enveloped');

      const document = await build();

      expect(Object.keys(document).sort()).toEqual([
        'config_version',
        'generated_at',
        'option_sets',
        'schema_version',
        'store_id',
      ]);
    }, 120_000);

    /**
     * The shipped plugin refuses a document above its supported version and
     * keeps its last good copy. Raising this silently switches off every
     * storefront on an older build.
     */
    it('declares schema version 1, which the plugin supports', () => {
      expect(CONFIG_SCHEMA_VERSION).toBe(1);
      expect(CONTRACT).toContain('**Schema version 1. Frozen.**');
    });

    it('reports the store’s config version as a number', async () => {
      await publishedSet('Versioned');

      const document = await build();
      const [store] = await dataSource.query(
        `SELECT configVersion FROM stores WHERE id = ?`,
        [storeId],
      );

      expect(typeof document.config_version).toBe('number');
      expect(document.config_version).toBe(Number(store.configVersion));
    }, 120_000);

    it('stamps generated_at as an ISO timestamp', async () => {
      const document = await build();

      expect(document.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }, 60_000);

    it('is legal and empty for a store with nothing published', async () => {
      const emptyStore = randomUUID();

      await dataSource.query(
        `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                             createdAt, updatedAt)
         VALUES (?, ?, 'woocommerce', 'empty', ?, 'connected', 0, NOW(3), NOW(3))`,
        [emptyStore, tenantId, `https://${emptyStore}.example.com`],
      );

      const document = await runWithContext(
        { requestId: 'test', startedAt: Date.now(), tenantId },
        () => builder.build(emptyStore),
      );

      expect(document.option_sets).toEqual([]);
      expect(document.schema_version).toBe(1);
    }, 60_000);
  });

  describe('what it contains', () => {
    /** The live rows are the merchant's working draft. */
    it('omits an unpublished set entirely', async () => {
      await publishedSet('Published');
      const draft = idOf(await post('/option-sets', { name: 'Draft', storeId }), 'set');

      const document = await build();

      expect(document.option_sets.some((set) => set.id === draft)).toBe(false);
    }, 120_000);

    /**
     * The status filter, tested directly.
     *
     * An *unpublished* set is excluded whether or not the filter exists — it has
     * no snapshot at version 0, so the snapshot lookup drops it anyway. The
     * filter earns its place only for a set that **was** published and is no
     * longer: it still has a snapshot, and status is the only thing saying it
     * should not ship.
     *
     * `unpublish` is in M7.4's state model and not yet built, so that state is
     * reached here directly. Without this, removing the filter breaks nothing
     * and it reads as dead code somebody will later delete.
     */
    it('excludes a set that was published and is no longer', async () => {
      const set = await publishedSet('Unpublished');

      expect((await build()).option_sets.some((candidate) => candidate.id === set)).toBe(true);

      await dataSource.query(`UPDATE option_sets SET status = 'draft' WHERE id = ?`, [set]);

      expect((await build()).option_sets.some((candidate) => candidate.id === set)).toBe(false);
    }, 120_000);

    it('excludes an archived set', async () => {
      const set = await publishedSet('Archived');
      await dataSource.query(`UPDATE option_sets SET status = 'archived' WHERE id = ?`, [set]);

      expect((await build()).option_sets.some((candidate) => candidate.id === set)).toBe(false);
    }, 120_000);

    /** A soft-deleted set stops reaching storefronts too. */
    it('excludes a soft-deleted set', async () => {
      const set = await publishedSet('Deleted');
      await dataSource.query(`UPDATE option_sets SET deletedAt = NOW(3) WHERE id = ?`, [set]);

      expect((await build()).option_sets.some((candidate) => candidate.id === set)).toBe(false);
    }, 120_000);

    /**
     * An edit does not reach a storefront until it is published (M7.4). The
     * document must show the snapshot, not what the editor currently holds.
     */
    it('shows the published snapshot, not later edits', async () => {
      const set = await publishedSet('Snapshotted');

      await post(`/option-sets/${set}/groups`, { label: 'Added after publishing' });

      const document = await build();
      const published = document.option_sets.find((candidate) => candidate.id === set);

      expect(published?.groups).toHaveLength(1);
      expect(published?.groups[0].label).toBe('Customization');
    }, 120_000);

    it('carries several published sets, oldest first', async () => {
      const first = await publishedSet('First');
      const second = await publishedSet('Second');

      const document = await build();
      const ids = document.option_sets.map((set) => set.id);

      expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
    }, 180_000);
  });

  describe('the shape the contract promises', () => {
    it('matches the documented option, value and item shapes', async () => {
      await publishedSet('Shaped');

      const document = await build();
      const set = document.option_sets[document.option_sets.length - 1];
      const group = set.groups[0];

      // `description` is absent because this fixture sets none — the contract
      // says optional fields are omitted rather than sent as null.
      expect(Object.keys(group).sort()).toEqual([
        'display_type',
        'id',
        'is_collapsible',
        'items',
        'label',
        'options',
        'sort_order',
      ]);

      const option = group.options[0];
      expect(option).toMatchObject({
        type: 'radio',
        value_kind: 'choice',
        cardinality: 'one',
        is_required: true,
      });

      const none = option.values.find((value) => value.value_key === 'none');
      const front = option.values.find((value) => value.value_key === 'front');

      expect(none?.is_default).toBe(true);
      // Present only when true — never `false`.
      expect(front).not.toHaveProperty('is_default');
      expect(front?.price_config).toEqual({ type: 'fixed', amount_minor: 1000 });

      expect(group.items[0]).toEqual({
        kind: 'heading',
        content: 'Make it yours',
        sort_order: 5,
      });
    }, 120_000);

    /** Money is an integer count of minor units. Always. */
    it('keeps every amount an integer', async () => {
      await publishedSet('Money');

      const document = await build();
      const amounts = document.option_sets.flatMap((set) =>
        set.groups.flatMap((group) =>
          group.options.flatMap((option) =>
            option.values.map((value) => value.price_config.amount_minor),
          ),
        ),
      );

      expect(amounts.length).toBeGreaterThan(0);
      amounts.forEach((amount) => expect(Number.isInteger(amount)).toBe(true));
    }, 120_000);

    it.each([
      ['tenancy', 'tenantId'],
      ['the row version', 'rowVersion'],
      ['audit timestamps', 'createdAt'],
      ['enable flags', 'isEnabled'],
      ['parent ids', 'optionGroupId'],
      ['the publisher', 'publishedBy'],
      ['the soft-delete sentinel', '1970'],
    ])('omits %s, as the contract says', async (_label, needle) => {
      await publishedSet('Absent');

      expect(JSON.stringify(await build())).not.toContain(needle);
    }, 120_000);

    /** The document is snake_case throughout — its reader is PHP. */
    it('uses no camelCase keys anywhere', async () => {
      await publishedSet('Casing');

      expect(JSON.stringify(await build())).not.toMatch(/"[a-z]+[A-Z][a-zA-Z]*":/);
    }, 120_000);
  });

  describe('scoping', () => {
    /**
     * A probe found one tenant could assemble another's full published config:
     * the store was looked up by id alone, and a comment claimed the caller
     * would supply a trustworthy id. Nothing enforced it.
     */
    it('refuses a store belonging to another tenant', async () => {
      await publishedSet('Mine');

      // A second real tenant, registered the same way as the first — building a
      // row by hand would encode this table's shape into a test about scoping.
      await tenant('b');
      const [other] = await dataSource.query(
        `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
          WHERE u.email = ?`,
        [`${NS}-b@example.com`],
      );
      const otherTenant = other.id as string;

      await expect(
        runWithContext({ requestId: 'test', startedAt: Date.now(), tenantId: otherTenant }, () =>
          builder.build(storeId),
        ),
      ).rejects.toThrow();
    }, 120_000);

    /**
     * A store token has no tenant — the token already resolved the store, so
     * there is nothing to narrow by. This must keep working, or Phase 9's
     * `GET /store/config` cannot be built on it.
     */
    it('serves a caller with no tenant, which is how a store token arrives', async () => {
      await publishedSet('ForStoreToken');

      const document = await runWithContext(
        { requestId: 'test', startedAt: Date.now() },
        () => builder.build(storeId),
      );

      expect(document.store_id).toBe(storeId);
      expect(document.option_sets.length).toBeGreaterThan(0);
    }, 120_000);
  });

  describe('snapshots older than the envelope', () => {
    /**
     * Snapshots are immutable and outlive the code that wrote them. One written
     * before `assignments` and `rules` joined the envelope carries neither, and
     * shipping it verbatim puts a document on a storefront that contradicts the
     * contract — a reader doing `foreach ($set['rules'])` warns on a key the
     * contract guarantees.
     */
    it('fills mandatory keys a older snapshot does not carry', async () => {
      const set = await publishedSet('Legacy');

      // A snapshot as 7g would have written it, before the envelope grew.
      await dataSource.query(
        `UPDATE option_set_versions SET snapshot = ? WHERE optionSetId = ? AND version = 1`,
        [JSON.stringify({ id: set, version: 1, groups: [] }), set],
      );

      const document = await build();
      const legacy = document.option_sets.find((candidate) => candidate.id === set);

      expect(legacy?.assignments).toEqual([]);
      expect(legacy?.rules).toEqual([]);
      expect(legacy?.groups).toEqual([]);
    }, 120_000);

    /** Filling a gap must not rewrite what was actually published. */
    it('does not alter the stored snapshot', async () => {
      const set = await publishedSet('Untouched');

      await dataSource.query(
        `UPDATE option_set_versions SET snapshot = ? WHERE optionSetId = ? AND version = 1`,
        [JSON.stringify({ id: set, version: 1, groups: [] }), set],
      );

      await build();

      const [row] = await dataSource.query(
        `SELECT snapshot FROM option_set_versions WHERE optionSetId = ? AND version = 1`,
        [set],
      );

      expect(Object.keys(row.snapshot).sort()).toEqual(['groups', 'id', 'version']);
    }, 120_000);

    it('leaves a complete snapshot exactly as written', async () => {
      const set = await publishedSet('Complete');

      const document = await build();
      const published = document.option_sets.find((candidate) => candidate.id === set);

      expect(published?.groups).toHaveLength(1);
      expect(published?.groups[0].options[0].values).toHaveLength(2);
    }, 120_000);
  });

  describe('reproducibility', () => {
    /**
     * The same content requested twice must be the same document. Only
     * `generated_at` may differ — everything else is a snapshot.
     */
    it('is identical apart from generated_at', async () => {
      await publishedSet('Stable');

      const first = await build();
      const second = await build();

      expect({ ...first, generated_at: '' }).toEqual({ ...second, generated_at: '' });
    }, 120_000);
  });

  describe('the contract document itself', () => {
    /**
     * The deliverable is a reference for two implementations. These assert that
     * what it promises is what the code does — a contract nobody checks drifts,
     * and the drift is discovered by a storefront.
     */
    it('documents every envelope field the builder emits', async () => {
      const document = await build();

      Object.keys(document).forEach((field) => {
        expect(CONTRACT).toContain(`\`${field}\``);
      });
    }, 60_000);

    it('documents every pricing type the registry can produce', () => {
      ['fixed', 'per_unit', 'percentage', 'per_char', 'tiered'].forEach((type) => {
        expect(CONTRACT).toContain(`"type": "${type}"`);
      });
    });

    it('states the rule that makes a version bump safe', () => {
      expect(CONTRACT).toContain('Bumping is a release, not an edit.');
      expect(CONTRACT).toContain('Adding a key a reader can ignore');
    });
  });
});
