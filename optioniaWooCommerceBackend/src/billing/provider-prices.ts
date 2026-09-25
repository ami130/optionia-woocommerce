import { DataSource, IsNull } from 'typeorm';

/* 🔴 See BillingModule: a default import of `stripe` is `undefined` at runtime. */
import Stripe = require('stripe');

import { Plan } from '../plans/entities/plan.entity';
import { PlanPrice } from '../plans/entities/plan-price.entity';

/**
 * Reconciling `plan_prices` with the provider's own prices (M22.L1/L2).
 *
 * ## Why this exists
 *
 * 🔴 **The links were typed by hand and existed nowhere but one terminal.**
 * `plan_prices.providerPriceId` was populated with manual SQL during sandbox
 * verification (K1). The seed never sets it, so a fresh database — CI, a new
 * machine, live mode — has `NULL` in every row, which is exactly the state that
 * makes checkout refuse to sell. The first person to discover a plan cannot be
 * bought would have been a merchant trying to buy it.
 *
 * ## Why it verifies rather than trusts
 *
 * ⚠️ **Nothing compared our amount against the provider's (K2).** Checkout
 * sends a price id and never checks what that price actually costs, so an edit
 * in the Stripe dashboard would leave the pricing page showing $29 while the
 * merchant is charged something else — silently, with no error anywhere. Every
 * link here is checked on amount, currency, interval and active state, and a
 * disagreement **refuses to link** rather than papering over it.
 *
 * ## Why creating is allowed in test and not in live
 *
 * 📌 **A duplicate product in live mode is a support problem, not a rollback.**
 * In test, creating what is missing makes the script a one-command setup. In
 * live, the same convenience would let a typo silently create a second
 * "Optionia Pro" that some merchants then subscribe to. Live links only what
 * already exists unless the caller explicitly forces creation.
 */
export interface ReconcileOptions {
  /** Report what would change and write nothing. */
  readonly dryRun: boolean;

  /**
   * Create missing products and prices at the provider.
   *
   * ⚠️ Defaults to true in test mode and **false in live**, per the rule above.
   */
  readonly create: boolean;

  /** True when the key is a live key, which tightens every default. */
  readonly live: boolean;
}

export interface ReconcileOutcome {
  readonly linked: string[];
  readonly created: string[];
  readonly unchanged: string[];
  readonly problems: string[];
}

/** How a plan price is described in messages: `pro month USD`. */
function describe(plan: Plan, price: PlanPrice): string {
  return `${plan.code} ${price.interval} ${price.currency}`;
}

/**
 * 🔴 **A free price is never sold through checkout**, so it needs no provider
 * price and must not be created at one. Creating a $0 recurring price would
 * make a plan that costs nothing look purchasable, and a merchant who "bought"
 * it would hold a provider subscription that bills forever at zero — harmless
 * to them, and a permanent reconciliation anomaly for us.
 */
function isSellable(price: PlanPrice): boolean {
  return price.amountMinor > 0;
}

/**
 * Find the provider product for a plan, or create it.
 *
 * ⚠️ **Matched on metadata, not on name.** A product named "Optionia Pro" is a
 * label someone may edit in the dashboard; `metadata.plan_code` is the identity
 * this system actually relies on, and matching on the display name would create
 * a duplicate the moment anyone renamed it.
 */
async function findOrCreateProduct(
  stripe: Stripe,
  plan: Plan,
  options: ReconcileOptions,
  outcome: ReconcileOutcome,
): Promise<string | null> {
  const search = await stripe.products.search({
    query: `active:'true' AND metadata['plan_code']:'${plan.code}'`,
    limit: 2,
  });

  if (search.data.length > 1) {
    outcome.problems.push(
      `plan ${plan.code}: ${search.data.length} provider products claim this plan ` +
        `(${search.data.map((p) => p.id).join(', ')}) — resolve by hand, not here`,
    );

    return null;
  }

  if (search.data.length === 1) {
    return search.data[0].id;
  }

  /*
   * 📌 **Defence in depth, and NOT the load-bearing guard — measured.** A
   * mutation removing this check created nothing in live mode, because the
   * price guard below stops the flow regardless. It earns its place by naming
   * the *product* as what is missing, which is a clearer thing to act on than
   * "no matching price"; it does not earn the reader's trust as the safety.
   */
  if (!options.create) {
    outcome.problems.push(
      `plan ${plan.code}: no provider product, and creating is disabled ` +
        `(${options.live ? 'live mode' : '--no-create'})`,
    );

    return null;
  }

  if (options.dryRun) {
    outcome.created.push(`product for ${plan.code} (dry run)`);

    return null;
  }

  const product = await stripe.products.create({
    name: `Optionia ${plan.name}`,
    metadata: { plan_code: plan.code },

    /*
     * 🔴 **The tax code is part of the product, not an account default.** A
     * global default would be inherited by any future product that is taxed
     * differently — `txcd_10103001` is "SaaS, business use", which is what this
     * is and may not be what the next thing is.
     */
    tax_code: 'txcd_10103001',
  });

  outcome.created.push(`product ${product.id} for ${plan.code}`);

  return product.id;
}

