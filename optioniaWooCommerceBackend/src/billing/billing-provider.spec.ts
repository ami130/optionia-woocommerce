import { SubscriptionStatus } from '../common/database/enums';
import {
  BILLING_PROVIDER,
  type BillingProvider,
  type ProviderSubscription,
} from './billing-provider';

/**
 * The contract every adapter must satisfy, asserted against a fake.
 *
 * ## Why a fake rather than "we will test the real one later"
 *
 * 🔴 **An interface with no implementation is a file that compiles and proves
 * nothing.** This project has a name for that — *"absent code has nothing to
 * mutate"* — and an abstraction written months before its first adapter is
 * exactly where it happens: the shape looks reasonable, nobody exercises it,
 * and the first real implementation quietly bends it.
 *
 * ⚠️ **This fake is NOT a mock of Stripe.** It is the smallest thing that can
 * honour the contract, which is what makes it useful: if a requirement cannot
 * be met by something this simple, the requirement is wrong. M22.3's Stripe
 * adapter is then written against the same assertions rather than inventing
 * its own.
 *
 * 📌 **What is asserted is the contract's REASONING, not its type signature.**
 * TypeScript already checks the shape. What it cannot check is that
 * `createCheckout` takes a pinned price rather than a plan, that a bad
 * signature yields `null` rather than throwing, or that a verified event
 * carries an id an idempotency key can be built from.
 */
class FakeProvider implements BillingProvider {
  readonly name = 'fake';

  /** What the last call received, so the contract can be asserted on inputs. */
  lastCheckout: Record<string, unknown> | null = null;

  async createCheckout(input: {
    tenantId: string;
    planPriceId: string;
    providerCustomerId: string | null;
    successUrl: string;
    cancelUrl: string;
  }) {
    this.lastCheckout = { ...input };

    return { url: `https://fake/checkout/${input.planPriceId}`, reference: 'ref-1' };
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null> {
    if (providerSubscriptionId !== 'sub-known') {
      return null;
    }

    return {
      providerSubscriptionId,
      providerCustomerId: 'cus-1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      providerPriceId: 'price-1',
    };
  }

  async cancelSubscription(): Promise<void> {}

  async updatePlan(): Promise<void> {}

  async verifyWebhook(input: { rawBody: Buffer; signature: string }) {
    if (input.signature !== 'good') {
      return null;
    }

    return { eventId: 'evt-1', type: 'subscription.updated', payload: {} };
  }
}

describe('BillingProvider contract', () => {
  let provider: FakeProvider;

  beforeEach(() => {
    provider = new FakeProvider();
  });

  /**
   * 🔴 **A checkout is for a PINNED price, not a plan.** Charging `planId`
   * would charge the plan's current figure — re-pricing anyone whose plan was
   * edited between signing up and upgrading, which is the defect `plan_prices`
   * exists to prevent.
   */
  it('starts a checkout against a plan price, never a plan', async () => {
    await provider.createCheckout({
      tenantId: 't-1',
      planPriceId: 'pp-1',
      providerCustomerId: null,
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });

    expect(provider.lastCheckout).toMatchObject({ planPriceId: 'pp-1' });
    expect(provider.lastCheckout).not.toHaveProperty('planId');
  });

  /**
   * ⚠️ **A returning merchant keeps their customer**, so their saved cards and
   * invoice history survive a cancellation. `null` is a first-time buyer, not
   * missing data.
   */
  it('accepts a null customer for a first purchase', async () => {
    const session = await provider.createCheckout({
      tenantId: 't-1',
      planPriceId: 'pp-1',
      providerCustomerId: null,
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    });

    expect(session.url).toContain('pp-1');
    expect(session.reference).toBeTruthy();
  });

  /**
   * 📌 **An unknown subscription is `null`, not a throw.** Reconciliation
   * (M23.5) walks local rows and asks the provider about each; a subscription
   * the provider has forgotten is a **finding**, and a method that threw would
   * end the sweep at the first one.
   */
  it('answers null for a subscription the provider does not have', async () => {
    expect(await provider.getSubscription('sub-missing')).toBeNull();
    expect(await provider.getSubscription('sub-known')).not.toBeNull();
  });

  /** The provider's view carries the customer, which a portal session needs (G7). */
  it('reports the customer alongside the subscription', async () => {
    const remote = await provider.getSubscription('sub-known');

    expect(remote?.providerCustomerId).toBe('cus-1');
    expect(remote?.status).toBe(SubscriptionStatus.ACTIVE);
  });

  /**
   * 🔴 **A bad signature is `null`, never an exception and never a parsed
   * event.** An unverified webhook is an attacker's message: the caller must be
   * able to answer 4xx and record nothing, and a thrown error invites a `catch`
   * that logs and continues.
   */
  it('refuses an unverified webhook without throwing', async () => {
    const refused = await provider.verifyWebhook({
      rawBody: Buffer.from('{}'),
      signature: 'forged',
    });

    expect(refused).toBeNull();
  });

  /**
   * 🔴 **A verified event carries an id.** Providers retry; Phase 23 makes
   * delivery idempotent through `billing_events.provider_event_id`, which is
   * `UNIQUE`. An adapter that cannot supply a stable id cannot be made
   * idempotent downstream by any amount of care.
   */
  it('gives a verified webhook an id an idempotency key can use', async () => {
    const verified = await provider.verifyWebhook({
      rawBody: Buffer.from('{}'),
      signature: 'good',
    });

    expect(verified?.eventId).toBe('evt-1');
    expect(verified?.type).toBeTruthy();
  });

  /** The token exists so a module binds an implementation without importing it. */
  it('exposes an injection token', () => {
    expect(typeof BILLING_PROVIDER).toBe('symbol');
  });
});
