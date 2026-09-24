import Stripe from 'stripe';

import { SubscriptionStatus } from '../common/database/enums';
import { StripeProvider } from './stripe.provider';

/**
 * The F88 contract, run against the **real adapter** rather than the fake.
 *
 * 🔴 **This is what makes the interface mean anything.** F88 wrote seven
 * contract tests against a `FakeProvider` and recorded why that was not enough:
 * *"an interface with no implementation is a file that compiles and proves
 * nothing … the first real implementation quietly bends it."* These are the
 * same assertions, pointed at `StripeProvider`.
 *
 * ⚠️ **What this CANNOT prove, stated so it is not mistaken for coverage.**
 * There is no Stripe account on this machine and none can be created here, so
 * the SDK is stubbed: this proves the **adapter's own logic** — which options
 * it sends, how it maps a status, that a bad signature yields `null` — and
 * proves nothing about whether Stripe accepts those options.
 *
 * 🔴 **Sandbox verification is OWED.** On receiving a test-mode key the honest
 * first act is to run these same assertions against the real sandbox and record
 * what differs. Until then *"the adapter works"* means *"it satisfies the
 * contract"*, and the two must not be reported as the same thing.
 */
describe('StripeProvider contract', () => {
  /** The calls the adapter made, so its inputs can be asserted. */
  let calls: Array<{ method: string; args: unknown[] }>;

  function stub(overrides: Record<string, unknown> = {}): Stripe {
    const record = (method: string, result: unknown) =>
      (...args: unknown[]) => {
        calls.push({ method, args });

        return Promise.resolve(result);
      };

    return {
      checkout: {
        sessions: {
          create: record('checkout.create', {
            id: 'cs_test_1',
            url: 'https://checkout.stripe.test/cs_test_1',
          }),
        },
      },
      subscriptions: {
        retrieve: record('subscriptions.retrieve', {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          items: {
            data: [{ id: 'si_1', current_period_end: 1_790_000_000, price: { id: 'price_1' } }],
          },
        }),
        update: record('subscriptions.update', {}),
        cancel: record('subscriptions.cancel', {}),
      },
      webhooks: {
        constructEvent: (_body: Buffer, signature: string) => {
          if (signature !== 'good') {
            /*
             * ⚠️ **A plain Error, not `StripeSignatureVerificationError`.** Its
             * declared constructor demands arguments the runtime does not, and
             * the adapter catches **any** throw from `constructEvent` — which is
             * the correct behaviour: a signature that fails for a reason the
             * library has not classified is still a signature that failed.
             */
            throw new Error('bad signature');
          }

          return { id: 'evt_1', type: 'customer.subscription.updated', data: { object: {} } };
        },
      },
      ...overrides,
    } as unknown as Stripe;
  }

  let provider: StripeProvider;

  beforeEach(() => {
    calls = [];
    provider = new StripeProvider(stub(), 'whsec_test');
  });

  const checkoutInput = {
    tenantId: 't-1',
    planPriceId: 'price_1',
    providerCustomerId: null,
    successUrl: 'https://app/ok',
    cancelUrl: 'https://app/no',
  };

  /** 🔴 A checkout is for a PINNED price, never a plan (F88, and `plan_prices`). */
  it('starts a checkout against a plan price, never a plan', async () => {
    await provider.createCheckout(checkoutInput);

    const [options] = calls[0].args as [Record<string, unknown>];

    expect(options.line_items).toEqual([{ price: 'price_1', quantity: 1 }]);
    expect(options).not.toHaveProperty('planId');
  });

  /**
   * 🔴 **ADR-115 in one assertion.** ParseLab is merchant of record, so VAT is
   * ours to collect: without `automatic_tax` Stripe charges the listed figure
   * and no tax, and the liability is still ours.
   */
  it('enables automatic tax and collects what computing it requires', async () => {
    await provider.createCheckout(checkoutInput);

    const [options] = calls[0].args as [Record<string, unknown>];

    expect(options.automatic_tax).toEqual({ enabled: true });
    expect(options.billing_address_collection).toBe('required');
    expect(options.tax_id_collection).toEqual({ enabled: true });
  });

  /**
   * 🔴 **The webhook arrives with no request context**, so the session must
   * carry the tenant — M22.4 takes state from the webhook and never the
   * redirect, and an event that cannot route itself is an orphan.
   */
  it('carries the tenant on the session, for the webhook that has no context', async () => {
    await provider.createCheckout(checkoutInput);

    const [options] = calls[0].args as [Record<string, unknown> & { metadata: unknown }];

    expect(options.client_reference_id).toBe('t-1');
    expect(options.metadata).toMatchObject({ tenantId: 't-1', planPriceId: 'price_1' });
  });

  /**
   * ⚠️ **A returning customer must have their address written back.** Stripe
   * Tax computes from the customer, and ADR-118 collects the address at
   * checkout and nowhere else — so without `customer_update` the *next*
   * invoice has nothing to compute from.
   */
  it('writes the address back for a returning customer', async () => {
    await provider.createCheckout({ ...checkoutInput, providerCustomerId: 'cus_1' });

    const [options] = calls[0].args as [Record<string, unknown>];

    expect(options.customer).toBe('cus_1');
    expect(options.customer_update).toEqual({ address: 'auto' });
  });

  /** The provider's view carries the customer a portal session needs (G7). */
  it('reports the customer alongside the subscription', async () => {
    const remote = await provider.getSubscription('sub_1');

    expect(remote?.providerCustomerId).toBe('cus_1');
    expect(remote?.status).toBe(SubscriptionStatus.ACTIVE);
    expect(remote?.providerPriceId).toBe('price_1');
  });

  /**
   * 🔴 **Seconds to milliseconds.** Stripe sends Unix seconds; a `new Date`
   * over the raw number lands in 1970 and reads as a subscription that expired
   * decades ago — a mistake no type system can see, because both are numbers.
   */
  it('converts the period end from Unix seconds', async () => {
    const remote = await provider.getSubscription('sub_1');

    expect(remote?.currentPeriodEnd?.getUTCFullYear()).toBeGreaterThan(2020);
    expect(remote?.currentPeriodEnd?.getTime()).toBe(1_790_000_000 * 1000);
  });

  /**
   * 📌 **`null`, not a throw, for a subscription Stripe does not have.**
   * Reconciliation walks local rows; a method that threw would end the sweep at
   * the first finding rather than reporting it.
   */
  it('answers null for a subscription the provider does not have', async () => {
    const missing = new StripeProvider(
      stub({
        subscriptions: {
          retrieve: () =>
            Promise.reject(
              Object.assign(new Error('No such subscription'), { code: 'resource_missing' }),
            ),
        },
      }),
      'whsec_test',
    );

    expect(await missing.getSubscription('sub_missing')).toBeNull();
  });

  /**
   * 🔴 **Only `resource_missing` is `null`; every other bad request throws.**
   * `StripeInvalidRequestError` covers a malformed id, an option the pinned API
   * version rejects, a permission problem — and swallowing those as `null`
   * would have reconciliation report *"the provider forgot this subscription"*
   * when the truth is *"we asked wrongly"*. The real bug would never surface.
   */
  it('does not mistake our own bad request for a missing subscription', async () => {
    const rejected = new StripeProvider(
      stub({
        subscriptions: {
          retrieve: () =>
            Promise.reject(
              Object.assign(new Error('Received unknown parameter: nonsense'), {
                code: 'parameter_unknown',
              }),
            ),
        },
      }),
      'whsec_test',
    );

    await expect(rejected.getSubscription('sub_1')).rejects.toThrow(/unknown parameter/);
  });

  /** ADR-116's principle: they paid for the term, so cancelling ends it at its end. */
  it('cancels at period end without ending the term early', async () => {
    await provider.cancelSubscription({ providerSubscriptionId: 'sub_1', atPeriodEnd: true });

    expect(calls[0].method).toBe('subscriptions.update');
    expect(calls[0].args[1]).toEqual({ cancel_at_period_end: true });
  });

  /** ⚠️ Proration is Stripe's; the adapter asks for it and does not compute it. */
  it('lets the provider compute proration on a plan change', async () => {
    await provider.updatePlan({ providerSubscriptionId: 'sub_1', planPriceId: 'price_2' });

    const update = calls.find((c) => c.method === 'subscriptions.update');
    const [, options] = update!.args as [string, Record<string, unknown>];

    expect(options.proration_behavior).toBe('create_prorations');
    expect(options.items).toEqual([{ id: 'si_1', price: 'price_2' }]);
  });

  /**
   * 🔴 **A forged signature is `null`, never an exception and never a parsed
   * event.** The caller must be able to answer 4xx and record nothing; a throw
   * invites a `catch` that logs and continues.
   */
  it('refuses an unverified webhook without throwing', async () => {
    expect(
      await provider.verifyWebhook({ rawBody: Buffer.from('{}'), signature: 'forged' }),
    ).toBeNull();
  });

  /** A verified event carries the id `billing_events.providerEventId` dedupes on. */
  it('gives a verified webhook an id an idempotency key can use', async () => {
    const verified = await provider.verifyWebhook({
      rawBody: Buffer.from('{}'),
      signature: 'good',
    });

    expect(verified?.eventId).toBe('evt_1');
    expect(verified?.type).toBe('customer.subscription.updated');
  });

  /**
   * 🔴 **An unmodelled Stripe state throws rather than guessing.** Stripe's
   * status union is deliberately open — measured: `never` does not compile
   * against its `OtherString` escape hatch — so a future state must not become
   * `active` (granting the product to someone who has not paid) nor `expired`
   * (revoking it from someone who has). The webhook fails, the event stays
   * unprocessed, and Stripe retries.
   */
  it('refuses to map a status it does not model', async () => {
    const exotic = new StripeProvider(
      stub({
        subscriptions: {
          retrieve: () =>
            Promise.resolve({
              id: 'sub_x',
              customer: 'cus_1',
              status: 'something_new',
              items: { data: [] },
            }),
        },
      }),
      'whsec_test',
    );

    await expect(exotic.getSubscription('sub_x')).rejects.toThrow(/Unhandled Stripe/);
  });
});
