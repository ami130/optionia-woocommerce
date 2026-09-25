import { DataSource } from 'typeorm';

/* 🔴 See BillingModule: a default import of `stripe` is `undefined` at runtime. */
import Stripe = require('stripe');

import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Plan } from '../plans/entities/plan.entity';
import { findUnsellablePrices, reconcileProviderPrices } from './provider-prices';

/**
 * Reconciling our prices with the provider's (M22.L1/L2).
 *
 * 🔴 **Every test here is about money being wrong quietly.** A missing link
 * makes a plan unbuyable; a drifting one charges a figure the pricing page never
 * showed. Both fail with no error anywhere until a merchant hits them, which is
 * why the reconciler refuses rather than repairs.
 */
describe('reconcileProviderPrices', () => {
  const plan = { id: 'plan_pro', code: 'pro', name: 'Pro' } as Plan;

  function priceRow(over: Partial<PlanPrice> = {}): PlanPrice {
    return {
      id: 'row_1',
      planId: plan.id,
      plan,
      currency: 'USD',
      interval: 'month',
      amountMinor: 2900,
      providerPriceId: null,
      isCurrent: true,
      ...over,
    } as PlanPrice;
  }

  function remotePrice(over: Partial<Stripe.Price> = {}): Stripe.Price {
    return {
      id: 'price_remote',
      active: true,
      unit_amount: 2900,
      currency: 'usd',
      recurring: { interval: 'month' },
      ...over,
    } as Stripe.Price;
  }

  function build(seed: {
    rows: PlanPrice[];
    products?: Stripe.Product[];
    prices?: Stripe.Price[];
    retrieve?: Stripe.Price | null;
  }) {
    const updates: Array<{ id: unknown; providerPriceId: unknown }> = [];

    const dataSource = {
      getRepository: () => ({
        find: async () => seed.rows,
        update: async (where: { id: string }, set: { providerPriceId: string }) => {
          updates.push({ id: where.id, providerPriceId: set.providerPriceId });
          return { affected: 1 };
        },
      }),
    } as unknown as DataSource;

    const created: Array<Record<string, unknown>> = [];

    const stripe = {
      products: {
        search: async () => ({ data: seed.products ?? [] }),
        create: async (params: Record<string, unknown>) => {
          created.push({ kind: 'product', ...params });
          return { id: 'prod_new' } as Stripe.Product;
        },
      },
      prices: {
        list: async () => ({ data: seed.prices ?? [] }),
        retrieve: async () => {
          if (seed.retrieve === null) {
            throw new Error('No such price');
          }

          return seed.retrieve ?? remotePrice();
        },
        create: async (params: Record<string, unknown>) => {
          created.push({ kind: 'price', ...params });
          return { id: 'price_new' } as Stripe.Price;
        },
      },
    } as unknown as Stripe;

    return { dataSource, stripe, updates, created };
  }

  const testMode = { dryRun: false, create: true, live: false };

  describe('an existing link', () => {
    it('is left alone when the provider agrees', async () => {
      const { dataSource, stripe, updates } = build({
        rows: [priceRow({ providerPriceId: 'price_remote' })],
        retrieve: remotePrice(),
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome.unchanged).toEqual(['pro month USD']);
      expect(outcome.problems).toEqual([]);
      expect(updates).toHaveLength(0);
    });

    /**
     * 🔴 **K2, the finding this exists for.** Checkout sends a price id and
     * never checks what it costs, so a dashboard edit would charge a figure our
     * UI never showed — silently.
     */
    it('is reported, not silently accepted, when the amount drifts', async () => {
      const { dataSource, stripe } = build({
        rows: [priceRow({ providerPriceId: 'price_remote' })],
        retrieve: remotePrice({ unit_amount: 3900 }),
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome.problems).toEqual([
        'pro month USD: amount 3900 at provider vs 2900 locally',
      ]);
      expect(outcome.unchanged).toEqual([]);
    });

    it.each([
      ['currency', { currency: 'eur' }, 'pro month USD: currency EUR at provider vs USD locally'],
      [
        'interval',
        { recurring: { interval: 'year' } as Stripe.Price.Recurring },
        'pro month USD: interval year at provider vs month locally',
      ],
      ['active state', { active: false }, 'pro month USD: the provider price is archived'],
    ])('is reported when the %s disagrees', async (_label, over, expected) => {
      const { dataSource, stripe } = build({
        rows: [priceRow({ providerPriceId: 'price_remote' })],
        retrieve: remotePrice(over),
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome.problems).toEqual([expected]);
    });

    /** ⚠️ An id pointing at nothing is a problem, not a reason to relink blindly. */
    it('is reported when the provider has never heard of the id', async () => {
      const { dataSource, stripe, updates } = build({
        rows: [priceRow({ providerPriceId: 'price_gone' })],
        retrieve: null,
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome.problems).toEqual([
        'pro month USD: price_gone does not exist at the provider',
      ]);
      expect(updates).toHaveLength(0);
    });
  });

  describe('a missing link', () => {
    /**
     * 🔴 **K1's core property: relinking must find, not duplicate.** Wiping the
     * column and re-running has to reach the same provider price, or every run
     * leaves another orphan behind.
     */
    it('adopts a matching provider price rather than creating another', async () => {
      const { dataSource, stripe, updates, created } = build({
        rows: [priceRow()],
        products: [{ id: 'prod_pro' } as Stripe.Product],
        prices: [remotePrice({ id: 'price_existing' })],
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome.linked).toEqual(['pro month USD -> price_existing']);
      expect(updates).toEqual([{ id: 'row_1', providerPriceId: 'price_existing' }]);
      expect(created).toHaveLength(0);
    });

    it('creates one when nothing at the provider matches', async () => {
      const { dataSource, stripe, updates, created } = build({
        rows: [priceRow()],
        products: [{ id: 'prod_pro' } as Stripe.Product],
        prices: [remotePrice({ id: 'price_wrong', unit_amount: 9999 })],
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome.created).toEqual(['pro month USD -> price_new']);
      expect(updates).toEqual([{ id: 'row_1', providerPriceId: 'price_new' }]);

      /* 🔴 ADR-115: tax-exclusive, because ParseLab is merchant of record. */
      expect(created[0]).toMatchObject({
        kind: 'price',
        unit_amount: 2900,
        currency: 'usd',
        tax_behavior: 'exclusive',
      });
    });

    /** ⚠️ Matched on metadata, so a renamed product is still found. */
    it('creates the product with a plan_code and a SaaS tax code', async () => {
      const { dataSource, stripe, created } = build({ rows: [priceRow()], products: [] });

      await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(created[0]).toMatchObject({
        kind: 'product',
        metadata: { plan_code: 'pro' },
        tax_code: 'txcd_10103001',
      });
    });

    /** 🔴 Two products claiming one plan is ambiguous; guessing would be worse. */
    it('refuses when two provider products claim the same plan', async () => {
      const { dataSource, stripe, created } = build({
        rows: [priceRow()],
        products: [{ id: 'prod_a' } as Stripe.Product, { id: 'prod_b' } as Stripe.Product],
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome.problems[0]).toContain('2 provider products claim this plan');
      expect(created).toHaveLength(0);
    });
  });

  describe('safety', () => {
    /**
     * 📌 **A duplicate product in live is a support problem, not a rollback**,
     * so live links only what already exists unless creation is forced.
     */
    it('refuses to create a product in live mode', async () => {
      const { dataSource, stripe, created } = build({ rows: [priceRow()], products: [] });

      const outcome = await reconcileProviderPrices(dataSource, stripe, {
        dryRun: false,
        create: false,
        live: true,
      });

      expect(outcome.problems[0]).toContain('no provider product, and creating is disabled');
      expect(created).toHaveLength(0);
    });

    /**
     * 🔴 **The price guard, separately — asserting the message alone was not
     * enough.** A mutation disabling only the *product* guard left this green,
     * because the flow then stopped at the price guard and produced a
     * near-identical message. Giving the product a value forces the run past the
     * first guard so the second is the one under test.
     */
    it('refuses to create a price in live mode even when the product exists', async () => {
      const { dataSource, stripe, created, updates } = build({
        rows: [priceRow()],
        products: [{ id: 'prod_pro' } as Stripe.Product],
        prices: [],
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, {
        dryRun: false,
        create: false,
        live: true,
      });

      expect(outcome.problems[0]).toContain('no matching provider price, and creating is disabled');
      expect(created).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });

    it('writes nothing on a dry run', async () => {
      const { dataSource, stripe, updates, created } = build({
        rows: [priceRow()],
        products: [{ id: 'prod_pro' } as Stripe.Product],
        prices: [],
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, {
        dryRun: true,
        create: true,
        live: false,
      });

      expect(outcome.created).toEqual(['pro month USD (dry run)']);
      expect(updates).toHaveLength(0);
      expect(created).toHaveLength(0);
    });

    /**
     * 🔴 **A free price is never sold and must never be created.** A $0
     * recurring price would make a free plan look purchasable, and a merchant
     * who "bought" it would hold a provider subscription billing forever at
     * zero — a permanent reconciliation anomaly.
     */
    it('skips a free price entirely', async () => {
      const { dataSource, stripe, updates, created } = build({
        rows: [priceRow({ amountMinor: 0 })],
        products: [],
      });

      const outcome = await reconcileProviderPrices(dataSource, stripe, testMode);

      expect(outcome).toEqual({ linked: [], created: [], unchanged: [], problems: [] });
      expect(updates).toHaveLength(0);
      expect(created).toHaveLength(0);
    });
  });
});

/**
 * L3/K3 — the check that says a plan cannot be bought before a merchant does.
 */
describe('findUnsellablePrices', () => {
  function build(rows: Partial<PlanPrice>[]) {
    return {
      getRepository: () => ({ find: async () => rows }),
    } as unknown as DataSource;
  }

  it('names a current paid price with no provider link', async () => {
    const dataSource = build([
      {
        planId: 'plan_pro',
        plan: { code: 'pro' } as Plan,
        interval: 'month',
        currency: 'USD',
        amountMinor: 2900,
        providerPriceId: null,
      },
    ]);

    await expect(findUnsellablePrices(dataSource)).resolves.toEqual(['pro month USD']);
  });

  /** ⚠️ A free plan has no provider price by design and is not a problem. */
  it('ignores a free price', async () => {
    const dataSource = build([
      {
        planId: 'plan_free',
        plan: { code: 'free' } as Plan,
        interval: 'month',
        currency: 'USD',
        amountMinor: 0,
        providerPriceId: null,
      },
    ]);

    await expect(findUnsellablePrices(dataSource)).resolves.toEqual([]);
  });
});
