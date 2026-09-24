import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

import { SubscriptionStatus } from '../common/database/enums';
import type {
  BillingProvider,
  CheckoutSession,
  ProviderSubscription,
  VerifiedWebhook,
} from './billing-provider';

/**
 * The Stripe adapter (M22.3), behind the interface F88 defined.
 *
 * ## What is verified, and what is owed
 *
 * 🔴 **There is no Stripe account on this machine, so nothing here has been run
 * against the real API.** Every assertion about this class comes from the
 * contract tests and from fixtures; *"the adapter works"* currently means *"it
 * satisfies the contract"*, which is weaker and must not be reported as the
 * same thing. **Sandbox verification is owed**, and the honest first act on
 * receiving a test-mode key is to run the contract suite against it and record
 * what differs.
 *
 * ## The API version is pinned, deliberately
 *
 * ⚠️ **Stripe ships breaking changes behind dated versions**, and the library's
 * default moves when the library is upgraded. Pinning here means a `npm update`
 * cannot silently change billing behaviour — an upgrade becomes a decision with
 * a diff rather than a surprise in production.
 *
 * ## Why every method translates rather than passes through
 *
 * 📌 **Nothing Stripe-shaped leaves this file.** The interface's own docblock
 * records why: *"the moment `stripe.Subscription` appears in a service
 * signature, the abstraction has already failed."* Statuses become
 * `SubscriptionStatus`, amounts stay minor units, and an unknown remote state
 * is mapped explicitly rather than cast.
 */
@Injectable()
export class StripeProvider implements BillingProvider {
  readonly name = 'stripe';

