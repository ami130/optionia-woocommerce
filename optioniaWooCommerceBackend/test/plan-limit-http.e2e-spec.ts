/* ⚠️ `* as`, not a default import — the same esModuleInterop gap as `stripe`. */
import * as request from 'supertest';
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

    /* The real Free allowance, pinned here rather than inherited. */
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 2) WHERE code = 'free'`,
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
