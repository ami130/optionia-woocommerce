import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SubscriptionStatus } from '../src/common/database/enums';
import { Plan } from '../src/plans/entities/plan.entity';
import { PlanPrice } from '../src/plans/entities/plan-price.entity';
import { Subscription } from '../src/subscriptions/entities/subscription.entity';
import { Tenant } from '../src/tenants/entities/tenant.entity';
import { TenantProvisioningService } from '../src/tenants/tenant-provisioning.service';
import { User } from '../src/users/entities/user.entity';
import { createHarness, type Harness } from './harness';

/**
 * A price change must never reach a merchant who already subscribed.
 *
 * 🔴 **The defect, stated as the code shipped it.** Plans are editable by
 * decision (M22.1a) and `subscriptions.planId` is `@ManyToOne(() => Plan)` — a
 * foreign key to a **mutable row**. So editing a plan's price re-prices every
 * existing subscriber on it, including merchants who signed up under different
 * terms. They discover it on a card statement, which is the worst way for a
 * billing error to surface: silent, retroactive, and found by the customer.
 *
 * ⚠️ **Against MySQL, not a mock**, for the reason `activation.e2e-spec.ts`
 * records: only the database can say whether a constraint actually holds. A
 * unit test asserting "we pin the price" proves we wrote the word `planPriceId`
 * somewhere; this proves an edit cannot move what a pinned subscription reads.
 */
