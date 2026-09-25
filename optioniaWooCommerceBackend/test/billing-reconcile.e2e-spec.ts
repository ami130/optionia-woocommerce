import { DataSource } from 'typeorm';

import { SubscriptionStatus } from '../src/common/database/enums';
import { type BillingProvider } from '../src/billing/billing-provider';
import { SubscriptionReconcilerService } from '../src/billing/subscription-reconciler.service';
import { PlanPrice } from '../src/plans/entities/plan-price.entity';
import { Subscription } from '../src/subscriptions/entities/subscription.entity';
import { createHarness, type Harness } from './harness';

/**
 * M23.5's diff, against MySQL and the real container (F119's lesson applied).
 *
 * ## Why a unit test is not enough here
 *
 * 🔴 **Three of this service's claims are properties of things it does not
 * own.** That `Not('none')` and `Not(IsNull())` actually exclude free tenants
 * is a property of TypeORM's query builder and the database — a mocked
 * repository returns whatever the mock was told to. That `dryRun` writes
 * nothing is a property of the *column after the call*, not of a `save` spy.
 * And that the service can be constructed at all is a property of Nest's
 * injector, which a `new` in a unit test bypasses entirely.
 *
 * 📌 **F119's finding, applied forward**: `getSubscription` was built, tested
 * and called by nothing for a whole phase. A suite that resolves this service
 * from the running container is what makes "it is wired" a fact rather than an
 * intention.
 */
