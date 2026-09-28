import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PlanLimitGuard } from '../usage/plan-limit.guard';
import { Repository } from 'typeorm';

import * as requestContext from '../common/context/request-context';
import { InvoiceStatus, SubscriptionStatus } from '../common/database/enums';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Plan } from '../plans/entities/plan.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import type { BillingProvider } from './billing-provider';
import { BillingAccountService } from './billing-account.service';
import { Invoice } from './entities/invoice.entity';

/**
 * What a merchant can see and do about their own billing (M22.E1–E4).
 *
 * 🔴 **Nothing here writes subscription state, and several tests exist only to
 * prove that.** M22.4 requires state to come from verified webhooks, so a
 * cancel records intent at the provider and the webhook records the truth —
 * writing it locally would create a second source that disagrees the moment a
 * call succeeds and its webhook does not arrive.
 */
describe('BillingAccountService', () => {
  beforeEach(() => {
    jest.spyOn(requestContext, 'requireTenantId').mockReturnValue('tenant_1');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const plan = { id: 'plan_pro', code: 'pro', name: 'Pro' } as Plan;

  const pinnedPrice = {
    id: 'price_row_pro',
    planId: plan.id,
    currency: 'USD',
    interval: 'month',
    amountMinor: 2900,
    providerPriceId: 'price_stripe_pro',
    isCurrent: true,
  } as PlanPrice;

  function build(
    seed: {
      subscription?: Partial<Subscription> | null;
      invoices?: Partial<Invoice>[];
      price?: Partial<PlanPrice> | null;
      currentPrice?: Partial<PlanPrice> | null;
      provider?: BillingProvider | null;
    } = {},
  ) {
    const updatePlan = jest.fn(async () => undefined);
    const cancelSubscription = jest.fn(async () => undefined);
    const createPortalSession = jest.fn(async () => ({ url: 'https://portal.test/session' }));

    const provider =
      seed.provider === undefined
        ? ({
            name: 'stripe',
            updatePlan,
            cancelSubscription,
            createPortalSession,
          } as unknown as BillingProvider)
        : seed.provider;

    const subscription =
      seed.subscription === null
        ? null
        : ({
            id: 'sub_row_1',
            tenantId: 'tenant_1',
            plan,
            planId: plan.id,
            planPrice: pinnedPrice,
            planPriceId: pinnedPrice.id,
            provider: 'stripe',
            providerSubscriptionId: 'sub_stripe_1',
            status: SubscriptionStatus.ACTIVE,
            currentPeriodEnd: new Date('2026-10-25T00:00:00.000Z'),
            cancelAt: null,
            trialEndsAt: null,
            graceEndsAt: null,
            ...seed.subscription,
          } as Subscription);

    const updates: Array<Record<string, unknown>> = [];

    const subscriptions = {
      findOne: jest.fn(async () => subscription),
      update: jest.fn(async (_where: unknown, set: Record<string, unknown>) => {
        updates.push(set);
        return { affected: 1 };
      }),
    } as unknown as Repository<Subscription>;

    const invoices = {
      find: jest.fn(async () => seed.invoices ?? []),
    } as unknown as Repository<Invoice>;

    /*
     * ⚠️ `changePlan` looks up the target price first, then the current one.
     * Ordering the stub this way keeps the test honest about that sequence.
     */
    const lookups = [seed.price, seed.currentPrice ?? pinnedPrice];
    let call = 0;

    const prices = {
      findOne: jest.fn(async () => {
        const value = lookups[call] ?? null;
        call += 1;
        return (value ?? null) as PlanPrice | null;
      }),
    } as unknown as Repository<PlanPrice>;

    return {
      service: new BillingAccountService(provider, subscriptions, invoices, prices, {
        /* 📌 M24.4: usage is proven in the e2e; this spec is about the plan card. */
        report: async () => [],
      } as unknown as PlanLimitGuard),
      subscriptions,
      invoices,
      updates,
      updatePlan,
      cancelSubscription,
      createPortalSession,
    };
  }

  describe('E1 — the subscription summary', () => {
    it('reports the plan and the price it is pinned to', async () => {
      const { service } = build();

      await expect(service.summary()).resolves.toEqual({
        /*
         * 📌 **Empty because this spec's guard is a stub.** M24.4's usage is
         * proven against real plans and real counts in `plan-usage.e2e-spec`;
         * what this assertion still owns is the plan card's exact shape, and
         * `toEqual` is exhaustive so a new field cannot arrive unnoticed.
         */
        usage: [],
        planCode: 'pro',
        planName: 'Pro',
        status: SubscriptionStatus.ACTIVE,
        currency: 'USD',
        amountMinor: 2900,
        interval: 'month',
        currentPeriodEnd: '2026-10-25T00:00:00.000Z',
        cancelAt: null,
        trialEndsAt: null,
        graceEndsAt: null,
        settling: false,
      });
    });

    /**
     * 🔴 **From the PINNED price, never the plan's current figure.** A merchant
     * sees what they are charged, which is the row they bought — ADR-117's
     * grandfathering made visible.
     */
    it('shows the pinned amount even when it is not the plan’s current one', async () => {
      const { service } = build({
        subscription: {
          planPrice: { ...pinnedPrice, amountMinor: 1900 } as PlanPrice,
        },
      });

      await expect(service.summary()).resolves.toMatchObject({ amountMinor: 1900 });
    });

    /** 📌 ADR-116's deadline is shown, because a merchant cannot act on a date they cannot see. */
    it('exposes the grace deadline', async () => {
      const { service } = build({
        subscription: {
          status: SubscriptionStatus.PAST_DUE,
          graceEndsAt: new Date('2026-10-09T00:00:00.000Z'),
        },
      });

      await expect(service.summary()).resolves.toMatchObject({
        status: SubscriptionStatus.PAST_DUE,
        graceEndsAt: '2026-10-09T00:00:00.000Z',
      });
    });

    /** ⚠️ Every tenant gets one at provisioning, so absence is a data fault. */
    it('refuses when the tenant has no subscription record', async () => {
      const { service } = build({ subscription: null });

      await expect(service.summary()).rejects.toThrow(NotFoundException);
    });
  });

  describe('E2 — invoice history', () => {
    it('maps an invoice to what a merchant needs to see', async () => {
      const { service } = build({
        invoices: [
          {
            id: 'inv_1',
            providerInvoiceId: 'in_stripe_1',
            status: InvoiceStatus.PAID,
            currency: 'USD',
            subtotalMinor: 2900,
            taxMinor: 0,
            totalMinor: 2900,
            issuedAt: new Date('2026-09-25T00:00:00.000Z'),
            paidAt: new Date('2026-09-25T00:01:00.000Z'),
            hostedUrl: 'https://invoice.stripe.com/i/abc',
          },
        ],
      });

      await expect(service.listInvoices(25)).resolves.toEqual([
        {
          id: 'inv_1',
          number: 'in_stripe_1',
          status: InvoiceStatus.PAID,
          currency: 'USD',
          subtotalMinor: 2900,
          taxMinor: 0,
          totalMinor: 2900,
          issuedAt: '2026-09-25T00:00:00.000Z',
          paidAt: '2026-09-25T00:01:00.000Z',
          hostedUrl: 'https://invoice.stripe.com/i/abc',
        },
      ]);
    });

    /**
     * 🔴 **Scoped to the caller's tenant, newest first.** A billing list that
     * forgot its `WHERE` would show one merchant another's invoices.
     */
    it('queries only this tenant, newest first, honouring the limit', async () => {
      const { service, invoices } = build();

      await service.listInvoices(10);

      expect(invoices.find).toHaveBeenCalledWith({
        where: { tenantId: 'tenant_1' },
        order: { issuedAt: 'DESC', id: 'DESC' },
        take: 10,
      });
    });

    it('returns an empty list rather than failing when there are none', async () => {
      await expect(build().service.listInvoices(25)).resolves.toEqual([]);
    });
  });

  describe('E3 — changing plan', () => {
    const target = {
      id: 'price_row_business',
      currency: 'USD',
      interval: 'month',
      providerPriceId: 'price_stripe_business',
      isCurrent: true,
    } as PlanPrice;

    it('sends the provider’s price id, not our row id', async () => {
      const { service, updatePlan } = build({ price: target });

      await expect(service.changePlan('price_row_business')).resolves.toEqual({ accepted: true });

      expect(updatePlan).toHaveBeenCalledWith({
        providerSubscriptionId: 'sub_stripe_1',
        planPriceId: 'price_stripe_business',
      });
    });

    /**
     * 🔴 **Nothing local is written.** `customer.subscription.updated` moves
     * `planId` and `planPriceId` (H3); writing them here would be a second
     * source disagreeing with the provider whenever the webhook is delayed.
     */
    it('writes no local state', async () => {
      const { service, subscriptions } = build({ price: target });

      await service.changePlan('price_row_business');

      expect(subscriptions.update).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown price', null, NotFoundException],
      ['a superseded price', { ...target, isCurrent: false } as PlanPrice, BadRequestException],
      [
        'a price with no provider id',
        { ...target, providerPriceId: null } as PlanPrice,
        BadRequestException,
      ],
    ])('refuses %s', async (_label, price, error) => {
      const { service, updatePlan } = build({ price });

      await expect(service.changePlan('price_row_business')).rejects.toThrow(error);
      expect(updatePlan).not.toHaveBeenCalled();
    });

    /** ⚠️ A no-op change would bill a proration of zero and confuse everyone. */
    it('refuses a change to the price already held', async () => {
      const { service, updatePlan } = build({ price: pinnedPrice });

      await expect(service.changePlan('price_row_pro')).rejects.toThrow(
        'This account is already on that price',
      );
      expect(updatePlan).not.toHaveBeenCalled();
    });

    /**
     * 🔴 **F94/E4 on the path that did not exist when it was written.** An
     * upgrade into another currency leaves one tenant holding invoices in two
     * currencies, in a column that stores no currency per amount.
     */
    it('refuses a price in a different currency from the current one', async () => {
      const { service, updatePlan } = build({
        price: { ...target, currency: 'EUR' } as PlanPrice,
        currentPrice: pinnedPrice,
      });

      await expect(service.changePlan('price_row_business')).rejects.toThrow(
        'This subscription is billed in USD; that price is in EUR',
      );
      expect(updatePlan).not.toHaveBeenCalled();
    });

    /** ⚠️ A free-tier tenant has no provider subscription to change. */
    it('refuses when there is no paid subscription', async () => {
      const { service, updatePlan } = build({
        subscription: { providerSubscriptionId: null },
        price: target,
      });

      await expect(service.changePlan('price_row_business')).rejects.toThrow(
        'no paid subscription to change',
      );
      expect(updatePlan).not.toHaveBeenCalled();
    });
  });

  describe('E4 — cancelling', () => {
    /**
     * ⚠️ **At the period's end.** The merchant paid for the term; ending it
     * immediately takes something they bought.
     */
    it('cancels at the period end when asked to', async () => {
      const { service, cancelSubscription } = build();

      await expect(service.cancel({ atPeriodEnd: true, reason: null })).resolves.toEqual({
        accepted: true,
      });

      expect(cancelSubscription).toHaveBeenCalledWith({
        providerSubscriptionId: 'sub_stripe_1',
        atPeriodEnd: true,
      });
    });

    it('cancels immediately when explicitly asked', async () => {
      const { service, cancelSubscription } = build();

      await service.cancel({ atPeriodEnd: false, reason: null });

      expect(cancelSubscription).toHaveBeenCalledWith({
        providerSubscriptionId: 'sub_stripe_1',
        atPeriodEnd: false,
      });
    });

    /**
     * 📌 **The reason is ours, and it is the ONLY local write here.** A reason
     * in the provider's metadata is readable only by whoever opens their
     * dashboard; churn analysis needs it beside the plan and the tenure.
     */
    it('records the reason locally, and nothing else', async () => {
      const { service, updates } = build();

      await service.cancel({ atPeriodEnd: true, reason: 'Too expensive' });

      expect(updates).toEqual([{ cancellationReason: 'Too expensive' }]);
    });

    /** ⚠️ No reason given is a valid answer and must not fabricate one. */
    it('writes nothing when no reason is given', async () => {
      const { service, subscriptions } = build();

      await service.cancel({ atPeriodEnd: true, reason: null });

      expect(subscriptions.update).not.toHaveBeenCalled();
    });

    /** 🔴 The status still comes from the webhook, never from this call. */
    it('does not mark the subscription cancelled locally', async () => {
      const { service, updates } = build();

      await service.cancel({ atPeriodEnd: true, reason: 'Moving on' });

      expect(updates).toEqual([{ cancellationReason: 'Moving on' }]);
      expect(updates[0]).not.toHaveProperty('status');
    });

    it('refuses a second cancellation', async () => {
      const { service, cancelSubscription } = build({
        subscription: { status: SubscriptionStatus.CANCELLED },
      });

      await expect(service.cancel({ atPeriodEnd: true, reason: null })).rejects.toThrow(
        'already cancelled',
      );
      expect(cancelSubscription).not.toHaveBeenCalled();
    });

    it('refuses when there is no paid subscription', async () => {
      const { service, cancelSubscription } = build({
        subscription: { providerSubscriptionId: null },
      });

      await expect(service.cancel({ atPeriodEnd: true, reason: null })).rejects.toThrow(
        'no paid subscription to cancel',
      );
      expect(cancelSubscription).not.toHaveBeenCalled();
    });
  });

  /** 🔴 G3's guard, on both write paths. */
  describe('when billing is unconfigured', () => {
    it.each([
      ['changePlan', (s: BillingAccountService) => s.changePlan('price_row_business')],
      [
        'cancel',
        (s: BillingAccountService) => s.cancel({ atPeriodEnd: true, reason: null }),
      ],
    ])('%s fails with a reason an operator can act on', async (_label, call) => {
      const { service } = build({ provider: null });

      await expect(call(service)).rejects.toThrow(
        'No billing provider is configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET absent).',
      );
    });
  });

  /**
   * E5 — the provider's billing portal (M22.3, M22.5).
   *
   * 🔴 **Payment methods are the provider's surface deliberately.** Collecting
   * card details here would put this service in PCI scope for no benefit a
   * merchant can see.
   */
  describe('the billing portal', () => {
    /*
     * ⚠️ **`loadConfig` validates the whole environment**, not just `APP_URL`,
     * so a partial one fails on JWT_SECRET before the return URL is built —
     * the same baseline `MailModule`'s and `CheckoutService`'s suites keep.
     *
     * 📌 **Overlaid, never wiped** (K4): a suite that empties `process.env`
     * breaks siblings that captured their baseline at module load.
     */
    const saved = { ...process.env };

    const VALID_ENV: Record<string, string> = {
      NODE_ENV: 'test',
      PORT: '4000',
      DB_HOST: '127.0.0.1',
      DB_PORT: '3306',
      DB_NAME: 'optionia_woo_test',
      DB_USER: 'testuser',
      DB_PASSWORD: 'testpassword',
      DB_SSL: 'false',
      JWT_SECRET: 'x'.repeat(48),
      CORS_ORIGINS: 'http://localhost:3000',
      APP_URL: 'https://dash.example.test',
    };

    beforeEach(() => {
      Object.assign(process.env, VALID_ENV);
    });

    afterEach(() => {
      Object.assign(process.env, saved);
    });

    it('returns a portal URL for a tenant with a provider customer', async () => {
      const { service, createPortalSession } = build({
        subscription: { providerCustomerId: 'cus_1' },
      });

      await expect(service.portalSession()).resolves.toEqual({
        url: 'https://portal.test/session',
      });

      expect(createPortalSession).toHaveBeenCalledWith({
        providerCustomerId: 'cus_1',
        returnUrl: 'https://dash.example.test/billing',
      });
    });

    /** ⚠️ Nothing to show a merchant who has never paid — refused with a reason. */
    it('refuses a tenant with no billing profile', async () => {
      const { service, createPortalSession } = build({
        subscription: { providerCustomerId: null },
      });

      await expect(service.portalSession()).rejects.toThrow('no billing profile yet');
      expect(createPortalSession).not.toHaveBeenCalled();
    });

    /** 🔴 G3's guard, on the third write path. */
    it('fails with a named reason when billing is unconfigured', async () => {
      const { service } = build({ provider: null });

      await expect(service.portalSession()).rejects.toThrow(
        'No billing provider is configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET absent).',
      );
    });
  });

  /**
   * Q1 — the window between paying and the provider confirming.
   *
   * 🔴 **Without this the merchant who just paid sees the plan they left.**
   * `checkout.session.completed` links the provider ids and deliberately does
   * not set `ACTIVE`; `customer.subscription.updated` carries the real state
   * moments later. The success page lands in between.
   */
  describe('the settling window', () => {
    it('reports settling once checkout has linked a provider subscription', async () => {
      const { service } = build({
        subscription: {
          provider: 'stripe',
          providerSubscriptionId: 'sub_stripe_1',
          currentPeriodEnd: null,
          status: SubscriptionStatus.TRIALING,
        },
      });

      await expect(service.summary()).resolves.toMatchObject({ settling: true });
    });

    /** ⚠️ Once the provider has confirmed the terms, it is settled. */
    it('stops reporting settling when a billing period arrives', async () => {
      const { service } = build({
        subscription: { currentPeriodEnd: new Date('2026-10-25T00:00:00.000Z') },
      });

      await expect(service.summary()).resolves.toMatchObject({ settling: false });
    });

    /**
     * 🔴 **A free tenant is settled, not settling.** It has no period either,
     * so `provider !== 'none'` is what keeps the two cases apart — without it
     * every free merchant would see "confirming your payment" for ever.
     */
    it('never reports settling for a tenant that has not paid', async () => {
      const { service } = build({
        subscription: {
          provider: 'none',
          providerSubscriptionId: null,
          currentPeriodEnd: null,
        },
      });

      await expect(service.summary()).resolves.toMatchObject({ settling: false });
    });

    /**
     * 🔴 **The `provider` check tested on its own, because the test above did
     * not reach it.** That one nulls the subscription id as well, so the second
     * condition short-circuits and a mutation removing `provider !== 'none'`
     * **survived**. Holding the id non-null isolates the clause — and this is
     * the shape a stale or hand-edited row takes, which is exactly when a free
     * merchant would otherwise be told "confirming your payment" for ever.
     */
    it('never reports settling for provider "none", even with a stale id', async () => {
      const { service } = build({
        subscription: {
          provider: 'none',
          providerSubscriptionId: 'sub_left_over',
          currentPeriodEnd: null,
        },
      });

      await expect(service.summary()).resolves.toMatchObject({ settling: false });
    });

    /** ⚠️ And a cancelled subscription keeps its period, so it is settled too. */
    it('does not report settling for a cancelled subscription', async () => {
      const { service } = build({
        subscription: {
          status: SubscriptionStatus.CANCELLED,
          currentPeriodEnd: new Date('2026-10-25T00:00:00.000Z'),
        },
      });

      await expect(service.summary()).resolves.toMatchObject({ settling: false });
    });
  });
});