describe('Plan price pinning (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;

  /* One short, unique token per run, so repeated runs never collide either. */
  const run = uuidv7().slice(-8);

  beforeAll(async () => {
    h = await createHarness('planprice');
    dataSource = h.app.get(DataSource);
  });

  /**
   * 🔴 **Clean up, because the test database is SHARED.** The first version of
   * this file left its plans behind, and `seeds.e2e-spec.ts` — which asserts
   * *"creates the three plans"* — then saw **26** and failed, along with
   * `option-sets-http`. A test that pollutes a shared database does not fail
   * itself; it fails something unrelated, hours later, and the person reading
   * that failure has no reason to suspect this file.
   *
   * ⚠️ **Prices before plans**: `RESTRICT` is the constraint under test, so the
   * delete order is the one the constraint dictates.
   */
  /**
   * 🔴 **Sweep every run's residue, not only this one's.**
   *
   * A run that *fails* never reaches its own teardown — a mutation test, an
   * interrupted run, a crash — so cleaning only `${run}` leaves rows behind
   * permanently. Measured: after two mutation runs, `plans` held **5** rows
   * where `seeds.e2e-spec.ts` asserts 3, which is how this file broke two
   * unrelated suites the first time (F84).
   *
   * ⚠️ **Matched on the prefixes this file owns**, never on a bare wildcard: a
   * sweep that took a broader swing at a shared database would be a worse
   * problem than the one it solves.
   */
  afterAll(async () => {
    const like = ['pin', 'sub', 'del', 'ret'].map((prefix) => `${prefix}-%`);

    await dataSource.query(
      `DELETE s FROM subscriptions s JOIN plans p ON p.id = s.planId
        WHERE ${like.map(() => 'p.code LIKE ?').join(' OR ')}`,
      like,
    );

    /*
     * ⚠️ **Subscriptions by TENANT as well as by plan, and both before the
     * tenants.** The first cleanup deleted them by joining on `plans`, which
     * misses any row whose plan is not one of this file's — and `subscriptions`
     * is `RESTRICT` on `tenantId`, so the tenant delete then failed and took the
     * whole suite down in teardown rather than in a test.
     */
    /* Every run's, not just this one's — see the note above. */
    const slugs = ['pin-%', 'prov-%'];

    for (const slug of slugs) {
      await dataSource.query(
        'DELETE FROM subscriptions WHERE tenantId IN (SELECT id FROM tenants WHERE slug LIKE ?)',
        [slug],
      );
      await dataSource.query(
        'DELETE FROM tenant_members WHERE tenantId IN (SELECT id FROM tenants WHERE slug LIKE ?)',
        [slug],
      );
      await dataSource.query('DELETE FROM tenants WHERE slug LIKE ?', [slug]);
    }

    await dataSource.query('DELETE FROM users WHERE email LIKE ?', ['prov-%@optionia.test']);

    await dataSource.query(
      `DELETE pp FROM plan_prices pp JOIN plans p ON p.id = pp.planId
        WHERE ${like.map(() => 'p.code LIKE ?').join(' OR ')}`,
      like,
    );

    await dataSource.query(
      `DELETE FROM plans WHERE ${like.map(() => 'code LIKE ?').join(' OR ')}`,
      like,
    );

    await h.close();
  });

  /**
   * A plan with one current price, as a signup would find it.
   *
   * ⚠️ **The code is a counter, not a uuid slice, and neither guess worked.**
   * `plans.code` is UNIQUE *and* `varchar(32)`: an 8-character `uuidv7` slice
   * collided, because uuidv7 is time-ordered and three rows written in the same
   * millisecond share their prefix; the full uuid then overran the column. A
   * per-run counter is unique **by construction** rather than by chance, and
   * short enough to fit.
   */
  let seq = 0;

  async function seedPlan(prefix: string, amountMinor: number) {
    seq += 1;

    const code = `${prefix}-${run}-${seq}`;

    const plan = await dataSource.getRepository(Plan).save(
      dataSource.getRepository(Plan).create({
        code,
        name: code,
        priceMonthlyMinor: amountMinor,
        priceYearlyMinor: amountMinor * 10,
        currency: 'USD',
        limits: {},
        features: {},
        isPublic: true,
        sortOrder: 99,
      }),
    );

    const price = await dataSource.getRepository(PlanPrice).save(
      dataSource.getRepository(PlanPrice).create({
        planId: plan.id,
        currency: 'USD',
        interval: 'month',
        amountMinor,
        isCurrent: true,
      }),
    );

    return { plan, price };
  }

  it('keeps a pinned price unchanged when the plan is edited', async () => {
    const { plan, price } = await seedPlan('pin', 2900);

    /* The merchant subscribes: the price they bought is recorded, not derived. */
    const pinned = price.id;

    /* Staff raise the plan's price, exactly as the dynamic admin will. */
    await dataSource.getRepository(Plan).update(plan.id, { priceMonthlyMinor: 4900 });

    const stillPinned = await dataSource
      .getRepository(PlanPrice)
      .findOne({ where: { id: pinned } });

    /*
     * 🔴 The whole point: the plan moved, the pinned price did not. Reading the
     * plan would have said 4900 — which is what an existing subscriber would
     * have been charged before this table existed.
     */
    expect(stillPinned?.amountMinor).toBe(2900);

    const edited = await dataSource.getRepository(Plan).findOne({ where: { id: plan.id } });

    expect(edited?.priceMonthlyMinor).toBe(4900);
  });

  /**
   * 🔴 **The test this file was NAMED for and did not contain.**
   *
   * The first version created plans and prices and never a **subscription** —
   * `grep -c Subscription` returned 0 — so it proved that `plan_prices` rows
   * behave and nothing at all about a pin. The name claimed more than the file
   * did, which is the shape of defect this project keeps finding: a guard
   * trusted past its range.
   *
   * ⚠️ **Read through the relation, not the column.** Asserting `planPriceId`
   * is unchanged proves only that a `char(36)` was not overwritten. Loading
   * `planPrice` and reading its `amountMinor` is what a billing run would do,
   * and is the only assertion that can fail if the pin stops meaning anything.
   */
  it('keeps a SUBSCRIPTION on the price it bought when the plan is edited', async () => {
    const { plan, price } = await seedPlan('sub', 2900);

    const tenant = await dataSource.getRepository(Tenant).save(
      dataSource.getRepository(Tenant).create({
        name: `Pin ${run}`,
        slug: `pin-${run}-${(seq += 1)}`,
        planId: plan.id,
        trialEndsAt: null,
      }),
    );

    const subscription = await dataSource.getRepository(Subscription).save(
      dataSource.getRepository(Subscription).create({
        tenantId: tenant.id,
        planId: plan.id,
        planPriceId: price.id,
        provider: 'none',
        status: SubscriptionStatus.ACTIVE,
      }),
    );

    /* Staff raise the plan, exactly as the dynamic admin will. */
    await dataSource.getRepository(Plan).update(plan.id, { priceMonthlyMinor: 4900 });

    /* And supersede the price, as a real price change does. */
    await dataSource
      .getRepository(PlanPrice)
      .update(price.id, { isCurrent: false, retiredAt: new Date() });

    await dataSource.getRepository(PlanPrice).save(
      dataSource.getRepository(PlanPrice).create({
        planId: plan.id,
        currency: 'USD',
        interval: 'month',
        amountMinor: 4900,
        isCurrent: true,
      }),
    );

    const reloaded = await dataSource.getRepository(Subscription).findOne({
      where: { id: subscription.id },
      relations: { planPrice: true },
    });

    /* 🔴 What this merchant is charged has not moved. */
    expect(reloaded?.planPrice?.amountMinor).toBe(2900);

    /* While a new signup would be offered the new figure. */
    const offered = await dataSource
      .getRepository(PlanPrice)
      .findOne({ where: { planId: plan.id, interval: 'month', isCurrent: true } });

    expect(offered?.amountMinor).toBe(4900);
  });

  /**
   * 🔴 **Provisioning created no subscription at all, and nothing noticed.**
   * `grep` for `create(Subscription` across the backend returned nothing, so
   * `subscriptions` was an empty table in every environment — which is why
   * `tenants.planId` could not be retired (F84/G6) and why the pin above had
   * never been exercised by the code that actually makes tenants.
   *
   * ⚠️ **Asserted against the real service**, not an HTTP round trip: this is
   * about what provisioning *writes*, and registration's own e2e already covers
   * the route.
   */
  it('gives a new tenant a subscription pinned to the free price', async () => {
    const provisioning = h.app.get(TenantProvisioningService);
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `prov-${run}-${(seq += 1)}@optionia.test`,
        passwordHash: 'x'.repeat(60),
        name: 'Provisioning probe',
      }),
    );

    const tenant = await dataSource.transaction((manager) =>
      provisioning.provision(manager, user.id, `Prov ${run}`),
    );

    const subscription = await dataSource.getRepository(Subscription).findOne({
      where: { tenantId: tenant.id },
      relations: { planPrice: true, plan: true },
    });

    expect(subscription).not.toBeNull();
    expect(subscription?.plan?.code).toBe('free');

    /* 🔴 Pinned, not merely planned: free is 0, and it is pinned to that row. */
    expect(subscription?.planPrice?.amountMinor).toBe(0);
    expect(subscription?.status).toBe(SubscriptionStatus.TRIALING);
  });

  it('refuses to delete a price a subscription could be pinned to', async () => {
    const { plan } = await seedPlan('del', 1900);

    /*
     * ⚠️ `RESTRICT`, so a plan with prices cannot be deleted out from under
     * them. An old invoice was priced by that row; losing it would make the
     * charge unexplainable.
     */
    await expect(dataSource.getRepository(Plan).delete(plan.id)).rejects.toThrow();
  });

  it('records a retired price rather than deleting it', async () => {
    const { plan, price } = await seedPlan('ret', 900);

    /* Superseding: the old row stops being offered and stays readable. */
    await dataSource
      .getRepository(PlanPrice)
      .update(price.id, { isCurrent: false, retiredAt: new Date() });

    await dataSource.getRepository(PlanPrice).save(
      dataSource.getRepository(PlanPrice).create({
        planId: plan.id,
        currency: 'USD',
        interval: 'month',
        amountMinor: 1200,
        isCurrent: true,
      }),
    );

    const all = await dataSource
      .getRepository(PlanPrice)
      .find({ where: { planId: plan.id }, order: { amountMinor: 'ASC' } });

    expect(all.map((p) => [p.amountMinor, p.isCurrent])).toEqual([
      [900, false],
      [1200, true],
    ]);

    /* Exactly one row a new signup can be offered. */
    expect(all.filter((p) => p.isCurrent)).toHaveLength(1);
  });
});
