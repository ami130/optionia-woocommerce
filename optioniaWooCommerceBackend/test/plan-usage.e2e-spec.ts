/* ⚠️ `* as`, not a default import — the same esModuleInterop gap as `stripe`. */
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import type { PlanUsage } from '../src/usage/plan-limit.guard';
import { createHarness, type Harness } from './harness';

/**
 * M24.4 — what a downgraded merchant is told, over HTTP.
 *
 * ## Why this is the whole milestone
 *
 * 🔴 **Three of M24.4's four requirements were already met by construction**,
 * verified rather than assumed: the guard refuses at `current < limit` so an
 * over-limit tenant is already blocked; no limit check exists in `publishing/`
 * or `config-delivery/`, so existing work keeps serving; and the lifecycle
 * deletes no merchant row on a plan change.
 *
 * 📌 **What was missing is the fourth**: *"prompt for explicit choices about
 * what to disable"* is impossible while nothing reports what the merchant is
 * over on. This suite is that report.
 *
 * ⚠️ **It reports and never repairs.** Offering to delete the excess would be
 * the silent deletion the milestone forbids, with a dialog in front of it.
 */
describe('Plan usage reporting (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let token: string;
  let storeId: string;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness('planusage');
    dataSource = h.dataSource;

    token = await h.tenant('owner');
    storeId = await h.store('owner');
    tenantId = await h.tenantIdOf('owner');

    /* A small, explicit allowance so "over" is reachable without bulk fixtures. */
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 2) WHERE code = 'free'`,
    );

    await dataSource.query(
      `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = 'free') WHERE id = ?`,
      [tenantId],
    );
  }, 120_000);

  afterAll(async () => {
    /* ⚠️ Restored, or every later suite inherits a limit of 2 (the K4 pattern). */
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 10) WHERE code = 'free'`,
    );

    await dataSource.query(
      `DELETE FROM option_sets WHERE tenantId IN
         (SELECT id FROM tenants WHERE slug LIKE 'planusage-%')`,
    );

    await h.cleanup();
    await h.close();
  });

  async function usage(): Promise<PlanUsage[]> {
    const response = await request(h.app.getHttpServer())
      .get('/v1/billing/subscription')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);

    return response.body.data.usage as PlanUsage[];
  }

  function find(rows: PlanUsage[], metric: string): PlanUsage {
    const row = rows.find((r) => r.metric === metric);

    expect(row).toBeDefined();

    return row as PlanUsage;
  }

  async function makeSet(name: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO option_sets (id, tenantId, storeId, name, createdAt, updatedAt)
       VALUES (UUID(), ?, ?, ?, NOW(3), NOW(3))`,
      [tenantId, storeId, name],
    );
  }

  /**
   * 🔴 **It rides with the plan, not on a second endpoint.** Two requests could
   * show a plan and a usage figure fetched moments apart — a merchant who just
   * upgraded would see their new plan beside their old verdict.
   */
  it('arrives on the subscription summary the dashboard already calls', async () => {
    const rows = await usage();

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  /**
   * 📌 **Every metered metric, not only the breached ones.** A card reading
   * "1 of 2 option sets" before the merchant is blocked is the difference
   * between a warning and a surprise.
   */
  it('reports a tenant that is comfortably under its limits', async () => {
    await makeSet('First');

    const row = find(await usage(), 'option_sets');

    expect(row).toMatchObject({ current: 1, limit: 2, atLimit: false, overLimit: false });
  });

  /**
   * ⚠️ **At the limit is not over it.** The merchant is blocked from creating
   * more, but they chose this state — the banner asking them to disable
   * something is for the merchant who did not.
   */
  it('distinguishes at-limit from over-limit', async () => {
    await makeSet('Second');

    const row = find(await usage(), 'option_sets');

    expect(row).toMatchObject({ current: 2, limit: 2, atLimit: true, overLimit: false });
  });

  /**
   * 🔴 **The downgrade case, which is what M24.4 is for.** A merchant whose
   * plan shrank under them holds more than they may create — and must be told
   * which metric and by how much, or "choose what to disable" is unanswerable.
   */
  it('reports the excess after a downgrade leaves the tenant over', async () => {
    /* Two sets already exist; shrinking the plan puts the tenant over. */
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 1) WHERE code = 'free'`,
    );

    try {
      const row = find(await usage(), 'option_sets');

      expect(row).toMatchObject({ current: 2, limit: 1, overLimit: true });
      expect(row.current - (row.limit ?? 0)).toBe(1);
      expect(row.label).toBe('option sets');
    } finally {
      await dataSource.query(
        `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 2) WHERE code = 'free'`,
      );
    }
  });

  /**
   * 🔴 **An unlimited metric can never be over.** The same inversion the guard
   * protects against: treating `null` as 0 would report the most permissive
   * plan as the most breached.
   */
  it('never reports an unlimited metric as over', async () => {
    await dataSource.query(
      `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = 'business') WHERE id = ?`,
      [tenantId],
    );

    try {
      const row = find(await usage(), 'option_sets');

      expect(row.limit).toBeNull();
      expect(row.overLimit).toBe(false);
      expect(row.atLimit).toBe(false);
    } finally {
      await dataSource.query(
        `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = 'free') WHERE id = ?`,
        [tenantId],
      );
    }
  });

  /**
   * 🔴 **An over-limit tenant is still refused new work.** M24.4's "block new
   * creation" and this report are two halves of one behaviour: the numbers
   * explain the refusal the guard is already producing.
   */
  it('still refuses a create while the tenant is over', async () => {
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 1) WHERE code = 'free'`,
    );

    try {
      const refused = await request(h.app.getHttpServer())
        .post('/v1/option-sets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Blocked', storeId });

      expect(refused.status).toBe(429);
    } finally {
      await dataSource.query(
        `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 2) WHERE code = 'free'`,
      );
    }
  });

  /**
   * ⚠️ **A metric the plan does not mention is OMITTED, not shown as
   * unlimited.** Listing it would put a row in the merchant's dashboard for
   * something their plan has no opinion about — and "0 of unlimited" invites
   * the question of what it is for.
   *
   * ✏️ **This test exists because a mutation survived.** Pushing a row for the
   * unmetered case changed nothing: no assertion looked at which metrics were
   * absent, only at the ones present.
   */
  it('omits a metric the plan does not mention', async () => {
    await dataSource.query(
      `UPDATE plans SET limits = JSON_REMOVE(limits, '$.products_assigned') WHERE code = 'free'`,
    );

    try {
      const rows = await usage();

      expect(rows.map((r) => r.metric)).not.toContain('products_assigned');

      /* And the metrics the plan DOES name are still all there. */
      expect(rows.map((r) => r.metric)).toContain('option_sets');
    } finally {
      await dataSource.query(
        `UPDATE plans SET limits = JSON_SET(limits, '$.products_assigned', 20) WHERE code = 'free'`,
      );
    }
  });

  /**
   * 🔴 **Usage is per tenant.** A report that leaked would tell one merchant to
   * delete work because another had been busy — and it is what a missing
   * `WHERE` produces.
   */
  it('never reports another tenant’s usage', async () => {
    const otherToken = await h.tenant('neighbour');
    const otherStore = await h.store('neighbour');
    const otherTenant = await h.tenantIdOf('neighbour');

    await dataSource.query(
      `INSERT INTO option_sets (id, tenantId, storeId, name, createdAt, updatedAt)
       VALUES (UUID(), ?, ?, 'Theirs', NOW(3), NOW(3))`,
      [otherTenant, otherStore],
    );

    const theirs = await request(h.app.getHttpServer())
      .get('/v1/billing/subscription')
      .set('Authorization', `Bearer ${otherToken}`);

    /* Mine holds two; theirs holds one. Neither figure may include the other. */
    expect(find(await usage(), 'option_sets').current).toBe(2);
    expect(find(theirs.body.data.usage as PlanUsage[], 'option_sets').current).toBe(1);
  });
});