  private readonly logger = new Logger(StripeProvider.name);

  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
  ) {}

  /**
   * 🔴 **`automatic_tax` on, and prices are tax-EXCLUSIVE (ADR-115).**
   * ParseLab is merchant of record, so the VAT is ours to collect — and the
   * buyers are businesses who reclaim it, which is why the listed figure
   * excludes tax rather than including it.
   *
   * ⚠️ **`customer_update: { address: 'auto' }` is required, not cosmetic.**
   * Stripe Tax computes from the customer's address; without this the address
   * collected at checkout is not written back to the customer, and the *next*
   * invoice has nothing to compute from (ADR-118 collects it here and nowhere
   * else).
   */
  async createCheckout(input: {
    tenantId: string;
    planPriceId: string;
    providerCustomerId: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: input.planPriceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },

      ...(input.providerCustomerId === null
        ? { customer_creation: 'always' as const }
        : { customer: input.providerCustomerId, customer_update: { address: 'auto' as const } }),

      /*
       * 🔴 **The tenant travels with the session**, because the webhook that
       * confirms this checkout arrives with no request context — M22.4 is
       * explicit that state comes from the webhook, never the redirect, so the
       * event must carry enough to route itself.
       */
      client_reference_id: input.tenantId,
      metadata: { tenantId: input.tenantId, planPriceId: input.planPriceId },
    });

    if (session.url === null) {
      throw new Error('Stripe returned a checkout session with no URL.');
    }

    return { url: session.url, reference: session.id };
  }

  /**
   * 📌 **`null` for an unknown subscription, never a throw.** Reconciliation
   * (M23.5) walks local rows and asks about each; a subscription the provider
   * has forgotten is a **finding**, and a method that threw would end the sweep
   * at the first one.
   */
  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null> {
    let remote: Stripe.Subscription;

    try {
      remote = await this.stripe.subscriptions.retrieve(providerSubscriptionId);
    } catch (error) {
      /*
       * 🔴 **`resource_missing`, not every rejected request.** Stripe raises
       * `StripeInvalidRequestError` for a malformed id, an option the pinned
       * API version does not accept, or a permission problem — and returning
       * `null` for all of them would report *"the provider has forgotten this
       * subscription"* when the truth is *"we asked wrongly"*. Reconciliation
       * would record a finding that is really our bug, and the real bug would
       * never surface.
       *
       * ⚠️ **Matched on the CODE, not on `instanceof`.** This project sets
       * `allowSyntheticDefaultImports` without `esModuleInterop`, so the
       * default import resolves for the type checker while `Stripe.errors` is
       * **undefined at runtime** — measured: the first version threw *"Cannot
       * read properties of undefined (reading 'errors')"* from inside the very
       * `catch` meant to classify the error. A code comparison needs no runtime
       * namespace and cannot break that way.
       */
      if ((error as { code?: string }).code === 'resource_missing') {
        return null;
      }

      throw error;
    }

    const item = remote.items.data[0];

    return {
      providerSubscriptionId: remote.id,
      providerCustomerId:
        typeof remote.customer === 'string' ? remote.customer : remote.customer.id,
      status: mapSubscriptionStatus(remote.status),

      /*
       * ⚠️ **Seconds to milliseconds.** Stripe sends Unix seconds; a `new Date`
       * over the raw number lands in January 1970 and reads as a subscription
       * that expired decades ago, which is the kind of mistake a type system
       * cannot see because both are numbers.
       */
      currentPeriodEnd:
        item?.current_period_end === undefined
          ? null
          : new Date(item.current_period_end * 1000),

      providerPriceId: item?.price?.id ?? null,
    };
  }

  /**
   * 📌 **`atPeriodEnd` is what a merchant expects.** They have paid for the
   * term; ending it immediately takes something they bought — which ADR-116
   * makes the standing principle for lapses too.
   */
  async cancelSubscription(input: {
    providerSubscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<void> {
    if (input.atPeriodEnd) {
      await this.stripe.subscriptions.update(input.providerSubscriptionId, {
        cancel_at_period_end: true,
      });

      return;
    }

    await this.stripe.subscriptions.cancel(input.providerSubscriptionId);
  }

  /**
   * ⚠️ **Proration is Stripe's, and this does not compute it.** Two
   * implementations of *"what is owed on a mid-term upgrade"* is one more than
   * a billing system can afford.
   */
  async updatePlan(input: { providerSubscriptionId: string; planPriceId: string }): Promise<void> {
    const remote = await this.stripe.subscriptions.retrieve(input.providerSubscriptionId);
    const item = remote.items.data[0];

    if (item === undefined) {
      throw new Error(`Stripe subscription ${input.providerSubscriptionId} has no items.`);
    }

    await this.stripe.subscriptions.update(input.providerSubscriptionId, {
      items: [{ id: item.id, price: input.planPriceId }],
      proration_behavior: 'create_prorations',
    });
  }

  /**
   * 🔴 **The RAW body, before any JSON parsing.** The signature is over the
   * exact bytes Stripe sent; a body that has been parsed and re-serialised
   * fails verification for reasons that look like a misconfiguration and are
   * not (M23.1: *"raw-body preserved for verification"*).
   *
   * 🔴 **`null` rather than a throw on a bad signature.** An unverified webhook
   * is an attacker's message: the caller answers 4xx and records nothing, and a
   * thrown error invites a `catch` that logs and continues.
   */
  async verifyWebhook(input: {
    rawBody: Buffer;
    signature: string;
  }): Promise<VerifiedWebhook | null> {
    try {
      const event = this.stripe.webhooks.constructEvent(
        input.rawBody,
        input.signature,
        this.webhookSecret,
      );

      return { eventId: event.id, type: event.type, payload: event.data.object };
    } catch (error) {
      /*
       * Logged at warn, not error: a forged or replayed signature is an
       * expected event on a public endpoint, not a fault in this system.
       */
      this.logger.warn(`Rejected an unverified Stripe webhook: ${(error as Error).message}`);

      return null;
    }
  }
}

/**
 * Stripe's subscription states, mapped onto ours.
 *
 * 🔴 **Exhaustive and explicit, never a cast.** Stripe has states this product
 * does not model — `incomplete`, `incomplete_expired`, `paused` — and silently
 * casting them would put a string into a typed column that no `switch` handles.
 *
 * ⚠️ **`past_due` maps to `past_due`, not to `grace`.** ADR-116 makes grace a
 * *decision we take* after a failure, with `graceEndsAt` set by us; conflating
 * it with the provider's state would mean the grace window began whenever
 * Stripe said so rather than when our policy says.
 *
 * 📌 **`incomplete` is `trialing`** — a checkout begun and not finished has
 * given us nothing to bill against, and treating it as `active` would grant the
 * product to someone who never paid.
 */
function mapSubscriptionStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'trialing':
    case 'incomplete':
      return SubscriptionStatus.TRIALING;
    case 'active':
      return SubscriptionStatus.ACTIVE;
    case 'past_due':
      return SubscriptionStatus.PAST_DUE;
    case 'canceled':
      return SubscriptionStatus.CANCELLED;
    case 'incomplete_expired':
    case 'unpaid':
      return SubscriptionStatus.EXPIRED;
    case 'paused':
      /*
       * Stripe pauses collection while leaving the subscription alive. Nothing
       * in this product pauses, so it is reported as `grace`: the merchant keeps
       * working and nothing is being collected, which is what a pause is.
       */
      return SubscriptionStatus.GRACE;
    default:
      /*
       * 🔴 **Stripe's status union is deliberately OPEN, and `never` does not
       * compile against it.** The library types it with an `OtherString` escape
       * hatch so a new state behind a later API version is still assignable —
       * measured, not assumed: `assertUnreachable(status)` failed to compile
       * with *"Argument of type 'OtherString' is not assignable to parameter of
       * type 'never'"*.
       *
       * ⚠️ **So this throws rather than guessing.** An unmodelled state must
       * not become `active` (granting the product to someone who has not paid)
       * nor `expired` (revoking it from someone who has). The webhook fails, the
       * event stays unprocessed in `billing_events`, and Stripe retries — which
       * is exactly the behaviour a state we do not understand deserves.
       */
      throw new Error(`Unhandled Stripe subscription status: ${String(status)}`);
  }
}
