import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SubscriptionStatus } from '../common/database/enums';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Invoice } from './entities/invoice.entity';
import { mapInvoice, type MappedInvoiceColumns } from './invoice.mapper';

/** How long a merchant keeps full use after a failed payment (ADR-116). */
export const GRACE_DAYS = 14;

/**
 * What a handled event changed, so a caller can log something useful.
 *
 * 📌 `ignored` is the common case and not a problem: Stripe sends dozens of
 * event types and this service acts on four. Saying so explicitly beats a silent
 * `void` return that cannot distinguish "nothing to do" from "did nothing".
 */
export type LifecycleResult =
  | { changed: true; detail: string }
  | { changed: false; reason: string };

/**
 * Subscription state, driven by verified webhooks (M22.C4).
 *
 * ## Why only webhooks, never a redirect
 *
 * 🔴 **A merchant who closes the tab after paying must still end up
 * subscribed**, and one who forges a return URL must not. The browser is a
 * hint; the webhook is the fact. Nothing in this class is reachable from a
 * redirect handler, which is what makes that guarantee structural rather than a
 * convention someone can forget.
 *
 * ## Why a failed payment does not suspend anything
 *
 * ⚠️ **ADR-116: fourteen days of grace, then read-only authoring, and the
 * storefront NEVER goes dark.** Most payment failures are expired cards rather
 * than refusals to pay, and a merchant who loses a day of sales to a failed
 * renewal will churn *and* dispute the charge. This service records
 * `graceEndsAt`; the guard that acts on it is step D, deliberately separate
 * because it touches every write endpoint.
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(Invoice)
    private readonly invoices: Repository<Invoice>,
  ) {}

  /**
   * 🔴 **An unknown event type is ignored, not an error.** Stripe sends whatever
   * the account is subscribed to, and throwing on an unrecognised type would
   * answer 5xx to a perfectly good delivery — which Stripe then retries for
   * days. The `billing_events` row is already written either way, so nothing is
   * lost by declining to act.
   */
  async apply(type: string, payload: unknown): Promise<LifecycleResult> {
    switch (type) {
      case 'checkout.session.completed':
        return this.onCheckoutCompleted(payload);

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.onSubscriptionChanged(payload);

      case 'invoice.paid':
        return this.onInvoicePaid(payload);

      case 'invoice.payment_failed':
        return this.onPaymentFailed(payload);

      default:
        return { changed: false, reason: `no handler for ${type}` };
    }
  }

  /**
   * The first paid checkout: bind the tenant to its provider identity.
   *
   * 🔴 **`client_reference_id` is how a session finds its tenant.** The adapter
   * sets it at checkout precisely so this moment needs no guesswork — and a
   * session arriving without one is a configuration fault worth surfacing, not
   * a subscription to guess at.
   */
  private async onCheckoutCompleted(payload: unknown): Promise<LifecycleResult> {
    const session = this.asRecord(payload);
    const tenantId = this.asId(session.client_reference_id);

    if (tenantId === null) {
      return { changed: false, reason: 'checkout session carried no client_reference_id' };
    }

    const subscription = await this.subscriptions.findOne({ where: { tenantId } });

    if (subscription === null) {
      return { changed: false, reason: `no subscription for tenant ${tenantId}` };
    }

    subscription.provider = 'stripe';
    subscription.providerCustomerId = this.asId(session.customer);
    subscription.providerSubscriptionId = this.asId(session.subscription);

    /*
     * ⚠️ **Not set to ACTIVE here.** A completed checkout means Stripe took the
     * payment method, not that the first invoice is paid —
     * `customer.subscription.updated` carries the real state and arrives
     * moments later. Setting it here would make a failed first charge look
     * active until the next event corrected it.
     */
    await this.subscriptions.save(subscription);

    return { changed: true, detail: `linked tenant ${tenantId} to its Stripe customer` };
  }

  /**
   * The provider's own view of the subscription, which is authoritative.
   *
   * 📌 **Status comes from the payload, not from inference.** Stripe knows about
   * dunning schedules, proration and involuntary churn that this service does
   * not; re-deriving a status locally would mean two sources disagreeing about
   * whether a merchant has paid.
   */
  private async onSubscriptionChanged(payload: unknown): Promise<LifecycleResult> {
    const remote = this.asRecord(payload);
    const providerSubscriptionId = this.asId(remote.id);

    if (providerSubscriptionId === null) {
      return { changed: false, reason: 'subscription event carried no id' };
    }

    const subscription = await this.subscriptions.findOne({
      where: { providerSubscriptionId },
    });

    if (subscription === null) {
      return {
        changed: false,
        reason: `no subscription matches ${providerSubscriptionId}`,
      };
    }

    const status = this.readStatus(remote.status);

    if (status === null) {
      return { changed: false, reason: `unmapped provider status: ${String(remote.status)}` };
    }

    subscription.status = status;
    subscription.currentPeriodEnd = this.asDate(remote.current_period_end);
    subscription.cancelAt = this.asDate(remote.cancel_at);

    /*
     * 🔴 **Recovering clears the grace clock.** Leaving a stale `graceEndsAt` on
     * a subscription that has since paid would have step D's guard lock out a
     * paying merchant — a silently wrong date is worse than a missing one.
     */
    if (status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.TRIALING) {
      subscription.graceEndsAt = null;
    }

    await this.subscriptions.save(subscription);

    return { changed: true, detail: `subscription ${providerSubscriptionId} is now ${status}` };
  }

  /**
   * A paid invoice: store it for the tax report, and confirm the subscription.
   *
   * 🔴 **This is what `invoices` was built for** (F91/ADR-115). ParseLab is
   * merchant of record, so filing is ours, and filing needs local rows.
   */
  private async onInvoicePaid(payload: unknown): Promise<LifecycleResult> {
    const mapped = mapInvoice(payload);

    if (!mapped.ok) {
      /*
       * ⚠️ **Logged and swallowed, not thrown.** A malformed invoice must not
       * fail the webhook request — Stripe would retry the same unmappable
       * payload for days. The `billing_events` row holds the original.
       */
      this.logger.warn(`Could not map a paid invoice: ${mapped.reason}`);

      return { changed: false, reason: mapped.reason };
    }

    const { providerCustomerId, providerSubscriptionId, ...columns } = mapped.invoice;

    const subscription = await this.findSubscription(providerSubscriptionId, providerCustomerId);

    if (subscription === null) {
      return { changed: false, reason: 'no subscription matches this invoice' };
    }

    await this.storeInvoice(subscription, columns);

    /*
     * 📌 A paid invoice ends any grace period, whatever order the events arrive
     * in — `invoice.paid` and `customer.subscription.updated` are not ordered.
     */
    if (subscription.status !== SubscriptionStatus.ACTIVE) {
      subscription.status = SubscriptionStatus.ACTIVE;
    }
    subscription.graceEndsAt = null;

    await this.subscriptions.save(subscription);

    return { changed: true, detail: `recorded invoice ${columns.providerInvoiceId} as paid` };
  }

  /**
   * A failed payment starts the clock; it does not suspend anything.
   *
   * ⚠️ **`graceEndsAt` is set once and not extended.** A merchant whose card
   * fails four times in fourteen days must not get fifty-six days of grace by
   * accident — the clock starts at the first failure of a lapse and runs.
   */
  private async onPaymentFailed(payload: unknown): Promise<LifecycleResult> {
    const invoice = this.asRecord(payload);

    const subscription = await this.findSubscription(
      this.readSubscriptionId(invoice),
      this.asId(invoice.customer),
    );

    if (subscription === null) {
      return { changed: false, reason: 'no subscription matches this failed payment' };
    }

    subscription.status = SubscriptionStatus.PAST_DUE;

    if (subscription.graceEndsAt === null) {
      const endsAt = new Date();
      endsAt.setUTCDate(endsAt.getUTCDate() + GRACE_DAYS);
      subscription.graceEndsAt = endsAt;
    }

    await this.subscriptions.save(subscription);

    return {
      changed: true,
      detail: `payment failed; grace ends ${subscription.graceEndsAt?.toISOString() ?? 'unknown'}`,
    };
  }

  /**
   * ⚠️ **By subscription id first, customer id second.** A tenant can hold more
   * than one provider customer over its life (a re-subscribe after cancelling),
   * so the subscription id is the precise key and the customer id is a fallback
   * for invoices that carry no subscription — a one-off charge, for instance.
   */
  private async findSubscription(
    providerSubscriptionId: string | null,
    providerCustomerId: string | null,
  ): Promise<Subscription | null> {
    if (providerSubscriptionId !== null) {
      const match = await this.subscriptions.findOne({ where: { providerSubscriptionId } });

      if (match !== null) {
        return match;
      }
    }

    if (providerCustomerId !== null) {
      return this.subscriptions.findOne({ where: { providerCustomerId } });
    }

    return null;
  }

  /**
   * 🔴 **Upsert by the provider's invoice id, which is uniquely indexed.**
   * `uq_invoices_provider_invoice` means a redelivered `invoice.paid` updates
   * the existing row rather than doubling a quarter's reported tax — the same
   * bargain the webhook's own idempotency strikes, one level down.
   */
  private async storeInvoice(
    subscription: Subscription,
    columns: MappedInvoiceColumns,
  ): Promise<void> {
    const existing = await this.invoices.findOne({
      where: { provider: 'stripe', providerInvoiceId: columns.providerInvoiceId },
    });

    if (existing !== null) {
      await this.invoices.save(Object.assign(existing, columns));

      return;
    }

    await this.invoices.save(
      this.invoices.create({
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        provider: 'stripe',
        ...columns,
      }),
    );
  }

  /** Stripe's subscription id moved to `parent` — see the invoice mapper. */
  private readSubscriptionId(invoice: Record<string, unknown>): string | null {
    const parent = invoice.parent;

    if (typeof parent !== 'object' || parent === null) {
      return null;
    }

    const details = (parent as Record<string, unknown>).subscription_details;

    return typeof details === 'object' && details !== null
      ? this.asId((details as Record<string, unknown>).subscription)
      : null;
  }

  /**
   * ⚠️ Stripe sends an id, **or** the whole object when a request expanded it.
   * Reading only the string silently loses the link.
   */
  private asId(value: unknown): string | null {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }

    if (typeof value === 'object' && value !== null) {
      const id = (value as Record<string, unknown>).id;

      return typeof id === 'string' && id.trim() !== '' ? id : null;
    }

    return null;
  }

  /** Stripe sends epoch seconds; `Date` takes milliseconds. */
  private asDate(value: unknown): Date | null {
    return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null;
  }

  private asRecord(payload: unknown): Record<string, unknown> {
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  }

  /**
   * 📌 **Stripe's subscription vocabulary, mapped here rather than trusted.**
   * An unrecognised status returns `null` and changes nothing — Stripe's union
   * is open, and writing an unknown string into a `varchar` status column is how
   * a guard later fails to recognise a paying customer.
   */
  private readStatus(value: unknown): SubscriptionStatus | null {
    switch (value) {
      case 'trialing':
      case 'incomplete':
        return SubscriptionStatus.TRIALING;
      case 'active':
        return SubscriptionStatus.ACTIVE;
      case 'past_due':
        return SubscriptionStatus.PAST_DUE;
      case 'paused':
        return SubscriptionStatus.GRACE;
      case 'canceled':
        return SubscriptionStatus.CANCELLED;
      case 'incomplete_expired':
      case 'unpaid':
        return SubscriptionStatus.EXPIRED;
      default:
        return null;
    }
  }
}
