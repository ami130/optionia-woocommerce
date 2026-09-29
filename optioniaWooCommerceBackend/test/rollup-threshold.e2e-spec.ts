import { DataSource } from 'typeorm';

import { RollupThresholdService } from '../src/analytics/rollup-threshold.service';
import { createHarness, type Harness } from './harness';

/**
 * M25.2 — the deferral now has a trigger (F-rollup).
 *
 * ## Why this suite exists rather than the rollup tables
 *
 * 🔴 **The deferral was an intention, and this makes it a mechanism.** Rollups
 * are worth **3.5×** at 480k selections and **nothing** at 60k, so building them
 * now pays a write cost on every order for a read that is already fast. That
 * decision is right and stays — but nothing watched the figure, so the first
 * sign of crossing it would have been a merchant reporting a slow dashboard.
 *
 * ⚠️ **The threshold is lowered for these tests, never the assertion.** Seeding
 * 100,000 selections to prove a boundary would make this suite the slowest in
 * the repository to assert something a smaller number proves identically. What
 * is under test is the comparison, not the constant.
 */
describe('Rollup threshold monitor (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let service: RollupThresholdService;
  let storeId: string;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness('rollup');
    dataSource = h.dataSource;

    await h.tenant('owner');
    storeId = await h.store('owner');
    tenantId = await h.tenantIdOf('owner');

    service = h.app.get(RollupThresholdService, { strict: false });
  }, 120_000);

  afterAll(async () => {
    await clear();
    await h.close();
  });

  async function clear(): Promise<void> {
    await dataSource.query(
      `DELETE sel FROM order_selections sel JOIN order_events e ON e.id = sel.orderEventId
        WHERE e.storeId = ?`,
      [storeId],
    );
    await dataSource.query(`DELETE FROM order_events WHERE storeId = ?`, [storeId]);
  }

  beforeEach(clear);

  /** `count` selections on one order, which is all the monitor counts. */
  async function seed(count: number): Promise<void> {
    const [{ id }] = (await dataSource.query(
      `SELECT UUID() AS id`,
    )) as { id: string }[];

    await dataSource.query(
      `INSERT INTO order_events
         (id, storeId, externalOrderId, orderTotalMinor, currency, optionRevenueMinor,
          occurredAt, createdAt, updatedAt)
       VALUES (?, ?, ?, 1000, 'GBP', 100, NOW(3), NOW(3), NOW(3))`,
      [id, storeId, `rollup-${Date.now()}-${count}`],
    );

    for (let i = 0; i < count; i += 1) {
      await dataSource.query(
        `INSERT INTO order_selections
           (id, orderEventId, optionKey, optionLabel, valueKey, valueLabel,
            optionSetId, productRef, priceDeltaMinor, configVersion, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, 'Option', 'v', 'V', NULL, NULL, 10, 1, NOW(3), NOW(3))`,
        [id, `opt-${i}`],
      );
    }
  }

  /**
   * 🔴 **The whole point: a tenant past the threshold is reported.** Without
   * this the deferral is a note asking a human to remember, which this
   * repository has recorded as insufficient more than once.
   */
  it('reports a tenant that has crossed the threshold', async () => {
    await seed(6);

    const original = RollupThresholdService.THRESHOLD;

    /* The comparison is under test, not the constant. */
    Object.defineProperty(RollupThresholdService, 'THRESHOLD', { value: 5, configurable: true });

    try {
      const rows = await service.approaching();
      const mine = rows.find((row) => row.tenantId === tenantId);

      expect(mine).toBeDefined();
      expect(mine?.selections).toBe(6);

      const outcome = await service.check();

      expect(outcome.crossed).toBeGreaterThanOrEqual(1);
    } finally {
      Object.defineProperty(RollupThresholdService, 'THRESHOLD', {
        value: original,
        configurable: true,
      });
    }
  }, 60_000);

  /**
   * 🔴 **A tenant APPROACHING is reported before it crosses.** Building rollups
   * is a migration and a backfill; being told on the day the dashboard slows
   * leaves no room to do it deliberately. 80% is roughly a quarter of the
   * tenant's growth as notice.
   */
  it('reports a tenant approaching the threshold, before it crosses', async () => {
    await seed(9);

    const original = RollupThresholdService.THRESHOLD;

    /* 9 of 10 is 90%, past the 80% floor and below the threshold itself. */
    Object.defineProperty(RollupThresholdService, 'THRESHOLD', { value: 10, configurable: true });

    try {
      /*
       * ⚠️ **Asserted on THIS tenant's row, not on the platform-wide counts.**
       * `check()` counts every tenant in the database, and a full e2e run leaves
       * other suites' orders in place — 147 selections on a neighbouring tenant
       * made `crossed` non-zero here for a reason that had nothing to do with
       * the case. The monitor is deliberately platform-wide; the assertion must
       * not be.
       */
      const rows = await service.approaching();
      const mine = rows.find((row) => row.tenantId === tenantId);

      expect(mine).toBeDefined();
      expect(mine?.selections).toBe(9);
      expect(mine?.selections).toBeLessThan(RollupThresholdService.THRESHOLD);

      /* And `check()` still runs cleanly over whatever else is present. */
      const outcome = await service.check();

      expect(outcome.approaching + outcome.crossed).toBeGreaterThanOrEqual(1);
    } finally {
      Object.defineProperty(RollupThresholdService, 'THRESHOLD', {
        value: original,
        configurable: true,
      });
    }
  }, 60_000);

  /**
   * 📌 **Silent when nothing is near.** A monitor that logs on every pass is one
   * an operator learns to filter out — and then the line that matters is
   * filtered with it.
   */
  it('says nothing about a tenant well below the threshold', async () => {
    await seed(2);

    const rows = await service.approaching();

    expect(rows.find((row) => row.tenantId === tenantId)).toBeUndefined();
  }, 60_000);

  /**
   * 🔴 **The real threshold is the measured one.** A constant quietly changed to
   * a convenient number would make every assertion above pass while watching for
   * the wrong thing — the measurement is in the plan and this pins it.
   */
  it('watches the measured threshold, not a convenient one', () => {
    expect(RollupThresholdService.THRESHOLD).toBe(100_000);
    expect(RollupThresholdService.APPROACHING).toBe(0.8);
  });
});