describe('Subscription reconciliation (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;

  beforeAll(async () => {
    h = await createHarness('recon');
    dataSource = h.dataSource;
  }, 120_000);

  afterAll(async () => {
    await h.cleanup();
    await h.close();
  });

  /**
   * 🔴 **The container must be able to build it.** A provider registered in the
   * module but unconstructible — a missing `forFeature`, an unresolvable token —
   * fails only when something first asks for it, which in production is the
   * scheduled run nobody is watching.
   */
  it('resolves from the application container', () => {
    const service = h.app.get(SubscriptionReconcilerService, { strict: false });

    expect(service).toBeInstanceOf(SubscriptionReconcilerService);
  });

  /**
   * 🔴 **The free-tenant filter, proven against the database.** Every tenant the
   * harness creates is free: `provider: 'none'`, no remote id. If the `WHERE`
   * did not exclude them, this would report the whole table as drift on every
   * run — and the unit test for it asserts the operator, not the outcome.
   */
  it('never asks the provider about a free tenant', async () => {
    const freeTenant = await h.tenantIdOf(await tenantNamed(h, 'free-a'));

    const asked: string[] = [];

    const service = new SubscriptionReconcilerService(
      dataSource.getRepository(Subscription),
      dataSource.getRepository(PlanPrice),
      {
        getSubscription: async (id: string) => {
          asked.push(id);

          return null;
        },
      } as unknown as BillingProvider,
    );

    await service.reconcile();

    /*
     * 🔴 **Asserted by what was ASKED, not by a count.** The reconciler scans
     * the whole table by design — it is a global job — so other suites' rows
     * are legitimately in scope and a `checked` count is not this suite's to
     * predict. What must hold is that this free tenant was never looked up.
     */
    const row = await dataSource
      .getRepository(Subscription)
      .findOneByOrFail({ tenantId: freeTenant });

    expect(row.provider).toBe('none');
    expect(row.providerSubscriptionId).toBeNull();
    expect(asked).not.toContain(row.id);
  });

  /**
   * 🔴 **`dryRun` proven by the COLUMN, not by a spy.** The safety argument is
   * that a reported difference changes nothing; a `save` that was never called
   * is weaker evidence than a row that did not move.
   */
  it('reports drift and leaves the row untouched', async () => {
    const tenantId = await h.tenantIdOf(await tenantNamed(h, 'drift'));

    const subscriptions = dataSource.getRepository(Subscription);
    const row = await subscriptions.findOneByOrFail({ tenantId });

    row.provider = 'stripe';
    row.providerSubscriptionId = `sub_recon_${tenantId.slice(-8)}`;
    row.providerCustomerId = 'cus_recon';
    row.status = SubscriptionStatus.ACTIVE;
    row.currentPeriodEnd = new Date('2026-12-01T00:00:00.000Z');
    await subscriptions.save(row);

    /* The provider disagrees on both fields. */
    const service = buildWith(h, {
      status: SubscriptionStatus.PAST_DUE,
      currentPeriodEnd: new Date('2027-03-01T00:00:00.000Z'),
      providerSubscriptionId: row.providerSubscriptionId,
      providerCustomerId: 'cus_recon',
      providerPriceId: null,
    });

    const outcome = await service.reconcile();

    /* 📌 Scoped to THIS subscription: the job is global, other suites leave rows. */
    const mine = outcome.findings.filter((f) => f.subscriptionId === row.id);

    expect(mine.map((f) => f.field).sort()).toEqual(['currentPeriodEnd', 'status']);

    /* 🔴 Re-read from MySQL: the row must not have moved. */
    const after = await subscriptions.findOneByOrFail({ id: row.id });

    expect(after.status).toBe(SubscriptionStatus.ACTIVE);
    expect(after.currentPeriodEnd?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  /**
   * 🔴 **And `--repair` reaches the column.** The mirror of the test above: with
   * the flag, the provider's values are what a later request would read.
   */
  it('writes the provider’s values when repair is asked for', async () => {
    const tenantId = await h.tenantIdOf(await tenantNamed(h, 'repair'));

    const subscriptions = dataSource.getRepository(Subscription);
    const row = await subscriptions.findOneByOrFail({ tenantId });

    row.provider = 'stripe';
    row.providerSubscriptionId = `sub_fix_${tenantId.slice(-8)}`;
    row.providerCustomerId = 'cus_fix';
    row.status = SubscriptionStatus.ACTIVE;
    row.currentPeriodEnd = new Date('2026-12-01T00:00:00.000Z');
    await subscriptions.save(row);

    const service = buildWith(h, {
      status: SubscriptionStatus.PAST_DUE,
      currentPeriodEnd: new Date('2027-03-01T00:00:00.000Z'),
      providerSubscriptionId: row.providerSubscriptionId,
      providerCustomerId: 'cus_fix',
      providerPriceId: null,
    });

    await service.reconcile({ dryRun: false });

    const after = await subscriptions.findOneByOrFail({ id: row.id });

    expect(after.status).toBe(SubscriptionStatus.PAST_DUE);
    expect(after.currentPeriodEnd?.toISOString()).toBe('2027-03-01T00:00:00.000Z');
  });
});

/** A tenant whose subscription row this suite then adopts. */
async function tenantNamed(h: Harness, which: string): Promise<string> {
  await h.tenant(which);

  return which;
}

/**
 * The real service over the real repositories, with a stub provider.
 *
 * ⚠️ **The PROVIDER is the only stub, and it has to be.** There is no Stripe
 * account in a test run, and F93 recorded that *"satisfies the contract" is not
 * "works against Stripe"*. Everything below it — the query TypeORM builds, the
 * comparison, and the write — is real.
 *
 * 📌 **Constructed directly rather than patched out of the container.** An
 * earlier version copied the container's instance and overwrote its private
 * `provider`, which depends on field ordering and would break silently if the
 * constructor changed. Taking the repositories from the live `DataSource` is
 * the same dependency graph, stated honestly.
 */
function buildWith(
  h: Harness,
  remote: {
    status: SubscriptionStatus;
    currentPeriodEnd: Date | null;
    providerSubscriptionId: string;
    providerCustomerId: string;
    providerPriceId: string | null;
  },
): SubscriptionReconcilerService {
  const provider = {
    getSubscription: async (id: string) => (id === remote.providerSubscriptionId ? remote : null),
  } as unknown as BillingProvider;

  return new SubscriptionReconcilerService(
    h.dataSource.getRepository(Subscription),
    h.dataSource.getRepository(PlanPrice),
    provider,
  );
}
