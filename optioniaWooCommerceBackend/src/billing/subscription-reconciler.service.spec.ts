import { Repository } from 'typeorm';

import { SubscriptionStatus } from '../common/database/enums';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import type { BillingProvider, ProviderSubscription } from './billing-provider';
import type { PlanChangeInvalidatorService } from './plan-change-invalidator.service';
import { SubscriptionReconcilerService } from './subscription-reconciler.service';

/**
 * M23.5 — the diff that notices a webhook nobody received.
 *
 * 🔴 **`getSubscription` was the FIFTH mechanism built and called by nothing**
 * — implemented, covered by six tests, and every caller a test. These are the
 * assertions that give it a production reason to exist.
 */
describe('SubscriptionReconcilerService', () => {
  const PERIOD_END = new Date('2026-12-01T00:00:00.000Z');

  function build(options: {
    rows?: Partial<Subscription>[];
    remote?: Partial<ProviderSubscription> | null;
    fails?: Error;
    price?: Partial<PlanPrice> | null;
    provider?: BillingProvider | null;
  }) {
    const rows = (options.rows ?? [
      {
        id: 'row_1',
        tenantId: 'tenant_1',
        provider: 'stripe',
        providerSubscriptionId: 'sub_1',
        providerCustomerId: 'cus_1',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PERIOD_END,
        planId: 'plan_pro',
        planPriceId: 'price_row_1',
      },
    ]) as Subscription[];

    const save = jest.fn(async (s: Subscription) => s);

    const subscriptions = {
      find: jest.fn(async () => rows),
      save,
    } as unknown as Repository<Subscription>;

    const prices = {
      findOne: jest.fn(async () =>
        options.price === undefined
          ? ({ id: 'price_row_1', planId: 'plan_pro' } as PlanPrice)
          : (options.price as PlanPrice | null),
      ),
    } as unknown as Repository<PlanPrice>;

    const getSubscription = jest.fn(async (): Promise<ProviderSubscription | null> => {
      if (options.fails !== undefined) {
        throw options.fails;
      }

      if (options.remote === null) {
        return null;
      }

      return {
        providerSubscriptionId: 'sub_1',
        providerCustomerId: 'cus_1',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: PERIOD_END,
        providerPriceId: 'price_provider_1',
        ...options.remote,
      };
    });

    const provider =
      options.provider === null
        ? null
        : ({ getSubscription } as unknown as BillingProvider);

    /* 📌 F121: a plan repair must invalidate config; the spy proves it happens. */
    const invalidate = jest.fn(async () => 1);

    const invalidator = { invalidate } as unknown as PlanChangeInvalidatorService;

    return {
      service: new SubscriptionReconcilerService(subscriptions, prices, provider, invalidator),
      invalidate,
      getSubscription,
      save,
      subscriptions,
      rows,
    };
  }

  /** 📌 Nothing differs, so nothing is reported — the quiet case must be quiet. */
  it('reports nothing when the provider agrees', async () => {
    const { service } = build({});

    const outcome = await service.reconcile();

    expect(outcome.findings).toEqual([]);
    expect(outcome.checked).toBe(1);
  });

  /**
   * 🔴 **The highest-severity drift: `status` governs access.** A missed
   * `customer.subscription.updated` leaves a lapsed merchant looking active, or
   * a recovered one still locked out.
   */
  it('reports a drifted status without writing by default', async () => {
    const { service, save } = build({ remote: { status: SubscriptionStatus.PAST_DUE } });

    const outcome = await service.reconcile();

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({
      field: 'status',
      local: SubscriptionStatus.ACTIVE,
      remote: SubscriptionStatus.PAST_DUE,
      repaired: false,
    });

    /* 🔴 The whole safety argument: a report writes nothing. */
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **Repair is opt-in**, because a job that writes on every difference is
   * one provider outage away from mass-downgrading paying merchants.
   */
  it('repairs a drifted status only when asked', async () => {
    const { service, save, rows } = build({ remote: { status: SubscriptionStatus.PAST_DUE } });

    const outcome = await service.reconcile({ dryRun: false });

    expect(outcome.findings[0]).toMatchObject({ field: 'status', repaired: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(rows[0].status).toBe(SubscriptionStatus.PAST_DUE);
  });

  /**
   * 🔴 **F118's field, now with a second net.** `currentPeriodEnd` was
   * permanently null in production and five merchant-visible behaviours broke
   * on it. Compared by epoch milliseconds: two `Date` objects are never `===`.
   */
  it('reports a drifted period end', async () => {
    const moved = new Date('2027-01-01T00:00:00.000Z');
    const { service } = build({ remote: { currentPeriodEnd: moved } });

    const outcome = await service.reconcile();

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({
      field: 'currentPeriodEnd',
      local: PERIOD_END.toISOString(),
      remote: moved.toISOString(),
    });
  });

  /**
   * ⚠️ **Equal dates are not the same object.** A naive `!==` on two `Date`s
   * reports every subscription in the database as drifted, every run.
   */
  it('does not report two equal dates as drift', async () => {
    const { service } = build({
      remote: { currentPeriodEnd: new Date(PERIOD_END.getTime()) },
    });

    await expect(service.reconcile()).resolves.toMatchObject({ findings: [] });
  });

  /**
   * 🔴 **A plan changed in Stripe's own portal reaches us only here** when its
   * webhook was missed — and the consequence is a merchant on the wrong plan
   * limits, which Phase 24 enforces against.
   */
  it('reports a plan price that no longer matches', async () => {
    const { service } = build({
      price: { id: 'price_row_2', planId: 'plan_business' } as PlanPrice,
    });

    const outcome = await service.reconcile();

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({
      field: 'planPriceId',
      local: 'price_row_1',
      remote: 'price_row_2',
    });
  });

  /** 📌 And repairing it moves the PLAN too, or limits stay wrong. */
  it('moves the plan with the price when repairing', async () => {
    const { service, rows } = build({
      price: { id: 'price_row_2', planId: 'plan_business' } as PlanPrice,
    });

    await service.reconcile({ dryRun: false });

    expect(rows[0].planPriceId).toBe('price_row_2');
    expect(rows[0].planId).toBe('plan_business');
  });

  /**
   * 🔴 **F121: the reconciler is the SECOND path that moves a plan.** Fixing
   * only the webhook would have left this one silently broken while the
   * finding looked closed — the exact shape of the built-but-uncalled defect
   * this phase kept producing.
   */
  it('invalidates cached config when a repair moves the plan', async () => {
    const { service, invalidate } = build({
      price: { id: 'price_row_2', planId: 'plan_business' } as PlanPrice,
    });

    await service.reconcile({ dryRun: false });

    expect(invalidate).toHaveBeenCalledWith('tenant_1');
  });

  /**
   * 🔴 **A dry run invalidates nothing.** Reporting drift must not push a
   * configuration change to a storefront whose plan did not actually move.
   */
  it('does not invalidate on a dry run', async () => {
    const { service, invalidate } = build({
      price: { id: 'price_row_2', planId: 'plan_business' } as PlanPrice,
    });

    await service.reconcile();

    expect(invalidate).not.toHaveBeenCalled();
  });

  /** ⚠️ A status-only repair moves no plan, so it invalidates nothing. */
  it('does not invalidate when only the status was repaired', async () => {
    const { service, invalidate } = build({ remote: { status: SubscriptionStatus.PAST_DUE } });

    await service.reconcile({ dryRun: false });

    expect(invalidate).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **An unknown price is a finding, never a repair.** `plan_prices` is the
   * join; a price we have never seen means our catalogue is behind, and
   * pointing `planPriceId` at nothing would make it worse.
   */
  it('reports an unknown provider price without repairing it', async () => {
    const { service, save } = build({ price: null });

    const outcome = await service.reconcile({ dryRun: false });

    expect(outcome.findings[0]).toMatchObject({ field: 'planPriceId' });
    expect(outcome.findings[0].remote).toContain('unknown price');
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **"The provider forgot this" is a finding, never a repair.** Acting on it
   * would act on the answer most likely to be a misconfiguration: a wrong API
   * key points at an account where none of our ids exist, and every
   * subscription looks missing at once.
   */
  it('records a subscription the provider has forgotten, and writes nothing', async () => {
    const { service, save } = build({ remote: null });

    const outcome = await service.reconcile({ dryRun: false });

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({ field: 'missing', repaired: false });
    expect(save).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **Our bug must not be filed as their drift.** F93 narrowed the adapter's
   * catch to `resource_missing` for exactly this: a malformed id or a rejected
   * parameter recorded as "forgotten" means the real bug never surfaces.
   */
  it('keeps a provider error out of the findings', async () => {
    const { service } = build({ fails: new Error('unknown parameter') });

    const outcome = await service.reconcile();

    expect(outcome.findings).toEqual([]);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toContain('unknown parameter');
  });

  /**
   * ⚠️ **One bad subscription must not abandon the rest.** A throw inside the
   * loop would leave every later merchant unchecked — and the reconciler exists
   * precisely for the cases nobody is watching.
   */
  it('continues past a failing subscription', async () => {
    const { service, getSubscription } = build({
      rows: [
        {
          id: 'row_1',
          tenantId: 'tenant_1',
          provider: 'stripe',
          providerSubscriptionId: 'sub_1',
          providerCustomerId: 'cus_1',
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: PERIOD_END,
          planPriceId: 'price_row_1',
        },
        {
          id: 'row_2',
          tenantId: 'tenant_2',
          provider: 'stripe',
          providerSubscriptionId: 'sub_2',
          providerCustomerId: 'cus_1',
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: PERIOD_END,
          planPriceId: 'price_row_1',
        },
      ],
    });

    getSubscription.mockRejectedValueOnce(new Error('rate limited'));

    const outcome = await service.reconcile();

    expect(outcome.checked).toBe(2);
    expect(outcome.errors).toHaveLength(1);
  });

  /**
   * 🔴 **A free tenant is not drift.** `provider: 'none'` and no remote id;
   * asking Stripe would be a guaranteed miss and would report every free
   * merchant in the database as a finding, every run.
   */
  it('asks only for subscriptions linked to a provider', async () => {
    const { service, subscriptions } = build({});

    await service.reconcile();

    const [[query]] = (subscriptions.find as jest.Mock).mock.calls as [
      [{ where: Record<string, { type?: string; value?: unknown; child?: { type: string } }> }],
    ];

    /*
     * 📌 **The OPERATORS are asserted, not merely the keys.** An earlier version
     * checked `toBeDefined()`, which passed against `where: {}` — a filter that
     * scans every free tenant in the database. TypeORM's FindOperator carries
     * its `type`, so the intent is checkable: NOT 'none', and NOT NULL.
     */
    expect(query.where.provider.type).toBe('not');
    expect(query.where.provider.value).toBe('none');
    expect(query.where.providerSubscriptionId.type).toBe('not');
    /* 📌 The nested operator hangs off `.child`, not `.value` — verified, not assumed. */
    expect(query.where.providerSubscriptionId.child?.type).toBe('isNull');
  });

  /**
   * ⚠️ **A deployment with no billing configured must not crash.** G2's
   * finding: the token is a bare symbol, so the nullable case has to be real.
   */
  it('reports rather than throws when no provider is configured', async () => {
    const { service } = build({ provider: null });

    const outcome = await service.reconcile();

    expect(outcome.checked).toBe(0);
    expect(outcome.errors).toHaveLength(1);
  });

  /**
   * 📌 **Two drifts on one subscription are two findings.** Collapsing them to
   * a single "differs" hides the one that matters.
   */
  it('reports each drifted field independently', async () => {
    const { service } = build({
      remote: {
        status: SubscriptionStatus.PAST_DUE,
        currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'),
      },
    });

    const outcome = await service.reconcile();

    expect(outcome.findings.map((f) => f.field).sort()).toEqual(['currentPeriodEnd', 'status']);
  });
});
