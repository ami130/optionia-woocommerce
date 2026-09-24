import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { Plan } from '../src/plans/entities/plan.entity';
import { PlanPrice } from '../src/plans/entities/plan-price.entity';
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
  afterAll(async () => {
    const like = ['pin', 'del', 'ret'].map((prefix) => `${prefix}-${run}%`);

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
