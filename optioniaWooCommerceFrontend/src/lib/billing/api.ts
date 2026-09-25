import { api, apiRequest } from '@/lib/api/client';

/** What this account is on right now, as `GET /billing/subscription` reports it. */
export interface SubscriptionSummary {
  planCode: string;
  planName: string;
  status: SubscriptionStatus;

  /**
   * 🔴 **The PINNED price, not the plan's current figure.** A merchant sees
   * what they are charged — the row they bought — which is ADR-117's
   * grandfathering made visible. Null on a plan with no price yet.
   */
  currency: string | null;
  amountMinor: number | null;
  interval: string | null;

  currentPeriodEnd: string | null;
  cancelAt: string | null;
  trialEndsAt: string | null;

  /** When read-only authoring begins if nothing is paid (ADR-116). */
  graceEndsAt: string | null;

  /**
   * ⚠️ **A checkout completed and the provider has not confirmed the terms.**
   * The window between `checkout.session.completed` and
   * `customer.subscription.updated` — without showing it, a merchant who just
   * paid sees the plan they left, which reads like a failed payment.
   */
  settling: boolean;
}

/**
 * The six states a subscription can be in.
 *
 * Not a boolean: `past_due` means a card to fix, `grace` means a deadline,
 * `cancelled` means it ends at the period, and `expired` means it already has.
 * Collapsing them would tell a merchant nothing they can act on.
 */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'grace'
  | 'cancelled'
  | 'expired';

/** One invoice, as a merchant needs to see it. */
export interface InvoiceSummary {
  id: string;
  number: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  issuedAt: string | null;
  paidAt: string | null;

  /**
   * 📌 **The provider's hosted invoice, not one we render.** A tax-compliant
   * PDF is the provider's output; re-rendering it here would mean two documents
   * for one charge that must agree forever.
   */
  hostedUrl: string | null;
}

/** A plan a merchant may buy, as `GET /billing/plans` reports it. */
export interface PurchasablePlan {
  id: string;
  code: string;
  name: string;
  isPublic: boolean;
  sortOrder: number;
  limits: Record<string, unknown>;
  prices: Array<{
    id: string;
    currency: string;
    interval: string;
    amountMinor: number;
    providerPriceId: string | null;
  }>;
}

/**
 * 🔴 **Every row here is one checkout will accept.** The API excludes hidden
 * plans and prices with no provider link, so the picker cannot offer something
 * the next screen refuses — which is worse than omitting it.
 */
export async function listPlans(): Promise<PurchasablePlan[]> {
  const { data } = await api.get<PurchasablePlan[]>('/billing/plans');

  return data;
}

export async function getSubscription(): Promise<SubscriptionSummary> {
  const { data } = await api.get<SubscriptionSummary>('/billing/subscription');

  return data;
}

export async function listInvoices(): Promise<InvoiceSummary[]> {
  const { data } = await api.get<InvoiceSummary[]>('/billing/invoices');

  return data;
}

/**
 * Start a checkout, and answer with where to send the browser.
 *
 * 🔴 **Takes a `planPriceId`, never a plan.** What a merchant is charged is the
 * immutable price row they buy — a plan whose price staff edit tomorrow must
 * not re-price someone who paid today.
 */
export async function startCheckout(planPriceId: string): Promise<{ url: string }> {
  const { data } = await api.post<{ url: string; reference: string }>('/billing/checkout', {
    planPriceId,
  });

  return { url: data.url };
}

/**
 * A session at the provider's billing portal.
 *
 * ⚠️ **Fetched fresh each time.** Portal links are short-lived and single-use
 * at the provider, so caching one hands a merchant a dead link — or worse, a
 * live one to whoever sees it next.
 */
export async function openPortal(): Promise<{ url: string }> {
  const { data } = await api.post<{ url: string }>('/billing/portal', {});

  return data;
}

/**
 * Cancel, at the end of the paid term by default.
 *
 * 📌 **The merchant has paid for the term**; ending it immediately takes
 * something they bought. The reason is optional — a required field on the way
 * out produces junk from people who want the dialog gone.
 */
export async function cancelSubscription(reason: string | null): Promise<void> {
  /*
   * ⚠️ **`apiRequest` directly, because `api.delete` deliberately takes no
   * body.** The client's `delete` helper excludes `body` by type, and widening
   * it would change every DELETE in the product to carry one it does not want.
   * The cancel route needs `atPeriodEnd` and an optional reason, so this one
   * call reaches past the helper rather than reshaping it for everybody.
   */
  await apiRequest('/billing/subscription', {
    method: 'DELETE',
    body: { atPeriodEnd: true, ...(reason === null ? {} : { reason }) },
  });
}
