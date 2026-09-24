import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { seedDemo } from '../src/seeds/demo.seed';
import { seedPlans } from '../src/seeds/plans.seed';
import { seedSuperAdmin } from '../src/seeds/super-admin.seed';

/**
 * Seeds, asserted against a real database.
 *
 * Idempotency was previously verified by hand, once. Nothing re-checked it — so
 * an edit that made `db:seed` duplicate plans on a second run would pass CI, and
 * a developer would discover it by finding six plans.
 *
 * That is the same gap the schema suite closed for delete rules: a guarantee
 * verified manually is a guarantee with no guard.
 */
describe('seeds (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    loadDotenv();
    dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    await dataSource?.destroy();
  });

  async function count(table: string): Promise<number> {
    const [row] = await dataSource.query(`SELECT COUNT(*) AS n FROM ${table}`);

    return Number(row.n);
  }

  /**
   * The demo tenant's own rows.
   *
   * ⚠️ **A global `COUNT(*)` was correct only while the seed was the sole writer.**
   * Phase 13's canonical E2E now registers tenants and imports a real WooCommerce
   * catalogue, so a global count folds in rows these assertions were never about —
   * and the idempotency check, which compares a count before and after re-seeding,
   * fails whenever another suite writes between the two reads.
   *
   * Scoping to the seeded tenant makes these tests measure the seed rather than
   * the database.
   */
  async function countForDemo(table: string): Promise<number> {
    const scoped: Record<string, string> = {
      tenants: `SELECT COUNT(*) AS n FROM tenants WHERE slug LIKE 'demo%'`,
      stores: `SELECT COUNT(*) AS n FROM stores WHERE storeUrl = 'https://demo.optionia.test'`,
      store_products: `SELECT COUNT(*) AS n FROM store_products p
                         JOIN stores s ON s.id = p.storeId
                        WHERE s.storeUrl = 'https://demo.optionia.test'`,
      option_sets: `SELECT COUNT(*) AS n FROM option_sets os
                      JOIN stores s ON s.id = os.storeId
                     WHERE s.storeUrl = 'https://demo.optionia.test'`,
      options: `SELECT COUNT(*) AS n FROM options o
                  JOIN option_groups g ON g.id = o.optionGroupId
                  JOIN option_sets os ON os.id = g.optionSetId
                  JOIN stores s ON s.id = os.storeId
                 WHERE s.storeUrl = 'https://demo.optionia.test'`,
      option_values: `SELECT COUNT(*) AS n FROM option_values v
                        JOIN options o ON o.id = v.optionId
                        JOIN option_groups g ON g.id = o.optionGroupId
                        JOIN option_sets os ON os.id = g.optionSetId
                        JOIN stores s ON s.id = os.storeId
                       WHERE s.storeUrl = 'https://demo.optionia.test'`,
      order_events: `SELECT COUNT(*) AS n FROM order_events e
                       JOIN stores s ON s.id = e.storeId
                      WHERE s.storeUrl = 'https://demo.optionia.test'`,
      order_selections: `SELECT COUNT(*) AS n FROM order_selections sel
                           JOIN order_events e ON e.id = sel.orderEventId
                           JOIN stores s ON s.id = e.storeId
                          WHERE s.storeUrl = 'https://demo.optionia.test'`,
    };

    const [row] = await dataSource.query(scoped[table] ?? `SELECT COUNT(*) AS n FROM ${table}`);

    return Number(row.n);
  }

  describe('db:seed', () => {
    /**
     * Re-running must update rather than duplicate. Plans are matched on `code`,
     * which is why this is also how a limit change is applied in development.
     */
    it('is idempotent', async () => {
      await seedPlans(dataSource);
      const first = await count('plans');

      await seedPlans(dataSource);
      const second = await count('plans');

      expect(second).toBe(first);
      expect(first).toBe(3);
    });

    /**
     * 🔴 **A price change with no record of it is the defect this closes.**
     * Seeding retires a price row and writes a replacement — the same operation
     * a staff price edit will perform (M26.5) — and nothing said which price
     * replaced which. The first merchant to dispute a charge makes *"what were
     * they pinned to, and when did that change?"* a question the database has
     * to answer.
     *
     * ⚠️ **Asserted on the DIFF, not merely on the row's existence.** An entry
     * saying *"the price changed"* is not actionable; `2900 → 4900` is, and a
     * test that only counted rows would pass on the useless version.
     */
    it('records a superseded price with both amounts', async () => {
      await seedPlans(dataSource);

      /*
       * ⚠️ **The price is changed on the PRICE row, not the plan row.**
       * `seedPlans` rewrites the plan from its own `PLANS` constant before
       * reading it, so a first draft that did `UPDATE plans SET
       * priceMonthlyMinor = 3900` had its change reverted in the same call and
       * asserted against a supersession that never happened. Retiring the
       * current price is what makes the next seed write a replacement — which
       * is also the shape of a real staff edit.
       */
      await dataSource.query(
        `UPDATE plan_prices pp JOIN plans p ON p.id = pp.planId
            SET pp.amountMinor = 3900
          WHERE p.code = 'pro' AND pp.interval = 'month' AND pp.isCurrent = 1`,
      );

      await seedPlans(dataSource);

      const entries: Array<{ action: string; changes: string | object }> =
        await dataSource.query(
          `SELECT action, changes FROM audit_logs
            WHERE action = 'plan_price.superseded' AND resourceType = 'plan_price'
            ORDER BY id DESC LIMIT 1`,
        );

      expect(entries).toHaveLength(1);

      const changes =
        typeof entries[0].changes === 'string'
          ? (JSON.parse(entries[0].changes) as Record<string, unknown>)
          : (entries[0].changes as Record<string, unknown>);

      expect(changes.plan).toBe('pro');
      expect(changes.amountMinor).toEqual({ from: 3900, to: 2900 });

      /* A seed belongs to no person, and the row says so rather than guessing. */
      expect(changes.source).toBe('seed');

      /*
       * The seed has already restored 2900 as the current price; the 3900 row
       * is retired and stays, which is the point of supersession.
       */
    });

    it('creates the three plans with measurable limits', async () => {
      await seedPlans(dataSource);

      const plans: Array<{ code: string; limits: string | object }> = await dataSource.query(
        `SELECT code, limits FROM plans ORDER BY sortOrder`,
      );

      expect(plans.map((p) => p.code)).toEqual(['free', 'pro', 'business']);

      // Every limit key needs a counter in usage_records — a limit that cannot
      // be measured cannot be sold (M24.1). This asserts the keys are present
      // and typed, not that the numbers are final: they are provisional pending
      // D2 (ADR-019).
      for (const plan of plans) {
        const limits =
          typeof plan.limits === 'string'
            ? (JSON.parse(plan.limits) as Record<string, number | null>)
            : (plan.limits as Record<string, number | null>);

        for (const key of ['option_sets', 'products_assigned', 'stores', 'team_seats']) {
          expect(limits).toHaveProperty(key);
          // null means unlimited; anything else must be a number.
          expect(limits[key] === null || typeof limits[key] === 'number').toBe(true);
        }
      }
    });
  });

  describe('db:seed:demo', () => {
    beforeAll(async () => {
      await seedPlans(dataSource);
      await seedDemo(dataSource);
    }, 60_000);

    /**
     * Rebuilt rather than accumulated. Verified by running it twice and
     * comparing every count that could drift.
     */
    it('is idempotent across a full re-run', async () => {
      const tables = [
        'tenants',
        'stores',
        'store_products',
        'option_sets',
        'options',
        'option_values',
        'order_events',
        'order_selections',
      ];

      const before = await Promise.all(tables.map(countForDemo));

      await seedDemo(dataSource);

      const after = await Promise.all(tables.map(countForDemo));

      expect(after).toEqual(before);
    }, 60_000);

    /**
     * The volume is the point. 50 orders producing 100–200 selections is what
     * makes Phase 25's analytics meaningful rather than returning a single row.
     */
    it('produces enough order data for analytics to be meaningful', async () => {
      /* Scoped like every other seed count — see `countForDemo`. */
      expect(await countForDemo('order_events')).toBe(50);

      const selections = await countForDemo('order_selections');
      expect(selections).toBeGreaterThanOrEqual(100);
      expect(selections).toBeLessThanOrEqual(200);
    });

    /**
     * The analytics query the index exists for must return a distribution, not
     * one row — otherwise `ix_order_selections_analytics` looks speculative.
     */
    it('spreads selections across several values', async () => {
      const rows = await dataSource.query(
        `SELECT optionKey, valueKey, COUNT(*) AS n
           FROM order_selections
          GROUP BY optionKey, valueKey`,
      );

      expect(rows.length).toBeGreaterThan(5);
    });

    /**
     * A builder that feels responsive with four options is the reason M28.5
     * requires testing with a hundred. Without a large set in the fixture, the
     * first person to notice the builder crawling is a merchant.
     */
    it('includes a large option set for builder performance', async () => {
      const [row] = await dataSource.query(
        `SELECT MAX(n) AS largest FROM (
           SELECT COUNT(*) AS n FROM options o
             JOIN option_groups g ON g.id = o.optionGroupId
            GROUP BY g.optionSetId
         ) x`,
      );

      expect(Number(row.largest)).toBeGreaterThanOrEqual(40);
    });

    /**
     * **The fixture must contain something disabled.**
     *
     * Every one of the 186 seeded rows was enabled, so a serializer that ignored
     * `is_enabled` entirely would produce a config document identical to a
     * correct one — the exclusion M7.2 requires would be tested only by code
     * written to test it, never by the data developers work against.
     *
     * The same gap as the missing 40-option set in Phase 5: a state the schema
     * supports and the fixture never reaches.
     */
    /**
     * 🔴 **Every published set carries the snapshot a storefront reads (S0-2).**
     *
     * This seed used to mark sets `PUBLISHED` and write `publishedAt` while
     * creating no `option_set_versions` row — a state the publish path can never
     * produce, since it writes both in one transaction.
     *
     * `ConfigDocumentBuilder` looks each published set up as
     * `optionSetId:version` and **skips** what it cannot find, deliberately, so
     * one corrupt set cannot take a whole storefront down. The consequence was
     * silent: a demo showed five published option sets and the storefront
     * rendered none of them. Measured before the fix: 4 such sets.
     */
    it('gives every published set a snapshot at its current version', async () => {
      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM option_sets o
          WHERE o.publishedAt IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM option_set_versions v
                             WHERE v.optionSetId = o.id AND v.version = o.version)`,
      );

      expect(Number(row.n)).toBe(0);
    });

    /**
     * A snapshot present but empty would satisfy the check above and still serve
     * a storefront nothing, so the content is asserted too.
     */
    it('fills those snapshots with the set’s groups and options', async () => {
      const [row] = await dataSource.query(
        `SELECT MIN(JSON_LENGTH(v.snapshot->'$.groups')) AS minGroups,
                MIN(JSON_LENGTH(v.snapshot->'$.groups[0].options')) AS minOptions
           FROM option_set_versions v WHERE v.note = 'Seeded demo data.'`,
      );

      expect(Number(row.minGroups)).toBeGreaterThanOrEqual(1);
      expect(Number(row.minOptions)).toBeGreaterThanOrEqual(1);
    });

    /**
     * 📌 **The disabled option is absent from the snapshot, and that is correct.**
     *
     * `toPublished` filters disabled options out of the published projection
     * (M7.2), so the seeded set with a disabled seasonal option has two options
     * in the database and one in its snapshot. Asserted because it is the first
     * time that exclusion is observable in a *published document* rather than
     * only in the serializer's own unit tests — and because a future change that
     * started publishing disabled rows would otherwise pass every other check.
     */
    it('omits a disabled option from the published snapshot', async () => {
      const [row] = await dataSource.query(
        `SELECT COUNT(DISTINCT op.id) AS dbOptions,
                JSON_LENGTH(v.snapshot->'$.groups[0].options') AS snapOptions
           FROM option_sets o
           JOIN option_set_versions v
             ON v.optionSetId = o.id AND v.note = 'Seeded demo data.'
           JOIN option_groups g ON g.optionSetId = o.id
           LEFT JOIN options op ON op.optionGroupId = g.id
          GROUP BY o.id, v.snapshot
          HAVING dbOptions > snapOptions
          LIMIT 1`,
      );

      // Exactly the seasonal set: more options stored than published.
      expect(row).toBeDefined();
      expect(Number(row.dbOptions)).toBeGreaterThan(Number(row.snapOptions));
    });

    it('includes a disabled option and a disabled value', async () => {
      const [options] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM options WHERE isEnabled = 0`,
      );
      const [values] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM option_values WHERE isEnabled = 0`,
      );

      expect(Number(options.n)).toBeGreaterThanOrEqual(1);
      expect(Number(values.n)).toBeGreaterThanOrEqual(1);
    });

    /**
     * The disabled value sits inside an *enabled* option, so the two levels can
     * be exercised independently rather than only together.
     */
    it('puts the disabled value inside an enabled option', async () => {
      const [row] = await dataSource.query(
        `SELECT o.isEnabled AS parentEnabled FROM option_values v
           JOIN options o ON o.id = v.optionId
          WHERE v.isEnabled = 0 LIMIT 1`,
      );

      expect(Boolean(row.parentEnabled)).toBe(true);
    });

    /** Disabled rows keep their children, so re-enabling restores everything. */
    it('keeps the disabled option’s values intact', async () => {
      const [row] = await dataSource.query(
        `SELECT COUNT(v.id) AS n FROM options o
           JOIN option_values v ON v.optionId = o.id
          WHERE o.isEnabled = 0`,
      );

      expect(Number(row.n)).toBeGreaterThanOrEqual(2);
    });

    it('creates the catalogue the product picker needs', async () => {
      /*
       * ⚠️ Scoped to the **seeded** store. `count('store_products')` is a global
       * count, and it was correct only while the demo seed was the sole writer of
       * that table. Phase 13's canonical E2E now imports a real WooCommerce
       * catalogue into a store of its own, so the global figure counts rows this
       * assertion was never about — measured: 32 against an expected 30, with the
       * seed itself perfectly correct.
       */
      const [row] = (await dataSource.query(
        `SELECT COUNT(*) AS n
           FROM store_products p
           JOIN stores s ON s.id = p.storeId
          WHERE s.storeUrl = 'https://demo.optionia.test'`,
      )) as Array<{ n: number }>;

      expect(Number(row.n)).toBe(30);
    });

    /**
     * Deterministic across machines. `Math.random()` would make an E2E test
     * asserting "the top-selling value is X" pass locally and fail in CI for no
     * reason a developer could reproduce.
     */
    it('produces the same fixture on every run', async () => {
      const [first] = await dataSource.query(
        `SELECT optionKey, valueKey, COUNT(*) AS n
           FROM order_selections GROUP BY optionKey, valueKey
          ORDER BY n DESC, optionKey, valueKey LIMIT 1`,
      );

      await seedDemo(dataSource);

      const [second] = await dataSource.query(
        `SELECT optionKey, valueKey, COUNT(*) AS n
           FROM order_selections GROUP BY optionKey, valueKey
          ORDER BY n DESC, optionKey, valueKey LIMIT 1`,
      );

      expect(second).toEqual(first);
    }, 60_000);
  });

  /**
   * The account creation path, which no test reached before.
   *
   * `seedSuperAdmin` is the only seed that writes a credential, and CI runs it
   * with no `SEED_ADMIN_*` set — so the branch that actually creates the account
   * had never executed in an automated check (ADR-021). The password guard is
   * unit-tested; this covers what happens after it passes.
   */
  describe('db:seed — super admin', () => {
    const original = { ...process.env };
    const ADMIN_EMAIL = 'audit-admin@example.com';

    /**
     * Remove the account this suite creates. A test that leaves a super admin
     * behind makes any later "how many staff exist" assertion depend on whether
     * this file ran first.
     */
    async function removeSeededAdmin(): Promise<void> {
      await dataSource.query(
        `DELETE ps FROM platform_staff ps JOIN users u ON u.id = ps.userId WHERE u.email = ?`,
        [ADMIN_EMAIL],
      );
      await dataSource.query(`DELETE FROM users WHERE email = ?`, [ADMIN_EMAIL]);
    }

    afterEach(async () => {
      process.env = { ...original };
      await removeSeededAdmin();
    });

    it('creates a verified user and grants the super_admin role', async () => {
      process.env.SEED_ADMIN_EMAIL = 'audit-admin@example.com';
      process.env.SEED_ADMIN_PASSWORD = 'a-sufficiently-long-password';

      await seedSuperAdmin(dataSource);

      const [user] = await dataSource.query(
        `SELECT id, email, emailVerifiedAt, passwordHash FROM users WHERE email = ?`,
        ['audit-admin@example.com'],
      );

      expect(user).toBeDefined();

      // Pre-verified: whoever controls the environment created it, so an email
      // round-trip proves nothing extra.
      expect(user.emailVerifiedAt).not.toBeNull();

      // The password must never be recoverable from the row.
      expect(user.passwordHash).not.toContain('a-sufficiently-long-password');
      expect(user.passwordHash.startsWith('$2')).toBe(true);

      const [staff] = await dataSource.query(
        `SELECT role FROM platform_staff WHERE userId = ?`,
        [user.id],
      );

      expect(staff?.role).toBe('super_admin');
    }, 30_000);

    /**
     * Re-running must not create a second account or a duplicate staff grant —
     * `db:seed` is run repeatedly in development.
     */
    it('is idempotent', async () => {
      process.env.SEED_ADMIN_EMAIL = 'audit-admin@example.com';
      process.env.SEED_ADMIN_PASSWORD = 'a-sufficiently-long-password';

      await seedSuperAdmin(dataSource);
      await seedSuperAdmin(dataSource);

      const [{ n: users }] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM users WHERE email = ?`,
        ['audit-admin@example.com'],
      );
      const [{ n: staff }] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM platform_staff ps
           JOIN users u ON u.id = ps.userId WHERE u.email = ?`,
        ['audit-admin@example.com'],
      );

      expect(Number(users)).toBe(1);
      expect(Number(staff)).toBe(1);
    }, 30_000);

    /**
     * The email is normalised, so the same person cannot end up with two
     * accounts differing only in case.
     */
    it('normalises the email to lower case', async () => {
      process.env.SEED_ADMIN_EMAIL = '  AUDIT-Admin@Example.COM  ';
      process.env.SEED_ADMIN_PASSWORD = 'a-sufficiently-long-password';

      await seedSuperAdmin(dataSource);

      const [{ n }] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM users WHERE email = ?`,
        ['audit-admin@example.com'],
      );

      expect(Number(n)).toBe(1);
    }, 30_000);
  });

  describe('safety', () => {
    /**
     * A seed that can reach production eventually will — the command is short
     * and typed from a terminal that may have the wrong `.env` loaded. Demo data
     * in a merchant's database is corrupt revenue, not a mess to clean up.
     *
     * Asserted on the guard's own condition rather than by spawning a process,
     * so the test cannot itself connect somewhere it should not.
     */
    it('refuses to seed when NODE_ENV is production', async () => {
      const { openSeedConnection } = await import('../src/seeds/seed-context');

      const original = process.env.NODE_ENV;
      const originalSsl = process.env.DB_SSL;
      const originalSmtp = process.env.SMTP_HOST;

      process.env.NODE_ENV = 'production';
      process.env.DB_SSL = 'true';

      // `loadConfig` also refuses production without SMTP, and that guard runs
      // first. Without a host here the seed would be rejected for the wrong
      // reason and this test would prove nothing about the seed guard.
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '587';
      process.env.SMTP_USER = 'sender@example.com';
      process.env.SMTP_PASS = 'app-password';

      // Production also requires APP_URL, and that check runs before the seed
      // guard. Without it this test would pass on the wrong error — which is how
      // a test keeps passing after the guarantee it describes has been deleted.
      process.env.APP_URL = 'https://app.example.com';

      try {
        await expect(openSeedConnection('db:seed')).rejects.toThrow(/refuses to run/);
      } finally {
        process.env.NODE_ENV = original;
        process.env.DB_SSL = originalSsl;
        process.env.SMTP_HOST = originalSmtp;
        delete process.env.APP_URL;
        delete process.env.SMTP_PORT;
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
      }
    });
  });
});
