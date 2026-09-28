import { DataSource } from 'typeorm';

import { PlanLimitGuard } from '../src/usage/plan-limit.guard';
import { createHarness, type Harness } from './harness';

/**
 * M24.2 — refusing a write that would exceed the plan, against MySQL.
 *
 * 🔴 **Phase 15 shipped a meter and called it enforcement.** Its exit criterion
 * read *"per-plan quotas **enforced** and metered"* and was ticked while only
 * the meter existed — so a tenant on a 1 GB plan could store 100 GB and no
 * request was refused. This is the guard that criterion described.
 *
 * 📌 **Every assertion here runs against the real seeded plans**, because the
 * numbers in the message are the product: *"The Free plan allows 10 option
 * sets. You have 10. Upgrade to Pro for 50."* A mocked plan would prove my
 * fixture agrees with my fixture.
 */
describe('Plan limit enforcement (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let guard: PlanLimitGuard;

  beforeAll(async () => {
    h = await createHarness('planlimit');
    dataSource = h.dataSource;
    guard = h.app.get(PlanLimitGuard, { strict: false });
  }, 120_000);

  afterAll(async () => {
    await dataSource.query(
      `DELETE FROM option_sets WHERE tenantId IN
         (SELECT id FROM tenants WHERE slug LIKE 'planlimit-%')`,
    );

    await h.cleanup();
    await h.close();
  });

  it('resolves from the application container', () => {
    expect(guard).toBeInstanceOf(PlanLimitGuard);
  });

  /**
   * 🔴 **Under the limit is allowed.** The first thing a guard must not do is
   * refuse a merchant who is entitled — a false refusal is worse than a missing
   * limit, because it blocks work already paid for.
   */
  it('allows a tenant that is under its limit', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'under'));

    await expect(guard.assertWithinPlan(tenantId, 'option_sets')).resolves.toBeUndefined();
  });

  /**
   * 🔴 **At the limit is refused**, not over it. A tenant holding 10 of 10 is
   * asking to create the eleventh, so `current >= limit` is the boundary —
   * `>` would allow one more than the plan sells.
   */
  it('refuses a tenant that has reached its limit', async () => {
    const which = await named(h, 'at-limit');
    const tenantId = await h.tenantIdOf(which);
    const storeId = await h.store(which);

    /* Free allows 10 option sets. */
    for (let i = 0; i < 10; i += 1) {
      await makeSet(dataSource, tenantId, storeId, `Set ${i}`);
    }

    await expect(guard.assertWithinPlan(tenantId, 'option_sets')).rejects.toThrow(
      /Free plan allows 10 option sets/,
    );
  });

  /**
   * 🔴 **The message is the deliverable.** M24.2 asks for the allowance, the
   * current usage and the way out — a merchant told only "limit reached" has to
   * open a ticket to find out what to do.
   */
  it('names the allowance, the usage and the upgrade', async () => {
    const which = await named(h, 'message');
    const tenantId = await h.tenantIdOf(which);
    const storeId = await h.store(which);

    for (let i = 0; i < 10; i += 1) {
      await makeSet(dataSource, tenantId, storeId, `Set ${i}`);
    }

    const error = await guard.assertWithinPlan(tenantId, 'option_sets').catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      /*
       * 📌 **'for 50 option sets', not 'for 50'.** M24.2's example sentence ends
       * '…Upgrade to Pro for 50.', which reads as a price on its own. Naming the
       * unit costs four words and removes the ambiguity.
       */
      'The Free plan allows 10 option sets. You have 10. Upgrade to Pro for 50 option sets.',
    );
  });

  /**
   * 🔴 **`null` means unlimited and must never read as zero.** Business has
   * `option_sets: null`; treating it as 0 would refuse every write on the most
   * permissive plan — the inversion a merchant notices first and trusts least.
   */
  it('never refuses a plan whose limit is null', async () => {
    const which = await named(h, 'unlimited');
    const tenantId = await h.tenantIdOf(which);
    const storeId = await h.store(which);

    await moveToPlan(dataSource, tenantId, 'business');

    for (let i = 0; i < 12; i += 1) {
      await makeSet(dataSource, tenantId, storeId, `Set ${i}`);
    }

    await expect(guard.assertWithinPlan(tenantId, 'option_sets')).resolves.toBeUndefined();
  });

  /**
   * ⚠️ **A metric absent from `limits` is unmetered, not zero.** No plan lists
   * every possible metric, and a guard that refuses what it was never told
   * about would block features as they are added.
   */
  it('allows a metric the plan does not mention', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'unmetered'));

    await dataSource.query(
      `UPDATE plans SET limits = JSON_REMOVE(limits, '$.option_sets') WHERE code = 'free'`,
    );

    try {
      await expect(guard.assertWithinPlan(tenantId, 'option_sets')).resolves.toBeUndefined();
    } finally {
      await dataSource.query(
        `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 10) WHERE code = 'free'`,
      );
    }
  });

  /**
   * 📌 **The top plan is told what it has, not to upgrade.** Sending a merchant
   * on the highest tier shopping for a product that does not exist is worse
   * than saying nothing.
   */
  it('does not offer an upgrade to a tenant on the top plan', async () => {
    const which = await named(h, 'top');
    const tenantId = await h.tenantIdOf(which);

    await moveToPlan(dataSource, tenantId, 'business');

    /* Business allows 10 stores; forcing the count is cheaper than ten stores. */
    await dataSource.query(`UPDATE plans SET limits = JSON_SET(limits, '$.stores', 0)
                             WHERE code = 'business'`);

    try {
      const error = await guard.assertWithinPlan(tenantId, 'stores').catch((e: Error) => e);

      expect((error as Error).message).toBe('The Business plan allows 0 stores. You have 0.');
      expect((error as Error).message).not.toContain('Upgrade');
    } finally {
      await dataSource.query(`UPDATE plans SET limits = JSON_SET(limits, '$.stores', 10)
                               WHERE code = 'business'`);
    }
  });

  /**
   * 🔴 **An upgrade is offered only when it actually RAISES the limit.**
   * Naming the next tier regardless would send a merchant to pay for no more
   * of the thing they ran out of — the most expensive kind of wrong message,
   * because they discover it after paying.
   *
   * ✏️ **This test exists because a mutation survived.** Deleting the
   * `raised <= limit` guard changed nothing: every seeded plan happens to raise
   * every limit, so the branch was asserted by no one.
   */
  it('does not offer an upgrade that leaves the limit unchanged', async () => {
    const which = await named(h, 'same-limit');
    const tenantId = await h.tenantIdOf(which);
    const storeId = await h.store(which);

    /* Make Pro no better than Free for option sets. */
    await dataSource.query(
      `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 10) WHERE code = 'pro'`,
    );

    try {
      for (let i = 0; i < 10; i += 1) {
        await makeSet(dataSource, tenantId, storeId, `Set ${i}`);
      }

      const error = await guard.assertWithinPlan(tenantId, 'option_sets').catch((e: Error) => e);

      expect((error as Error).message).toBe('The Free plan allows 10 option sets. You have 10.');
      expect((error as Error).message).not.toContain('Upgrade');
    } finally {
      await dataSource.query(
        `UPDATE plans SET limits = JSON_SET(limits, '$.option_sets', 50) WHERE code = 'pro'`,
      );
    }
  });

  /**
   * 🔴 **The error carries the numbers as data, not only as prose.** The
   * dashboard needs the limit and the usage to render a meter; parsing them
   * back out of a sentence would break the first time the wording changed.
   */
  it('carries the limit and usage as structured detail', async () => {
    const which = await named(h, 'detail');
    const tenantId = await h.tenantIdOf(which);
    const storeId = await h.store(which);

    for (let i = 0; i < 10; i += 1) {
      await makeSet(dataSource, tenantId, storeId, `Set ${i}`);
    }

    const error = (await guard
      .assertWithinPlan(tenantId, 'option_sets')
      .catch((e: unknown) => e)) as { details?: { code: string; params: Record<string, unknown> }[] };

    expect(error.details?.[0]).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      params: { limit: 10, current: 10, plan: 'free' },
    });
  });
});

async function named(h: Harness, which: string): Promise<string> {
  await h.tenant(which);

  return which;
}

async function moveToPlan(dataSource: DataSource, tenantId: string, code: string): Promise<void> {
  await dataSource.query(
    `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = ?) WHERE id = ?`,
    [code, tenantId],
  );
}

async function makeSet(
  dataSource: DataSource,
  tenantId: string,
  storeId: string,
  name: string,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO option_sets (id, tenantId, storeId, name, createdAt, updatedAt)
     VALUES (UUID(), ?, ?, ?, NOW(3), NOW(3))`,
    [tenantId, storeId, name],
  );
}
