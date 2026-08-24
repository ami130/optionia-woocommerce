import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';

/**
 * Schema guarantees, asserted against a real database.
 *
 * These constraints exist only in MySQL — no unit test can observe them, and
 * `migration:run` proves the migration executes rather than that it produced the
 * intended schema.
 *
 * Each assertion here corresponds to a decision that is expensive to get wrong:
 * a delete rule that silently regresses to `RESTRICT` makes GDPR user erasure
 * impossible, and a `deletedAt` that becomes nullable makes the uniqueness
 * constraint enforce nothing. Both would pass CI without this file.
 */
describe('schema (integration)', () => {
  let dataSource: DataSource;
  let schema: string;

  beforeAll(async () => {
    loadDotenv();

    const config = loadConfig();
    schema = config.database.name;

    dataSource = new DataSource(buildDataSourceOptions(config));
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  /** The delete rule MySQL actually holds for a foreign key. */
  async function deleteRule(table: string, column: string): Promise<string | null> {
    const rows: Array<{ rule: string }> = await dataSource.query(
      `SELECT r.DELETE_RULE AS rule
         FROM information_schema.REFERENTIAL_CONSTRAINTS r
         JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
          AND k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA
        WHERE r.CONSTRAINT_SCHEMA = ? AND r.TABLE_NAME = ? AND k.COLUMN_NAME = ?`,
      [schema, table, column],
    );

    return rows[0]?.rule ?? null;
  }

  async function column(
    table: string,
    name: string,
  ): Promise<{ IS_NULLABLE: string; COLUMN_DEFAULT: string | null; DATA_TYPE: string } | null> {
    const rows = await dataSource.query(
      `SELECT IS_NULLABLE, COLUMN_DEFAULT, DATA_TYPE
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [schema, table, name],
    );

    return rows[0] ?? null;
  }

  describe('delete rules', () => {
    /**
     * The consequential one. Under `RESTRICT`, deleting a user would be
     * impossible while any audit entry referenced them — and Phase 26b requires
     * erasing a user on request.
     *
     * The log must record that an action happened even after the actor is gone:
     * the action, resource and diff carry the meaning, and the identity is
     * precisely the part being erased.
     */
    it('audit_logs keeps its rows when the actor is erased', async () => {
      expect(await deleteRule('audit_logs', 'userId')).toBe('SET NULL');
      expect(await deleteRule('audit_logs', 'tenantId')).toBe('SET NULL');
    });

    /**
     * Financial records. Disconnecting a store must not silently take its
     * revenue history — a merchant reconnecting later, or an accountant asking
     * about last quarter, both depend on these surviving.
     */
    it('order_events survive a store being deleted', async () => {
      expect(await deleteRule('order_events', 'storeId')).toBe('RESTRICT');
    });

    /**
     * The record of staff acting as a merchant. It must not be removable by
     * deleting either party.
     */
    it('impersonation_sessions cannot be deleted away from either side', async () => {
      expect(await deleteRule('impersonation_sessions', 'staffUserId')).toBe('RESTRICT');
      expect(await deleteRule('impersonation_sessions', 'tenantId')).toBe('RESTRICT');
    });

    /**
     * Deleting a tenant with live stores must fail loudly rather than quietly
     * disconnecting storefronts. But once a store is genuinely gone, its option
     * sets have nothing left to render on.
     */
    it('distinguishes tenant deletion from store deletion', async () => {
      expect(await deleteRule('stores', 'tenantId')).toBe('RESTRICT');
      expect(await deleteRule('option_sets', 'tenantId')).toBe('RESTRICT');
      expect(await deleteRule('option_sets', 'storeId')).toBe('CASCADE');
    });

    it('cascades structural children that cannot exist alone', async () => {
      expect(await deleteRule('option_groups', 'optionSetId')).toBe('CASCADE');
      expect(await deleteRule('options', 'optionGroupId')).toBe('CASCADE');
      expect(await deleteRule('option_values', 'optionId')).toBe('CASCADE');
      expect(await deleteRule('order_selections', 'orderEventId')).toBe('CASCADE');
    });
  });

  describe('soft delete sentinel', () => {
    const softDeletable = [
      'option_sets',
      'option_groups',
      'options',
      'option_values',
      'option_rules',
      'option_set_assignments',
      'presentational_items',
    ];

    /**
     * `deletedAt` must be NOT NULL with the epoch as its default.
     *
     * With a nullable column the unique constraint enforces nothing: `NULL !=
     * NULL` in a MySQL unique index, so every live row is distinct from every
     * other and unlimited duplicates are accepted. Verified in ADR-014.
     */
    it.each(softDeletable)('%s uses the sentinel, never NULL', async (table) => {
      const meta = await column(table, 'deletedAt');

      expect(meta).not.toBeNull();
      expect(meta!.IS_NULLABLE).toBe('NO');
      expect(meta!.COLUMN_DEFAULT).toMatch(/^1970-01-01 00:00:00(\.000)?$/);
    });

    /**
     * The behaviour the sentinel exists to produce, exercised end to end rather
     * than inferred from the column definition.
     */
    it('blocks a duplicate live key and permits reuse after deletion', async () => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();

      try {
        await runner.query(
          `INSERT INTO plans (id, code, name, priceMonthlyMinor, priceYearlyMinor, currency, limits, features, isPublic, sortOrder)
           VALUES ('sp1','sentinel-probe','P',0,0,'USD','{}','{}',0,0)`,
        );
        await runner.query(
          `INSERT INTO tenants (id, name, slug, status, planId)
           VALUES ('st1','T','sentinel-probe','active','sp1')`,
        );
        await runner.query(
          `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion)
           VALUES ('ss1','st1','woocommerce','S','http://sentinel.probe','connected',0)`,
        );
        await runner.query(
          `INSERT INTO option_sets (id, tenantId, storeId, name, status, version, rowVersion, publishedConfigVersion)
           VALUES ('sos1','st1','ss1','Set','draft',0,0,0)`,
        );
        await runner.query(
          `INSERT INTO option_groups (id, optionSetId, label, displayType, sortOrder, isCollapsible)
           VALUES ('sg1','sos1','G','inline',0,0)`,
        );

        const insertOption = (id: string): Promise<unknown> =>
          runner.query(
            `INSERT INTO options (id, optionGroupId, \`key\`, valueKind, cardinality, presentation, label, isRequired, sortOrder)
             VALUES (?, 'sg1', 'size', 'choice', 'one', 'radio', 'Size', 0, 0)`,
            [id],
          );

        await insertOption('so1');

        // A second live row with the same key must be rejected.
        await expect(insertOption('so2')).rejects.toThrow(/Duplicate entry/);

        // After soft-deleting the first, the key becomes available again.
        await runner.query(`UPDATE options SET deletedAt = NOW(3) WHERE id = 'so1'`);
        await expect(insertOption('so2')).resolves.toBeDefined();

        const [{ live }] = await runner.query(
          `SELECT SUM(deletedAt = '1970-01-01 00:00:00.000') AS live FROM options WHERE optionGroupId = 'sg1'`,
        );

        expect(Number(live)).toBe(1);
      } finally {
        // Rolled back rather than deleted, so the test leaves no trace even if
        // an assertion fails partway through.
        await runner.rollbackTransaction();
        await runner.release();
      }
    });
  });

  describe('money columns', () => {
    /**
     * ADR-013: integer minor units, never DECIMAL. Storing decimals would make
     * the database the only place a conversion happens, and conversions are
     * where rounding bugs live.
     */
    it('are all BIGINT', async () => {
      const rows: Array<{ t: string; c: string; type: string }> = await dataSource.query(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS type
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND COLUMN_NAME LIKE '%Minor'`,
        [schema],
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.type).toBe('bigint');
      }
    });

    it('leaves no DECIMAL column anywhere', async () => {
      const [{ count }] = await dataSource.query(
        `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND DATA_TYPE = 'decimal'`,
        [schema],
      );

      expect(Number(count)).toBe(0);
    });
  });

  describe('idempotency constraints', () => {
    /**
     * Each of these is what makes a retry safe. Providers retry webhooks on any
     * non-2xx and the plugin retries order reporting on a network failure —
     * without these a duplicate delivery is a second charge or double-counted
     * revenue.
     */
    it.each([
      ['billing_events', 'provider,providerEventId'],
      ['order_events', 'storeId,externalOrderId'],
      ['store_products', 'storeId,externalId'],
    ])('%s is unique on (%s)', async (table, columns) => {
      const rows: Array<{ cols: string }> = await dataSource.query(
        `SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0
          GROUP BY INDEX_NAME`,
        [schema, table],
      );

      expect(rows.map((r) => r.cols)).toContain(columns);
    });
  });

  describe('tenant scoping', () => {
    /**
     * The Phase 5 exit criterion. Four tables are outside tenant scope by
     * design, and every other table must reach a tenant somehow — otherwise the
     * scoped repository (M6.4) has nothing to scope on.
     */
    const OUTSIDE_TENANT_SCOPE = new Set([
      'tenants', // is the tenant
      'platform_staff', // the other realm — deliberately separate (M6.5)
      'plans', // global product catalogue
      'users', // one person, several tenants
      'billing_events', // arrives before the tenant is resolved
      'migrations', // TypeORM's own
    ]);

    it('every other table reaches a tenant', async () => {
      const tables: Array<{ t: string }> = await dataSource.query(
        `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
        [schema],
      );

      const direct: Array<{ t: string }> = await dataSource.query(
        `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'tenantId'`,
        [schema],
      );

      const links: Array<{ child: string; parent: string }> = await dataSource.query(
        `SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [schema],
      );

      const hasTenantId = new Set(direct.map((r) => r.t));
      const parents = new Map<string, string[]>();
      for (const { child, parent } of links) {
        parents.set(child, [...(parents.get(child) ?? []), parent]);
      }

      const reaches = (table: string, seen = new Set<string>()): boolean => {
        if (hasTenantId.has(table)) return true;
        if (seen.has(table)) return false;
        seen.add(table);

        return (parents.get(table) ?? []).some((parent) => reaches(parent, seen));
      };

      const orphans = tables
        .map((r) => r.t)
        .filter((t) => !OUTSIDE_TENANT_SCOPE.has(t) && !reaches(t));

      expect(orphans).toEqual([]);
    });
  });
});