/**
 * Check a provider price says the same thing our row does.
 *
 * 🔴 **This is K2's guard.** Returning a reason rather than a boolean means the
 * refusal names both figures, so whoever reads it knows which side to change.
 */
function disagreement(price: PlanPrice, remote: Stripe.Price): string | null {
  if (remote.unit_amount !== price.amountMinor) {
    return `amount ${remote.unit_amount} at provider vs ${price.amountMinor} locally`;
  }

  if (remote.currency.toUpperCase() !== price.currency.toUpperCase()) {
    return `currency ${remote.currency.toUpperCase()} at provider vs ${price.currency} locally`;
  }

  if (remote.recurring?.interval !== price.interval) {
    return `interval ${remote.recurring?.interval ?? 'one-time'} at provider vs ${price.interval} locally`;
  }

  if (!remote.active) {
    return 'the provider price is archived';
  }

  return null;
}

/**
 * Reconcile every current, sellable plan price with the provider.
 *
 * Idempotent: a second run reports everything unchanged.
 */
export async function reconcileProviderPrices(
  dataSource: DataSource,
  stripe: Stripe,
  options: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = {
    linked: [],
    created: [],
    unchanged: [],
    problems: [],
  };

  const prices = await dataSource.getRepository(PlanPrice).find({
    where: { isCurrent: true },
    relations: { plan: true },
  });

  for (const price of prices) {
    const plan = price.plan;

    if (plan === null || plan === undefined) {
      outcome.problems.push(`price ${price.id}: no plan — orphaned row`);
      continue;
    }

    if (!isSellable(price)) {
      continue;
    }

    const label = describe(plan, price);

    /*
     * ⚠️ **An existing link is verified, never assumed.** This is the case that
     * matters most in live: the id is right, and the price behind it has since
     * been edited.
     */
    if (price.providerPriceId !== null) {
      const remote = await stripe.prices.retrieve(price.providerPriceId).catch(() => null);

      if (remote === null) {
        outcome.problems.push(`${label}: ${price.providerPriceId} does not exist at the provider`);
        continue;
      }

      const reason = disagreement(price, remote);

      if (reason !== null) {
        outcome.problems.push(`${label}: ${reason}`);
        continue;
      }

      outcome.unchanged.push(label);
      continue;
    }

    const productId = await findOrCreateProduct(stripe, plan, options, outcome);

    if (productId === null) {
      continue;
    }

    /*
     * 📌 Look for a price that already matches before creating one. Re-running
     * after a failed write must not leave a trail of duplicate prices.
     */
    const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });

    const match = existing.data.find((remote) => disagreement(price, remote) === null);

    if (match !== undefined) {
      if (!options.dryRun) {
        await dataSource
          .getRepository(PlanPrice)
          .update({ id: price.id }, { providerPriceId: match.id });
      }

      outcome.linked.push(`${label} -> ${match.id}`);
      continue;
    }

    /*
     * 🔴 **This is the guard that actually protects a live account.** Verified
     * by mutation: with the product check above removed, a live run still
     * creates nothing, and with this one removed it creates a price.
     */
    if (!options.create) {
      outcome.problems.push(
        `${label}: no matching provider price, and creating is disabled ` +
          `(${options.live ? 'live mode' : '--no-create'})`,
      );
      continue;
    }

    if (options.dryRun) {
      outcome.created.push(`${label} (dry run)`);
      continue;
    }

    const created = await stripe.prices.create({
      product: productId,
      unit_amount: price.amountMinor,
      currency: price.currency.toLowerCase(),
      recurring: { interval: price.interval as Stripe.PriceCreateParams.Recurring.Interval },

      /* 🔴 ADR-115: prices are tax-EXCLUSIVE. ParseLab is merchant of record. */
      tax_behavior: 'exclusive',
      metadata: { plan_code: plan.code },
    });

    await dataSource
      .getRepository(PlanPrice)
      .update({ id: price.id }, { providerPriceId: created.id });

    outcome.created.push(`${label} -> ${created.id}`);
  }

  return outcome;
}

/**
 * Prices that cannot be sold, for a startup check (L3/K3).
 *
 * ⚠️ **The failure this catches is silent until a merchant hits it.** Checkout
 * answers 400 for a price with no provider id, which is correct — but the first
 * person to learn a plan is unbuyable should not be the customer trying to buy
 * it.
 */
export async function findUnsellablePrices(dataSource: DataSource): Promise<string[]> {
  const prices = await dataSource.getRepository(PlanPrice).find({
    where: { isCurrent: true, providerPriceId: IsNull() },
    relations: { plan: true },
  });

  return prices
    .filter(isSellable)
    .map((price) => `${price.plan?.code ?? price.planId} ${price.interval} ${price.currency}`);
}
