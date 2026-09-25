import type { SubscriptionStatus } from '../common/database/enums';

/**
 * What a billing provider must do, so the choice of provider stays reversible.
 *
 * ## Why an interface at all
 *
 * 🔴 **ADR-114 chose Stripe, and the plan still asks for this** — *"so D1 is
 * reversible"*. A decision recorded once is not a decision that cannot change:
 * B6 (tax) is open, and one of its answers is a merchant-of-record service,
 * which **reopens the provider question entirely**. An interface written now
 * costs one file; retrofitting one across a live billing integration costs a
 * migration and a reconciliation.
 *
 * ⚠️ **This is deliberately NOT a Stripe wrapper with the names changed.** Every
 * type here is the project's own: `SubscriptionStatus` is the enum the database
 * already stores, and amounts are minor units through the same convention as
 * every other money value in this schema. A provider adapter's job is to
 * translate into these, not to leak its own vocabulary upward — because the
 * moment `stripe.Subscription` appears in a service signature, the abstraction
 * has already failed.
 *
 * ## What is deliberately absent
 *
 * 📌 **No `chargeNow`, no `refund`, no invoice mutation.** Phase 22's exit is
 * *"a merchant subscribes, upgrades, downgrades, and cancels"*; anything beyond
 * that is a method nobody calls, and an unused method on an interface is a
 * promise the adapter has to keep for no one.
 *
 * 🔴 **No method returns a browser redirect result.** M22.4 is explicit:
 * `subscriptions` is updated **only** from verified webhooks, never from a
 * redirect — a customer who closes the tab after paying must still end up
 * subscribed, and a customer who forges a return URL must not.
 */

/** Minor units, as every money value in this schema is. */
export type MinorUnits = number;

/**
 * Where to send a merchant to pay, and the reference that will come back.
 *
 * ⚠️ **`reference` is not the subscription id.** Checkout completes
 * asynchronously: the subscription exists when the provider says so, on a
 * webhook, not when the merchant's browser returns. This is the handle that
 * links the two.
 */
export interface CheckoutSession {
  url: string;
  reference: string;
}

/**
 * A subscription as the **provider** currently sees it.
 *
 * 📌 **Read, never written from here.** This is what reconciliation compares
 * local state against (M23.5); the local row is authoritative for what the
 * product does, and the provider is authoritative for what was charged.
 */
export interface ProviderSubscription {
  providerSubscriptionId: string;
  providerCustomerId: string;
  status: SubscriptionStatus;

  /** Null while trialling, or once cancelled with nothing further due. */
  currentPeriodEnd: Date | null;

  /** The provider's id for the price actually being charged. */
  providerPriceId: string | null;
}

/**
 * The outcome of verifying an inbound webhook.
 *
 * 🔴 **`eventId` is the whole point.** Providers retry, and a duplicate must be
 * a no-op — Phase 23's `billing_events.provider_event_id` is `UNIQUE` for
 * exactly this. An adapter that cannot supply a stable event id cannot be made
 * idempotent by any amount of care downstream.
 */
export interface VerifiedWebhook {
  eventId: string;
  type: string;
  payload: unknown;
}

export interface BillingProvider {
  /** A stable name, stored on `subscriptions.provider`. */
  readonly name: string;

  /**
   * Start a checkout for a tenant against one **pinned** price.
   *
   * ⚠️ Takes `planPriceId`, not `planId`: what a merchant is charged is the
   * immutable price row they bought, never the plan's current figure.
   */
  createCheckout(input: {
    tenantId: string;
    planPriceId: string;
    providerCustomerId: string | null;
    successUrl: string;
    cancelUrl: string;

    /**
     * When the merchant's existing trial ends, if it has not (M22.3).
     *
     * 🔴 **The REMAINING trial, not a fresh one.** A merchant ten days into a
     * fourteen-day trial who upgrades must keep their four days — charging them
     * today takes something they were promised, and granting fourteen more
     * gives away a fortnight to anyone who upgrades early.
     *
     * ⚠️ `null` when the trial has already ended, which is the ordinary case
     * for an upgrade later in the life of an account.
     */
    trialEndsAt: Date | null;
  }): Promise<CheckoutSession>;

  /**
   * A session at the provider's own billing portal (M22.3, M22.5).
   *
   * 🔴 **Payment method management is the provider's surface, deliberately.**
   * Collecting card details ourselves would put this service in PCI scope for
   * no benefit a merchant can see — the portal also carries invoice history,
   * tax ids and cancellation, all of which the provider must agree with anyway.
   *
   * 📌 Returns a URL only. The portal is stateful at the provider and nothing
   * about it is ours to record.
   */
  createPortalSession(input: {
    providerCustomerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription | null>;

  /**
   * Cancel, either now or at the period's end.
   *
   * 📌 **`atPeriodEnd` is the default a merchant expects**: they have paid for
   * the term, and ending it immediately would be taking something they bought.
   */
  cancelSubscription(input: {
    providerSubscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<void>;

  /**
   * Move a subscription to a different pinned price.
   *
   * ⚠️ **Proration is the provider's, and the caller does not compute it.** Two
   * implementations of "what is owed on a mid-term upgrade" is one more than a
   * billing system can afford.
   */
  updatePlan(input: {
    providerSubscriptionId: string;
    planPriceId: string;
  }): Promise<void>;

  /**
   * Verify a raw webhook body and signature.
   *
   * 🔴 **The RAW body, before any JSON parsing.** Signature verification is over
   * the exact bytes sent; a body that has been parsed and re-serialised will
   * fail verification for reasons that look like a configuration error and are
   * not. M23.1 names this: *"raw-body preserved for verification"*.
   *
   * Returns `null` when the signature does not verify — a caller must answer
   * 4xx and record nothing, because an unverified webhook is an attacker's
   * message.
   */
  verifyWebhook(input: { rawBody: Buffer; signature: string }): Promise<VerifiedWebhook | null>;
}

/**
 * The injection token, so a module binds one implementation without importing it.
 *
 * 🔴 **This token resolves to `BillingProvider | null`, and a bare symbol cannot
 * say so.** `BillingModule` returns `null` when no credentials are configured —
 * the state every test in this repository runs in — but an injection token
 * carries no type, so `@Inject(BILLING_PROVIDER) private p: BillingProvider`
 * compiles happily and then holds `null` at runtime. That is a crash inside a
 * checkout handler.
 *
 * ⚠️ **I asserted the opposite in prose** (*"callers must handle `null`; the
 * token's type says so"*, G2) — the fourth time this phase that a guarantee
 * lived in a comment instead of a mechanism. Consumers must resolve through
 * {@link requireBillingProvider}, which is a real signature the compiler checks.
 */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/** What the token actually resolves to. Inject this type, never `BillingProvider`. */
export type BillingProviderOrNull = BillingProvider | null;

/**
 * Unwrap the token, or fail with a reason a human can act on.
 *
 * 📌 **This is where G3's "guarded at the call sites" stops being a promise.**
 * `BillingModule` deliberately resolves to `null` rather than refusing to boot,
 * so that a deployment missing its keys serves every non-billing route instead
 * of taking the whole API down. The cost of that choice is that each billing
 * entry point must state what it needs — this function is how, in one line, and
 * the thrown error names the missing configuration rather than surfacing as
 * *"cannot read properties of null"* three frames deeper.
 */
export function requireBillingProvider(provider: BillingProviderOrNull): BillingProvider {
  if (provider === null) {
    throw new Error(
      'No billing provider is configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET absent).',
    );
  }

  return provider;
}
