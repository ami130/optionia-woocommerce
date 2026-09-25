import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import * as requestContext from '../common/context/request-context';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import type { BillingProvider } from './billing-provider';
import { CheckoutService } from './checkout.service';

/**
 * The entrance to Phase 22 (H1), and the currency check F94/E4 deferred.
 *
 * 🔴 **Everything downstream was waiting on an event no merchant could
 * produce.** `createCheckout` was built and tested and nothing called it, so
 * `checkout.session.completed` could never fire. These tests exist because the
 * gap was in what I *planned*, not in what I wrote — an audit of the code alone
 * would never have found it.
 */
describe('CheckoutService', () => {
  const originalEnv = { ...process.env };

  /**
   * `loadConfig` validates the whole environment, not just `APP_URL`, so a
   * partial one fails on JWT_SECRET before the success URL is ever built — the
   * same baseline `MailModule`'s and `BillingModule`'s suites keep.
   */
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

  /*
   * 🔴 **Overlaid, not wiped.** Emptying `process.env` here broke
   * `billing.module.spec.ts` — which captures its own baseline at module load,
   * i.e. *after* this file's `beforeEach` has already run in the same worker.
   * It passed alone and failed in a full run: a suite that destroys shared
   * global state is an aggressor even when its own assertions are right.
   *
   * ⚠️ This suite needs no absent variables, only present ones, so adding is
   * enough and removing was never necessary.
   */
  beforeEach(() => {
    Object.assign(process.env, VALID_ENV);
    jest.spyOn(requestContext, 'requireTenantId').mockReturnValue('tenant_1');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(process.env, originalEnv);
  });

  function build(
    seed: {
      price?: Partial<PlanPrice> | null;
      tenant?: Partial<Tenant> | null;
      subscription?: Partial<Subscription> | null;
      provider?: BillingProvider | null;
    } = {},
  ) {
    const createCheckout = jest.fn(async () => ({
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      reference: 'cs_test_1',
    }));

    const provider =
      seed.provider === undefined
        ? ({ name: 'stripe', createCheckout } as unknown as BillingProvider)
        : seed.provider;

    const price =
      seed.price === null
        ? null
        : ({
            id: 'price_row_1',
            planId: 'plan_pro',
            currency: 'EUR',
            interval: 'month',
            amountMinor: 2900,
            providerPriceId: 'price_stripe_1',
            isCurrent: true,
            ...seed.price,
          } as PlanPrice);

    const tenant =
      seed.tenant === null
        ? null
        : ({ id: 'tenant_1', billingCurrency: null, ...seed.tenant } as Tenant);

    const prices = { findOne: jest.fn(async () => price) } as unknown as Repository<PlanPrice>;
    const tenants = { findOne: jest.fn(async () => tenant) } as unknown as Repository<Tenant>;
    const subscriptions = {
      findOne: jest.fn(async () => (seed.subscription ?? null) as Subscription | null),
    } as unknown as Repository<Subscription>;

    return {
      service: new CheckoutService(provider, prices, subscriptions, tenants),
      createCheckout,
    };
  }

  it('returns the provider’s checkout URL and its reference', async () => {
    const { service } = build();

    await expect(service.start({ planPriceId: 'price_row_1' })).resolves.toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      reference: 'cs_test_1',
    });
  });

  /**
   * 🔴 **The provider's price id, not ours.** `plan_prices.id` is a local uuid
   * Stripe has never seen; sending it would fail at the provider with an error
   * that reads like a misconfiguration.
   */
  it('sends the provider’s price id, not the local row id', async () => {
    const { service, createCheckout } = build();

    await service.start({ planPriceId: 'price_row_1' });

    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', planPriceId: 'price_stripe_1' }),
    );
  });

  /**
   * 📌 Reusing the customer keeps a merchant's payment methods, tax ids and
   * invoice history on one record rather than scattering them per purchase.
   */
  it('reuses an existing provider customer when the tenant has one', async () => {
    const { service, createCheckout } = build({
      subscription: { providerCustomerId: 'cus_existing' },
    });

    await service.start({ planPriceId: 'price_row_1' });

    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerId: 'cus_existing' }),
    );
  });

  it('passes null when the tenant has never paid', async () => {
    const { service, createCheckout } = build();

    await service.start({ planPriceId: 'price_row_1' });

    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerId: null }),
    );
  });

  describe('F94/E4 — the currency must agree', () => {
    /**
     * 🔴 **Nothing checked this before.** A tenant recorded as billing in EUR
     * could be charged in USD, and every later total would mix two currencies in
     * a column that stores no currency per amount.
     */
    it('refuses a price in a currency the tenant is not billed in', async () => {
      const { service, createCheckout } = build({
        tenant: { billingCurrency: 'USD' },
        price: { currency: 'EUR' },
      });

      await expect(service.start({ planPriceId: 'price_row_1' })).rejects.toThrow(
        'This account is billed in USD; that price is in EUR',
      );

      expect(createCheckout).not.toHaveBeenCalled();
    });

    it('accepts a price in the tenant’s own currency', async () => {
      const { service, createCheckout } = build({
        tenant: { billingCurrency: 'EUR' },
        price: { currency: 'EUR' },
      });

      await service.start({ planPriceId: 'price_row_1' });

      expect(createCheckout).toHaveBeenCalled();
    });

    /**
     * ⚠️ **A tenant with no currency is establishing one**, which is why the
     * column is nullable (ADR-118/F84) — a free-tier tenant has never been
     * billed, so there is nothing to disagree with.
     */
    it('allows a first purchase by a tenant with no currency yet', async () => {
      const { service, createCheckout } = build({ tenant: { billingCurrency: null } });

      await service.start({ planPriceId: 'price_row_1' });

      expect(createCheckout).toHaveBeenCalled();
    });

    it('compares case-insensitively', async () => {
      const { service, createCheckout } = build({
        tenant: { billingCurrency: 'eur' },
        price: { currency: 'EUR' },
      });

      await service.start({ planPriceId: 'price_row_1' });

      expect(createCheckout).toHaveBeenCalled();
    });
  });

  describe('what cannot be bought', () => {
    it('refuses an unknown price', async () => {
      const { service } = build({ price: null });

      await expect(service.start({ planPriceId: 'nope' })).rejects.toThrow(NotFoundException);
    });

    /**
     * ⚠️ **A retired price stays readable for the subscriptions pinned to it,
     * but is not on sale** — selling one would pin a new merchant to terms that
     * were deliberately withdrawn.
     */
    it('refuses a superseded price', async () => {
      const { service, createCheckout } = build({ price: { isCurrent: false } });

      await expect(service.start({ planPriceId: 'price_row_1' })).rejects.toThrow(
        'That price is no longer offered',
      );

      expect(createCheckout).not.toHaveBeenCalled();
    });

    it('refuses a price that was never created at the provider', async () => {
      const { service } = build({ price: { providerPriceId: null } });

      await expect(service.start({ planPriceId: 'price_row_1' })).rejects.toThrow(
        BadRequestException,
      );
    });

    /** 🔴 G3's guard, at a second call site: a named reason, not a null crash. */
    it('fails with a reason an operator can act on when billing is unconfigured', async () => {
      const { service } = build({ provider: null });

      await expect(service.start({ planPriceId: 'price_row_1' })).rejects.toThrow(
        'No billing provider is configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET absent).',
      );
    });
  });
});
