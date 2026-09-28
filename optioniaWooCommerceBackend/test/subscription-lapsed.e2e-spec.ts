/* ⚠️ `* as`, not a default import — the same esModuleInterop gap as `stripe`. */
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { PlatformStaff } from '../src/admin/entities/platform-staff.entity';
import { generateStoreToken } from '../src/common/crypto/tokens';
import { createHarness, type Harness } from './harness';

/**
 * ADR-116 / M24.3 — authoring pauses when a subscription lapses.
 *
 * ## Why this suite exists
 *
 * 🔴 **`docs/SUBSCRIPTION-POLICY.md` is shown to merchants and promises that
 * after the fourteen-day grace period "editing pauses" — and NOTHING refused.**
 * `plan.read_only` was computed (M24.5), shipped to the storefront, and
 * rendered as a notice by the plugin (F137), while every write path still
 * accepted the edit the notice said was paused. The policy recorded the gap
 * honestly and it stayed the one promise in that document the software did not
 * keep.
 *
 * 📌 **Every assertion goes through HTTP.** A service-level test would pass
 * against a guard that was never registered — which is the shape of the nine
 * mechanism-with-no-caller defects this project has already produced, the most
 * recent of them one commit ago.
 */
describe('Lapsed subscriptions (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let token: string;
  let storeId: string;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness('lapsed');
    dataSource = h.dataSource;

    token = await h.tenant('owner');
    storeId = await h.store('owner');
    tenantId = await h.tenantIdOf('owner');
  }, 120_000);

  afterAll(async () => {
    await healthy();
    await dataSource.query(
      `DELETE FROM option_sets WHERE tenantId IN
         (SELECT id FROM tenants WHERE slug LIKE 'lapsed-%')`,
    );

    await h.cleanup();
    await h.close();
  });

  /** Put the tenant past its grace period. */
  async function lapsed(): Promise<void> {
    await dataSource.query(
      `UPDATE subscriptions SET graceEndsAt = DATE_SUB(NOW(3), INTERVAL 1 DAY)
        WHERE tenantId = ?`,
      [tenantId],
    );
  }

  /** Put the tenant inside its grace period — failing, but not yet paused. */
  async function inGrace(): Promise<void> {
    await dataSource.query(
      `UPDATE subscriptions SET graceEndsAt = DATE_ADD(NOW(3), INTERVAL 7 DAY)
        WHERE tenantId = ?`,
      [tenantId],
    );
  }

  /** Clear the lapse. */
  async function healthy(): Promise<void> {
    await dataSource.query(`UPDATE subscriptions SET graceEndsAt = NULL WHERE tenantId = ?`, [
      tenantId,
    ]);
  }

  const api = () => request(h.app.getHttpServer());

  function createSet(name: string) {
    return api()
      .post('/v1/option-sets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, storeId });
  }

  /**
   * 🔴 **The promise the policy makes, finally kept.** If this fails, a merchant
   * is shown a notice saying their editing is paused while the edit succeeds.
   */
  it('refuses a write once the grace period has expired', async () => {
    await lapsed();

    const refused = await createSet('While lapsed');

    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('SUBSCRIPTION_LAPSED');
  });

  /**
   * 🔴 **And the merchant is told what is true, and what to do.** *"Forbidden"*
   * sends them to a support ticket; naming the payment sends them to the card
   * form — and saying the storefront still works stops them hunting an outage
   * that is not happening.
   */
  it('tells the merchant the storefront is unaffected', async () => {
    await lapsed();

    const refused = await createSet('While lapsed 2');

    expect(refused.body.error.message).toMatch(/editing is paused/);
    expect(refused.body.error.message).toMatch(/storefront keeps serving/);
    expect(refused.body.error.message).toMatch(/nothing has been deleted/);
  });

  /**
   * 🔴 **Reads keep working.** ADR-116 says a lapsed merchant can *"sign in and
   * see all of their work"* — blocking reads would turn the dashboard into a
   * login screen and destroy the goodwill the policy exists to protect.
   */
  it('still lets a lapsed merchant read their own work', async () => {
    await lapsed();

    const listed = await api()
      .get('/v1/option-sets')
      .set('Authorization', `Bearer ${token}`);

    expect(listed.status).toBe(200);
  });

  /**
   * 🔴 **Grace STARTED is not grace EXPIRED.** Fourteen days of full function is
   * the policy; refusing on day one enforces a restriction the merchant does not
   * have and that nothing told them about.
   */
  it('allows writes while the grace period is still running', async () => {
    await inGrace();

    const created = await createSet('During grace');

    expect(created.status).toBe(201);
  });

  /** 📌 And a healthy subscription is untouched by any of this. */
  it('allows writes when there is no lapse at all', async () => {
    await healthy();

    const created = await createSet('While healthy');

    expect(created.status).toBe(201);
  });

  /**
   * 🔴 **Paying still works while lapsed, and this is the whole hinge.** A
   * read-only state that blocks the payment which would lift it is a trap: the
   * merchant cannot recover, so the state never ends and the pressure ADR-116
   * applies has nowhere to convert.
   *
   * 📌 **Asserted by what it is NOT.** A checkout needs a configured provider,
   * which this harness has none of — so the route answering anything other than
   * `SUBSCRIPTION_LAPSED` proves the guard stood aside, which is the only thing
   * in doubt here.
   */
  it('never blocks the billing routes that would end the lapse', async () => {
    await lapsed();

    const attempted = await api()
      .post('/v1/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planCode: 'pro', currency: 'USD', interval: 'month' });

    expect(attempted.body.error?.code).not.toBe('SUBSCRIPTION_LAPSED');
  });

  /**
   * 🔴 **The storefront keeps WRITING while the tenant is lapsed.**
   *
   * *"We do not switch off your shop because a card failed"* is the strongest
   * promise in the policy. Order reporting is a `POST` — a real mutation on a
   * `@StoreRoute()` — so it is the case that actually proves the guard stands
   * aside for the store realm rather than merely leaving reads alone.
   *
   * ✏️ **The first version of this test sent a deliberately invalid token and
   * asserted only that the answer was not the lapse code.** A 401 satisfies
   * that whatever the guard does, so it proved nothing. This mints a real
   * credential and expects the write to succeed.
   */
  it('never refuses the storefront a write while the tenant is lapsed', async () => {
    await lapsed();

    const credential = generateStoreToken();

    await dataSource.query(`UPDATE stores SET status = 'connected' WHERE id = ?`, [storeId]);
    await dataSource.query(
      `INSERT INTO store_credentials
         (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
       VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
      [storeId, credential.hash, credential.prefix],
    );

    const reported = await api()
      .post('/v1/store/orders')
      .set('Authorization', `Bearer ${credential.plaintext}`)
      .send({
        external_order_id: `lapsed-${Date.now()}`,
        order_total_minor: 5_000,
        currency: 'USD',
        option_revenue_minor: 0,
        occurred_at: new Date().toISOString(),
        selections: [],
      });

    /* A customer's order reaches us even though the merchant has not paid. */
    expect(reported.status).toBe(200);
    expect(reported.body.error?.code).not.toBe('SUBSCRIPTION_LAPSED');

    await dataSource.query(
      `DELETE FROM order_events WHERE storeId = ? AND externalOrderId LIKE 'lapsed-%'`,
      [storeId],
    );
  });

  /**
   * ⚠️ **Signing in is not authoring.** `@Public()` routes have no tenant to
   * judge, and a lapsed merchant who cannot log in cannot reach the card form
   * either — the same trap the billing exemption avoids, one step earlier.
   */
  it('never blocks an unauthenticated route', async () => {
    await lapsed();

    const attempted = await api()
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' });

    expect(attempted.body.error?.code).not.toBe('SUBSCRIPTION_LAPSED');
  });

  /**
   * 🔴 **Platform staff are not refused by their OWN lapsed subscription**
   * (F162).
   *
   * ⚠️ **Staff identity is a `platform_staff` row; the credential is an
   * ordinary tenant JWT.** `JwtAuthGuard` sets `ctx.tenantId` from it, so a
   * support engineer who is also a tenant member carries a tenant id — and
   * without the staff check their personal lapse would lock them out of
   * platform pricing, which has nothing to do with their own bill.
   *
   * 📌 **Not reachable while `platform_staff` is empty**, and Phase 26 is the
   * phase that fills it. Pinned now rather than discovered then.
   */
  it('never refuses platform staff over their own lapsed subscription', async () => {
    await lapsed();

    const [user] = (await dataSource.query(`SELECT id FROM users WHERE email = ?`, [
      'lapsed-owner@example.com',
    ])) as { id: string }[];

    const staff = dataSource.getRepository(PlatformStaff);
    const existing = await staff.findOne({ where: { userId: user.id } });

    await staff.save(
      existing
        ? Object.assign(existing, { role: 'super_admin', revokedAt: null })
        : staff.create({ userId: user.id, role: 'super_admin', grantedAt: new Date() }),
    );

    try {
      /*
       * A platform write, on a tenant whose own subscription has lapsed. What
       * matters is that it is not the LAPSE refusal — the route may still
       * answer 400 for a body this test does not build.
       */
      const response = await api()
        .patch('/v1/admin/plans/free/visibility')
        .set('Authorization', `Bearer ${token}`)
        .send({ isPublic: true });

      /*
       * ✏️ **The path is load-bearing, and my first attempt had it wrong.** I
       * posted to `/prices`, which does not exist — the route is `/price` — so
       * the request 404'd before any guard ran and the test passed with the
       * staff exemption deliberately removed. A test that cannot reach the code
       * it is about proves nothing.
       */
      expect(response.status).not.toBe(404);
      expect(response.body.error?.code).not.toBe('SUBSCRIPTION_LAPSED');
    } finally {
      await dataSource.query(`DELETE FROM platform_staff WHERE userId = ?`, [user.id]);
    }
  });

  /**
   * 🔴 **Settling the payment restores authoring immediately.** A merchant who
   * pays and still cannot work will open the support ticket the whole policy is
   * designed to avoid.
   */
  it('restores authoring the moment the lapse clears', async () => {
    await lapsed();
    expect((await createSet('Blocked')).status).toBe(403);

    await healthy();
    expect((await createSet('Unblocked')).status).toBe(201);
  });
});
