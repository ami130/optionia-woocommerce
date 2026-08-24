import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { seedDemo } from '../src/seeds/demo.seed';
import { seedPlans } from '../src/seeds/plans.seed';

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
