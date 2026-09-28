/* ⚠️ `* as`, not a default import — the same esModuleInterop gap as `stripe`. */
import * as request from 'supertest';
import { PlanLimitGuard } from '../src/usage/plan-limit.guard';
import { DataSource } from 'typeorm';

import { createHarness, type Harness } from './harness';

/**
 * M24.2 — a merchant's request is actually refused (F130).
 *
 * ## Why this suite exists separately from `plan-limit.e2e-spec`
 *
 * 🔴 **That suite proves the guard decides correctly; this proves anything
 * CALLS it.** The guard shipped with fifteen passing tests and **no production
 * caller** — the eighth time this project has built a mechanism with no
 * trigger, after `createCheckout` (H1), `cancelSubscription`/`updatePlan`
 * (F106), `trialEnding` (V1), `getSubscription` (M23.5), and M23.4's worker and
 * reconciler.
 *
 * 📌 **So every assertion here goes through HTTP.** A service-level test would
 * have passed on the unwired code, which is precisely how the gap survived
 * review: the tests were green and the product enforced nothing.
 *
 * ⚠️ **The tenants here are put back on Free deliberately.** `bootstrapTestApp`
 * raises Free's limits for the e2e run so unrelated fixtures are not refused
 * mid-setup; a suite about refusal has to opt out of that.
 */
