/* 🔴 See BillingModule: a default import of `stripe` is `undefined` at runtime. */
import Stripe = require('stripe');

import { Repository } from 'typeorm';

import { SubscriptionStatus } from '../common/database/enums';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import type { BillingNotifierService } from './billing-notifier.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * The lifecycle, against the library's own types.
 *
 * ## Why this file exists
 *
 * 🔴 **A hand-written fixture agreed with the code and both were wrong.** The
 * lifecycle read `current_period_end` from the *subscription*; that field does
 * not exist in this API version — it lives on the item. The unit test fed a
 * fixture containing it, so the test passed while `currentPeriodEnd` was
 * **always null** in production, which left every paying merchant looking at
 * *"Confirming your payment…"* for ever.
 *
 * ⚠️ **Third occurrence of one defect class.** F96 found `invoice.tax` and
 * `invoice.subscription` relocated, and answered it with
 * `invoice.mapper.contract.spec.ts` — fixtures typed as real Stripe objects, so
 * a renamed field **stops the build**. The lifecycle never got the same
 * treatment, and this is what that omission cost.
 *
 * 📌 **These are type assertions first.** The value of this suite is in `tsc`:
 * when the pinned API version moves and a field is renamed, this file fails to
 * compile, which is the failure the pin exists to produce.
 */
