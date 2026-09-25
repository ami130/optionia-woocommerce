/* ⚠️ `* as`, not a default import — the same esModuleInterop gap as `stripe`. */
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { PlatformStaff } from '../src/admin/entities/platform-staff.entity';
import { AuditLog } from '../src/audit/entities/audit-log.entity';
import { StaffRole } from '../src/common/database/enums';
import { PlanPrice } from '../src/plans/entities/plan-price.entity';
import { Plan } from '../src/plans/entities/plan.entity';
import { Subscription } from '../src/subscriptions/entities/subscription.entity';
import { client, createHarness, type Harness } from './harness';

/**
 * Plan administration by platform staff (M22.1a), against MySQL.
 *
 * 🔴 **The exit criterion is a database property, not a code one**: *"platform
 * staff change a price; an existing subscriber's next invoice is unchanged; a
 * new signup is charged the new figure."* That is provable only by writing a
 * price, re-reading the subscription that was pinned before it, and seeing it
 * still point at the old row. No unit test can say that.
 */
describe('Plan administration (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;

  beforeAll(async () => {
    h = await createHarness('planadm');
    dataSource = h.app.get(DataSource);
  }, 120_000);

  afterAll(async () => {
    /*
     * 🔴 **Identified by amount, never by position.** A first attempt kept "the
     * two oldest rows" and restored them — which was wrong twice over: a
     * mutation run had already overwritten the seeded amount, so the row it
     * preserved was not the seeded one, and setting `isCurrent = 1` on *every*
     * pro row left several current prices for one interval at once. The test
     * database ended with nineteen rows and the suite failed 12/14 on the next
     * run, from its own teardown.
     *
     * ⚠️ **Rows a subscription points at cannot be deleted** — `planPriceId` is
     * `ON DELETE RESTRICT`, correctly, because deleting what a merchant bought
     * is how a billing history loses its meaning. Those rows are left retired,
     * which is exactly what they should be.
     */
    const SEEDED: ReadonlyArray<{ interval: string; amountMinor: number }> = [
      { interval: 'month', amountMinor: 2900 },
      { interval: 'year', amountMinor: 29_000 },
    ];

    /* Drop every price this suite created that nothing depends on. */
    await dataSource.query(
      `DELETE pp FROM plan_prices pp
         JOIN plans p ON p.id = pp.planId
         LEFT JOIN subscriptions s ON s.planPriceId = pp.id
        WHERE p.code = 'pro' AND s.id IS NULL
          AND NOT (pp.currency = 'USD'
                   AND ((pp.interval = 'month' AND pp.amountMinor = 2900)
                     OR (pp.interval = 'year' AND pp.amountMinor = 29000)))`,
    );

    /* Make exactly one row per interval current again, at the seeded amount. */
    await dataSource.query(
      `UPDATE plan_prices pp JOIN plans p ON p.id = pp.planId
          SET pp.isCurrent = 0, pp.retiredAt = COALESCE(pp.retiredAt, NOW(3))
        WHERE p.code = 'pro'`,
    );

    /*
     * 🔴 **MySQL refuses `ORDER BY`/`LIMIT` on a multi-table UPDATE** — error
     * 1221, "Incorrect usage of UPDATE and ORDER BY. A first version wrote
     * exactly that, so the re-activation threw, every pro price stayed retired,
     * and the next run failed with *"could not find any PlanPrice matching
     * isCurrent: true"*. The teardown had broken the suite twice by then.
     *
     * 📌 Selecting the id first sidesteps it, and says plainly that exactly one
     * row per interval is meant to become current.
     */
    for (const { interval, amountMinor } of SEEDED) {
      const [row] = await dataSource.query(
        `SELECT pp.id FROM plan_prices pp JOIN plans p ON p.id = pp.planId
          WHERE p.code = 'pro' AND pp.interval = ? AND pp.amountMinor = ?
          ORDER BY pp.createdAt ASC LIMIT 1`,
        [interval, amountMinor],
      );

      if (row !== undefined) {
        await dataSource.query(
          `UPDATE plan_prices SET isCurrent = 1, retiredAt = NULL WHERE id = ?`,
          [row.id],
        );
      }
    }
    await dataSource.query(
      `DELETE FROM audit_logs WHERE action LIKE 'plan%' AND userId IS NOT NULL`,
    );
    await dataSource.query(
      `DELETE FROM platform_staff WHERE userId IN
         (SELECT id FROM users WHERE email LIKE 'planadm-%@example.com')`,
    );

    await h.close();
  });

  /** Promote a harness user to platform staff. */
  async function makeStaff(which: string, role: StaffRole): Promise<string> {
    const token = await h.tenant(which);
    const [row] = await dataSource.query(`SELECT id FROM users WHERE email = ?`, [
      `planadm-${which}@example.com`,
    ]);

    /*
     * ⚠️ **Upsert, because `uq_platform_staff_user` is unique per user and a
     * failing run never reaches teardown.** A plain insert made every later run
     * fail on a duplicate left behind by the previous one — the suite breaking
     * itself, which is the same class of fault its own teardown comment records.
     */
    const repo = dataSource.getRepository(PlatformStaff);
    const existing = await repo.findOne({ where: { userId: row.id } });

    await repo.save(
      existing
        ? Object.assign(existing, { role, revokedAt: null })
        : repo.create({ userId: row.id, role, grantedAt: new Date() }),
    );

    return token;
  }

  describe('who may touch pricing', () => {
    /**
     * 🔴 **The vulnerability this milestone names.** *"A tenant admin editing
     * what they pay is not a feature, it is a vulnerability."* A tenant owner —
     * the highest role a merchant has — must be refused.
     */
    it('refuses a tenant owner who is not platform staff', async () => {
      const token = await h.tenant('outsider');

      const response = await client(h.app, token).get('/admin/plans');

      expect(response.status).toBe(403);
    }, 60_000);

    it('refuses an unauthenticated request', async () => {
      const response = await request(h.app.getHttpServer()).get('/v1/admin/plans');

      expect(response.status).toBe(401);
    }, 60_000);

    /** ⚠️ Support may help a merchant; it may not change what anyone is charged. */
    it('refuses a SUPPORT staff member the price route', async () => {
      const token = await makeStaff('support', StaffRole.SUPPORT);

      const response = await client(h.app, token).post('/admin/plans/pro/price', {
        currency: 'USD',
        interval: 'month',
        amountMinor: 9900,
      });

      expect(response.status).toBe(403);
    }, 60_000);

    it('lets READ_ONLY staff list but not change', async () => {
      const token = await makeStaff('readonly', StaffRole.READ_ONLY);
      const api = client(h.app, token);

      expect((await api.get('/admin/plans')).status).toBe(200);
      expect(
        (
          await api.post('/admin/plans/pro/price', {
            currency: 'USD',
            interval: 'month',
            amountMinor: 9900,
          })
        ).status,
      ).toBe(403);
    }, 60_000);
  });

  describe('changing a price', () => {
    /**
     * 🔴 **THE exit criterion.** A price change must leave every existing
     * subscriber pinned to what they bought. If this fails, every merchant on
     * the plan was silently re-priced — *"the single most expensive thing to get
     * wrong here"*.
     */
    it('supersedes without re-pricing an existing subscriber', async () => {
      const staffToken = await makeStaff('billing-ops', StaffRole.BILLING_OPS);

      /* A merchant who "bought" the current pro monthly price. */
      await h.tenant('subscriber');
      const tenantId = await h.tenantIdOf('subscriber');

      const plan = await dataSource.getRepository(Plan).findOneByOrFail({ code: 'pro' });
      const before = await dataSource.getRepository(PlanPrice).findOneByOrFail({
        planId: plan.id,
        interval: 'month',
        isCurrent: true,
      });

      const subscriptions = dataSource.getRepository(Subscription);
      const subscription = await subscriptions.findOneByOrFail({ tenantId });
      subscription.planId = plan.id;
      subscription.planPriceId = before.id;
      await subscriptions.save(subscription);

      const response = await client(h.app, staffToken).post('/admin/plans/pro/price', {
        currency: 'USD',
        interval: 'month',
        amountMinor: 3900,
      });

      expect(response.status).toBe(201);
      expect(response.body.data.superseded).toBe(before.id);

      /* 🔴 The subscriber still points at the price they bought. */
      const after = await subscriptions.findOneByOrFail({ id: subscription.id });
      expect(after.planPriceId).toBe(before.id);

      const oldPrice = await dataSource
        .getRepository(PlanPrice)
        .findOneByOrFail({ id: before.id });
      expect(oldPrice.amountMinor).toBe(2900);
      expect(oldPrice.isCurrent).toBe(false);
      expect(oldPrice.retiredAt).not.toBeNull();

      /* And a new signup would take the new figure. */
      const current = await dataSource.getRepository(PlanPrice).findOneByOrFail({
        planId: plan.id,
        interval: 'month',
        isCurrent: true,
      });
      expect(current.amountMinor).toBe(3900);
      expect(current.id).not.toBe(before.id);
    }, 60_000);

    /**
     * ⚠️ **The new price must not inherit the old provider id.** Copying it
     * would sell the OLD amount while the dashboard showed the new one — the
     * silent mismatch F105's verifier exists to catch.
     */
    it('leaves the new price unlinked to the provider', async () => {
      const token = await makeStaff('unlinked', StaffRole.BILLING_OPS);

      const response = await client(h.app, token).post('/admin/plans/pro/price', {
        currency: 'USD',
        interval: 'year',
        amountMinor: 31_000,
      });

      expect(response.status).toBe(201);

      const created = await dataSource
        .getRepository(PlanPrice)
        .findOneByOrFail({ id: response.body.data.priceId });

      expect(created.providerPriceId).toBeNull();
    }, 60_000);

    /**
     * 🔴 **M22.1a's exit criterion: attributable to a named staff user.** An
     * audit row with a null actor is indistinguishable from a seeding run, and
     * the first time a merchant disputes a charge that difference is the answer.
     */
    it('attributes the change to the staff user who made it', async () => {
      const token = await makeStaff('attributed', StaffRole.BILLING_OPS);
      const [staff] = await dataSource.query(`SELECT id FROM users WHERE email = ?`, [
        'planadm-attributed@example.com',
      ]);

      await client(h.app, token).post('/admin/plans/pro/price', {
        currency: 'USD',
        interval: 'month',
        amountMinor: 4900,
      });

      const logs = await dataSource.getRepository(AuditLog).find({
        where: { action: 'plan_price.superseded' },
        order: { createdAt: 'DESC' },
        take: 1,
      });

      expect(logs[0]?.userId).toBe(staff.id);
      expect(logs[0]?.changes).toMatchObject({
        plan: 'pro',
        amountMinor: { to: 4900 },
        source: 'staff',
      });
    }, 60_000);

    /**
     * 🔴 **`plan_price.created`, not `superseded`.** A currency a plan has never
     * had has nothing to retire, and the audit row must say so — a reader
     * looking for "what was this before" needs to know the answer is "nothing"
     * rather than find a `from` that was invented.
     *
     * 📌 This is also M22.1a's *"currency as data"*, in the only sense the API
     * supports today: staff can introduce a currency by pricing it.
     */
    it('records a first price for a new currency as created, not superseded', async () => {
      const token = await makeStaff('new-currency', StaffRole.BILLING_OPS);

      const response = await client(h.app, token).post('/admin/plans/pro/price', {
        currency: 'EUR',
        interval: 'month',
        amountMinor: 2700,
      });

      expect(response.status).toBe(201);
      expect(response.body.data.superseded).toBeNull();

      const [log] = await dataSource.getRepository(AuditLog).find({
        where: { action: 'plan_price.created' },
        order: { createdAt: 'DESC' },
        take: 1,
      });

      expect(log?.userId).not.toBeNull();
      expect(log?.changes).toMatchObject({
        plan: 'pro',
        currency: 'EUR',
        amountMinor: { to: 2700 },
        superseded: null,
      });
    }, 60_000);

    it('refuses a price identical to the current one', async () => {
      const token = await makeStaff('noop', StaffRole.BILLING_OPS);

      const plan = await dataSource.getRepository(Plan).findOneByOrFail({ code: 'business' });
      const current = await dataSource.getRepository(PlanPrice).findOneByOrFail({
        planId: plan.id,
        interval: 'month',
        isCurrent: true,
      });

      const response = await client(h.app, token).post('/admin/plans/business/price', {
        currency: 'USD',
        interval: 'month',
        amountMinor: current.amountMinor,
      });

      expect(response.status).toBe(400);
    }, 60_000);

    it.each([
      ['a negative amount', { currency: 'USD', interval: 'month', amountMinor: -100 }],
      ['a fractional amount', { currency: 'USD', interval: 'month', amountMinor: 29.5 }],
      ['an unknown interval', { currency: 'USD', interval: 'weekly', amountMinor: 100 }],
      ['a malformed currency', { currency: 'DOLLARS', interval: 'month', amountMinor: 100 }],
    ])('refuses %s', async (_label, body) => {
      const token = await makeStaff(`invalid-${_label.replace(/\s/g, '')}`, StaffRole.BILLING_OPS);

      const response = await client(h.app, token).post('/admin/plans/pro/price', body);

      expect(response.status).toBe(400);
    }, 60_000);

    it('refuses an unknown plan', async () => {
      const token = await makeStaff('unknown-plan', StaffRole.BILLING_OPS);

      const response = await client(h.app, token).post('/admin/plans/enterprise/price', {
        currency: 'USD',
        interval: 'month',
        amountMinor: 9900,
      });

      expect(response.status).toBe(404);
    }, 60_000);
  });

  describe('hiding a plan', () => {
    /**
     * 🔴 **Hiding is NOT cancelling.** M22.1a is explicit, and a merchant whose
     * plan vanished from under them is a support incident, not a product
     * decision.
     */
    it('hides a plan from signup without touching anyone on it', async () => {
      const staffToken = await makeStaff('hider', StaffRole.BILLING_OPS);

      await h.tenant('on-hidden-plan');
      const tenantId = await h.tenantIdOf('on-hidden-plan');

      const plan = await dataSource.getRepository(Plan).findOneByOrFail({ code: 'business' });
      const subscriptions = dataSource.getRepository(Subscription);
      const subscription = await subscriptions.findOneByOrFail({ tenantId });
      subscription.planId = plan.id;
      await subscriptions.save(subscription);

      const response = await client(h.app, staffToken).patch(
        '/admin/plans/business/visibility',
        { isPublic: false },
      );

      expect(response.status).toBe(200);
      expect(response.body.data.isPublic).toBe(false);

      const after = await subscriptions.findOneByOrFail({ id: subscription.id });
      expect(after.planId).toBe(plan.id);
      expect(after.status).toBe(subscription.status);

      /* 📌 And the change is attributable, like every other staff action. */
      const [log] = await dataSource.getRepository(AuditLog).find({
        where: { action: 'plan.visibility_changed' },
        order: { createdAt: 'DESC' },
        take: 1,
      });

      expect(log?.userId).not.toBeNull();
      expect(log?.changes).toMatchObject({
        code: 'business',
        isPublic: { from: true, to: false },
      });

      /* Put it back, so the suite leaves the seed as it found it. */
      await client(h.app, staffToken).patch('/admin/plans/business/visibility', {
        isPublic: true,
      });
    }, 60_000);
  });
});