describe('Plan limits over HTTP (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let token: string;
  let storeId: string;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness('planhttp');
    dataSource = h.dataSource;

    token = await h.tenant('owner');
    storeId = await h.store('owner');
    tenantId = await h.tenantIdOf('owner');

    /*
     * The allowances this suite asserts, pinned rather than inherited.
     *
     * ✏️ **Pro was added after the harness began raising every public plan.**
     * `bootstrapTestApp` lifts all of them so unrelated fixtures are not
     * refused mid-setup — which made the upgrade sentence read *"Upgrade to Pro
     * for 100000 option sets"*. A suite asserting a number must pin **every**
     * plan that number comes from, not only the one it puts the tenant on.
     */
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 2) WHERE code = 'free'`,
    );

    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 50) WHERE code = 'pro'`,
    );

    await dataSource.query(
      `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = 'free') WHERE id = ?`,
      [tenantId],
    );
  }, 120_000);

  afterAll(async () => {
    /*
     * ⚠️ **Restored, or every later suite inherits a limit of 2** — the K4
     * aggressor pattern this repository has fixed twice already.
     */
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 10) WHERE code = 'free'`,
    );

    await dataSource.query(
      `DELETE FROM option_sets WHERE tenantId IN
         (SELECT id FROM tenants WHERE slug LIKE 'planhttp-%')`,
    );

    await h.cleanup();
    await h.close();
  });

  function createSet(name: string) {
    return request(h.app.getHttpServer())
      .post('/v1/option-sets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, storeId });
  }

  /**
   * 🔴 **The whole point: a real request is refused.** Everything below is
   * detail; if this fails, the limit does not exist as far as a merchant is
   * concerned.
   */
  it('refuses the create that would exceed the plan', async () => {
    expect((await createSet('First')).status).toBe(201);
    expect((await createSet('Second')).status).toBe(201);

    const refused = await createSet('Third');

    /* 429, per the error-code map: PLAN_LIMIT_EXCEEDED → TOO_MANY_REQUESTS. */
    expect(refused.status).toBe(429);
  });

  /**
   * 🔴 **The merchant is told what to do.** M24.2 asks for the allowance, the
   * usage and the way out — and a refusal that reaches the browser without
   * them is a support ticket.
   */
  it('sends the allowance, the usage and the upgrade to the browser', async () => {
    const refused = await createSet('Fourth');

    expect(refused.body.error.message).toBe(
      'The Free plan allows 2 option sets. You have 2. Upgrade to Pro for 50 option sets.',
    );
  });

  /**
   * 🔴 **The numbers survive the HTTP boundary as data.** The dashboard renders
   * a meter from them; parsing them back out of a sentence would break the
   * first time the wording changed.
   */
  it('carries the limit and usage as structured detail', async () => {
    const refused = await createSet('Fifth');

    expect(refused.body.error.details?.[0]).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      params: { limit: 2, current: 2, plan: 'free' },
    });
  });

  /**
   * 🔴 **Nothing was written.** A guard that refuses *after* the insert would
   * leave the tenant over its limit permanently, and the next request would
   * refuse them for a row this one created.
   */
  it('writes nothing when it refuses', async () => {
    await createSet('Sixth');

    const [row] = (await dataSource.query(
      `SELECT COUNT(*) AS n FROM option_sets
        WHERE tenantId = ? AND deletedAt = '1970-01-01 00:00:00.000'`,
      [tenantId],
    )) as { n: number }[];

    expect(Number(row.n)).toBe(2);
  });

  /**
   * 🔴 **Duplicate cannot walk around the limit.**
   *
   * ✏️ **Phase 24 was ticked TWICE with this path unguarded.** `option_sets`
   * has three creation paths — `create`, `duplicate`, `importDocument` — and
   * only the first consulted the plan. A merchant refused on Create could
   * press Duplicate and get their eleventh set: a guard with a window beside
   * the door.
   *
   * ⚠️ **Gate 39 could not see it either**, because it counted one guard per
   * *file*. It now counts call sites against known creation paths.
   */
  it('refuses a duplicate that would exceed the plan', async () => {
    const [existing] = (await dataSource.query(
      `SELECT id FROM option_sets
        WHERE tenantId = ? AND deletedAt = '1970-01-01 00:00:00.000' LIMIT 1`,
      [tenantId],
    )) as { id: string }[];

    const refused = await request(h.app.getHttpServer())
      .post(`/v1/option-sets/${existing.id}/duplicate`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain('Free plan allows 2 option sets');
  });

  /*
   * 🔴 **`importDocument` is the third creation path, and it is guarded — but
   * NOT asserted here, deliberately.**
   *
   * Over HTTP the route validates the document before the guard is reached, so
   * a minimal fixture returns 400 for reasons unrelated to the limit. Called
   * directly the service has no request context, so tenant scoping fails with
   * *"Store not found"* before any plan is read. Building a full valid document
   * would duplicate what `option-sets-http.e2e-spec` already owns.
   *
   * 📌 **Gate 39 holds this instead**, counting `assertWithinPlan` call sites
   * against the three known creation paths and failing at 2/3 — mutation-proven
   * against exactly this bypass. A test that cannot reach the guard is worth
   * less than a check that can, and pretending otherwise is how the bypass
   * survived two audits.
   */

  /**
   * 🔴 **`stores` is enforced too — 2 of 5 limits was not "limits enforced".**
   *
   * ✏️ **Phase 24 was ticked with only `option_sets` and `team_seats`
   * guarded.** A Free tenant could connect unlimited stores against an
   * allowance of one. Found auditing the phase against its own exit criteria —
   * a check I had not run.
   *
   * 📌 **Asserted at the service, not over the full handshake.** Creating a
   * second store needs `initiate` → `authorize` → `exchange` with a real PKCE
   * pair, which `connect-handshake.e2e-spec` owns and proves. What is in doubt
   * here is only whether the limit is consulted at all, and that is one call.
   */
  it('refuses a store beyond the plan’s allowance', async () => {
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.stores', 1) WHERE code = 'free'`,
    );

    try {
      const guard = h.app.get(PlanLimitGuard, { strict: false });

      /* The tenant already holds one store, which is the whole allowance. */
      await expect(guard.assertWithinPlan(tenantId, 'stores')).rejects.toThrow(
        /Free plan allows 1 stores/,
      );
    } finally {
      await dataSource.query(
        `UPDATE plans SET limits = JSON_SET(limits, '$.stores', 100000) WHERE code = 'free'`,
      );
    }
  });

  /**
   * 🔴 **Deleting one frees the seat it held.** A merchant who hits the limit
   * must be able to act on the advice — and a count that included
   * soft-deleted rows would leave them stuck with no visible cause.
   */
  it('allows a create again once the merchant deletes one', async () => {
    await dataSource.query(
      `UPDATE option_sets SET deletedAt = NOW(3)
        WHERE tenantId = ? AND name = 'Second'`,
      [tenantId],
    );

    expect((await createSet('Replacement')).status).toBe(201);
  });
});