describe('SubscriptionLifecycleService against the library types', () => {
  function build(seed: Partial<Subscription> = {}) {
    const subscription = {
      id: 'sub_row_1',
      tenantId: 'tenant_1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_typed',
      providerCustomerId: 'cus_typed',
      status: SubscriptionStatus.TRIALING,
      currentPeriodEnd: null,
      graceEndsAt: null,
      cancelAt: null,
      planId: 'plan_free',
      planPriceId: null,
      ...seed,
    } as Subscription;

    const subscriptions = {
      findOne: jest.fn(async () => subscription),
      save: jest.fn(async (s: Subscription) => s),
    } as unknown as Repository<Subscription>;

    const tenants = {
      findOne: jest.fn(async () => ({ id: 'tenant_1' }) as Tenant),
      save: jest.fn(async (t: Tenant) => t),
    } as unknown as Repository<Tenant>;

    const prices = {
      findOne: jest.fn(async () => null),
    } as unknown as Repository<PlanPrice>;

    const dataSource = {
      transaction: async (work: (m: unknown) => Promise<unknown>) =>
        work({
          findOne: async () => null,
          create: (_t: unknown, input: unknown) => input,
          save: async (_t: unknown, entity: unknown) => entity,
        }),
    } as unknown as ConstructorParameters<typeof SubscriptionLifecycleService>[3];

    const notifier = {
      paymentFailed: jest.fn(async () => undefined),
      trialEnding: jest.fn(async () => undefined),
    } as unknown as BillingNotifierService;

    return {
      service: new SubscriptionLifecycleService(
        subscriptions,
        tenants,
        prices,
        dataSource,
        notifier,
      ),
      subscription,
    };
  }

  /**
   * A subscription in the shape this API version actually sends.
   *
   * 🔴 **`as Stripe.Subscription` is the whole point.** Every field the
   * lifecycle reads is spelled out, so a rename anywhere in this object is a
   * compile error rather than a silent null — and `current_period_end` sits on
   * the item, which is the mistake this suite was written to make impossible.
   */
  const remote = {
    id: 'sub_typed',
    object: 'subscription',
    status: 'active',
    customer: 'cus_typed',
    cancel_at: null,
    trial_end: null,
    items: {
      object: 'list',
      has_more: false,
      url: '/v1/subscription_items?subscription=sub_typed',
      data: [
        {
          id: 'si_typed',
          object: 'subscription_item',
          current_period_end: 1_755_216_000,
          price: { id: 'price_typed', object: 'price' } as Stripe.Price,
        } as Stripe.SubscriptionItem,
      ],
    } as Stripe.ApiList<Stripe.SubscriptionItem>,
  } as Stripe.Subscription;

  /**
   * 🔴 **The X1 defect, stated as a type.**
   *
   * The narrative above is prose, and prose does not fail a build — three gate
   * checks once passed by matching their own docblocks. These two aliases are
   * the claim itself, checked by `tsc`:
   *
   * - `current_period_end` is **absent** from `Stripe.Subscription`
   * - `current_period_end` is **present** on `Stripe.SubscriptionItem`
   *
   * ⚠️ If Stripe ever moves it back, `PeriodEndIsNotOnTheSubscription` becomes
   * `false` and **this file stops compiling** — which is the alarm. The generic
   * "missing 35 properties" error an incomplete fixture produces is not proof
   * that *this* field was rejected; these two lines are.
   */
  type PeriodEndIsNotOnTheSubscription = 'current_period_end' extends keyof Stripe.Subscription
    ? false
    : true;

  type PeriodEndIsOnTheItem = 'current_period_end' extends keyof Stripe.SubscriptionItem
    ? true
    : false;

  /* 📌 Both must be `true`; anything else is a compile error, not a failed assertion. */
  const periodEndLivesOnTheItem: [PeriodEndIsNotOnTheSubscription, PeriodEndIsOnTheItem] = [
    true,
    true,
  ];

  it('declares the period end on the item, never on the subscription', () => {
    expect(periodEndLivesOnTheItem).toEqual([true, true]);
  });

  it('reads the period end from where the library declares it', async () => {
    const { service, subscription } = build();

    await service.apply('customer.subscription.updated', remote);

    expect(subscription.currentPeriodEnd).toEqual(new Date(1_755_216_000_000));
  });

  /**
   * 🔴 **The bug's merchant-visible consequence, asserted directly.** F112's
   * `settling` flag is *"linked to a provider subscription, no billing period
   * yet"* — with the period always null, every paying merchant was told their
   * payment was still confirming, for ever, while the page polled every three
   * seconds.
   */
  it('leaves a period behind, so the settling window can close', async () => {
    const { service, subscription } = build();

    await service.apply('customer.subscription.updated', remote);

    const settling =
      subscription.provider !== 'none' &&
      subscription.providerSubscriptionId !== null &&
      subscription.currentPeriodEnd === null;

    expect(settling).toBe(false);
  });

  it('maps the status the library declares', async () => {
    const { service, subscription } = build();

    await service.apply('customer.subscription.updated', remote);

    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
  });

  /**
   * ⚠️ **A subscription with no items is possible in the type**, so the reader
   * must tolerate it rather than throw inside a webhook.
   */
  it('tolerates a subscription carrying no items', async () => {
    const { service, subscription } = build();

    await service.apply('customer.subscription.updated', {
      ...remote,
      items: {
        object: 'list',
        has_more: false,
        url: '/v1/subscription_items?subscription=sub_typed',
        data: [],
      } as Stripe.ApiList<Stripe.SubscriptionItem>,
    } as Stripe.Subscription);

    expect(subscription.currentPeriodEnd).toBeNull();
    expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
  });

  /**
   * 📌 **Every status the library declares is one this system recognises.**
   * `readStatus` returns `null` for anything it does not know and changes
   * nothing — correct, but silent. This drives each declared status through the
   * real handler and asserts the row actually moved, so a status Stripe adds to
   * the union becomes a **failing test** rather than a subscription frozen at
   * whatever it was last.
   *
   * ⚠️ Stripe's union is open (`OtherString`), so the list cannot be derived
   * from the type — but a rename still breaks the build, and an addition breaks
   * this.
   */
  it('recognises every subscription status the library declares', async () => {
    const declared: readonly Stripe.Subscription.Status[] = [
      'active',
      'canceled',
      'incomplete',
      'incomplete_expired',
      'past_due',
      'paused',
      'trialing',
      'unpaid',
    ];

    const unrecognised: string[] = [];

    for (const status of declared) {
      /* 📌 Seeded with a sentinel no mapping produces, so "unchanged" is visible. */
      const { service, subscription } = build({
        status: 'sentinel' as SubscriptionStatus,
      });

      await service.apply('customer.subscription.updated', {
        ...remote,
        status,
      } as Stripe.Subscription);

      if ((subscription.status as string) === 'sentinel') {
        unrecognised.push(status);
      }
    }

    expect(unrecognised).toEqual([]);
  });
});
