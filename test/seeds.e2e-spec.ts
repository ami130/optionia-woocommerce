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

      const before = await Promise.all(tables.map(count));

      await seedDemo(dataSource);

      const after = await Promise.all(tables.map(count));

      expect(after).toEqual(before);
    }, 60_000);

    /**
     * The volume is the point. 50 orders producing 100–200 selections is what
     * makes Phase 25's analytics meaningful rather than returning a single row.
     */
    it('produces enough order data for analytics to be meaningful', async () => {
      expect(await count('order_events')).toBe(50);

      const selections = await count('order_selections');
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

    it('creates the catalogue the product picker needs', async () => {
      expect(await count('store_products')).toBe(30);
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

      process.env.NODE_ENV = 'production';
      process.env.DB_SSL = 'true';

      try {
        await expect(openSeedConnection('db:seed')).rejects.toThrow(/refuses to run/);
      } finally {
        process.env.NODE_ENV = original;
        process.env.DB_SSL = originalSsl;
      }
    });
  });
});
