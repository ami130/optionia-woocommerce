import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { SubscriptionStatus } from '../common/database/enums';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { BillingNotifierService } from './billing-notifier.service';
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
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(PlanPrice)
    private readonly prices: Repository<PlanPrice>,
    private readonly dataSource: DataSource,
    private readonly notifier: BillingNotifierService,
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

      /*
       * 🔴 **`created` routes here because it carries the same object.**
       * Verified against the library's types, not assumed:
       * `CustomerSubscriptionCreatedEvent.data.object` and the `updated` one
       * are the same `Stripe.Subscription`.
       *
       * ⚠️ **Handling it closes a dependency on delivery order.** Until now a
       * subscription only became known through `updated`, which Stripe is not
       * obliged to send first — so a merchant whose `created` arrived alone sat
       * unlinked until some later event happened to correct it.
       */
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.onSubscriptionChanged(payload);

      /*
       * 📌 **`invoice.paid` and `invoice.payment_succeeded` are both sent**, for
       * the same invoice, and mean the same thing to this system. Routing both
       * to one handler is safe because storing an invoice is an upsert on
       * `uq_invoices_provider_invoice` — the second is a no-op rather than a
       * second row, which M23.3 names as a required handler and F99 already
       * made idempotent.
       */
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
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
     * 🔴 **ADR-118, which said this and was not built (H2).** Its exact words:
     * *"`tenants.country`, `vatNumber` and `billingCurrency` are populated from
     * the completed session."* The adapter already collects all three —
     * `billing_address_collection: 'required'` and `tax_id_collection` — and
     * this handler was throwing them away, so a paying tenant's billing identity
     * stayed null for ever.
     *
     * 📌 **Collected here and nowhere else**, deliberately: every field on a
     * signup form costs conversion, and M22.6 needs merchants to trust the free
     * tier *before* they are asked for a tax id.
     */
    await this.recordBillingIdentity(tenantId, session);

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

    /*
     * 🔴 **The customer id is a fallback because Stripe does not guarantee
     * order (H4).** `providerSubscriptionId` is written by
     * `checkout.session.completed`; if this event overtakes it — measured, not
     * assumed: a probe delivered it first and the subscription stayed
     * `trialing` while the request answered **200**, which Stripe never
     * redelivers — the merchant had paid and the system did not know.
     *
     * ⚠️ Matching on the customer then adopts the subscription id, so the
     * checkout event that follows finds a row already linked rather than
     * overwriting a newer state.
     */
    const subscription = await this.findSubscription(
      providerSubscriptionId,
      this.asId(remote.customer),
    );

    if (subscription === null) {
      return {
        changed: false,
        reason: `no subscription matches ${providerSubscriptionId}`,
      };
    }

    subscription.providerSubscriptionId = providerSubscriptionId;
    subscription.provider = 'stripe';

    const status = this.readStatus(remote.status);

    if (status === null) {
      return { changed: false, reason: `unmapped provider status: ${String(remote.status)}` };
    }

    subscription.status = status;
    subscription.currentPeriodEnd = this.asDate(remote.current_period_end);
    subscription.cancelAt = this.asDate(remote.cancel_at);

    /*
     * 🔴 **The plan moves with the price (H3).** This handler wrote status and
     * dates and left `planId` alone, so a merchant who upgraded in Stripe was
     * charged the new price and kept the **old plan's limits** — permanently.
     * Measured with a probe: after an upgrade event, `planId` was unchanged and
     * `planPriceId` was still null.
     *
     * ⚠️ **ADR-117 depends on this.** "Limit raises apply at once" cannot
     * happen if nothing propagates which plan was bought.
     */
    await this.adoptPlanFromPrice(subscription, remote);

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

    /*
     * 🔴 **One transaction, because these two writes must agree (N2).** Storing
     * the invoice and activating the subscription were separate commits, so a
     * failure between them left the invoice recorded and the merchant still
     * `past_due` — they had paid, we had the receipt, and they were locked out.
     *
     * ⚠️ **N1 is why that mattered so much**: the retry that should have
     * repaired it was answered "already handled" by the claimed event row.
     * Both are fixed, and this one means a retry has nothing to repair.
     */
    await this.dataSource.transaction(async (manager) => {
      await this.storeInvoice(manager, subscription, columns);

      /*
       * 📌 A paid invoice ends any grace period, whatever order the events
       * arrive in — `invoice.paid` and `customer.subscription.updated` are not
       * ordered.
       */
      if (subscription.status !== SubscriptionStatus.ACTIVE) {
        subscription.status = SubscriptionStatus.ACTIVE;
      }
      subscription.graceEndsAt = null;

      await manager.save(Subscription, subscription);
    });

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

    /*
     * 🔴 **`graceEndsAt === null` is the dedupe signal, and it already existed.**
     * Stripe's dunning fires `invoice.payment_failed` several times per lapse,
     * and the mail service has suppression but **no dedupe** — so wiring mail
     * here naïvely sends a merchant four identical "your payment failed"
     * messages. This flag is true exactly once per lapse, which is exactly when
     * the merchant has not yet been told, so no new column is needed to know it.
     *
     * ⚠️ **Recovery clears it** (F99), so a *later* lapse mails again — which is
     * right: a second failure a month after recovering is news.
     */
    const firstFailureOfThisLapse = subscription.graceEndsAt === null;

    if (firstFailureOfThisLapse) {
      const endsAt = new Date();
      endsAt.setUTCDate(endsAt.getUTCDate() + GRACE_DAYS);
      subscription.graceEndsAt = endsAt;
    }

    await this.subscriptions.save(subscription);

    if (firstFailureOfThisLapse) {
      /*
       * 📌 **Mail failure must not fail the webhook.** Returning non-2xx would
       * have Stripe redeliver an event whose *billing* effect already committed
       * — and F111 means that retry would now re-run the handler, moving the
       * grace deadline. The notice is best-effort; the deadline is the record.
       */
      await this.notifier.paymentFailed(subscription).catch((error: unknown) => {
        this.logger.warn(
          `Recorded the lapse but could not send dunning mail: ${(error as Error).message}`,
        );
      });
    }

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
    manager: EntityManager,
    subscription: Subscription,
    columns: MappedInvoiceColumns,
  ): Promise<void> {
    const existing = await manager.findOne(Invoice, {
      where: { provider: 'stripe', providerInvoiceId: columns.providerInvoiceId },
    });

    if (existing !== null) {
      await manager.save(Invoice, Object.assign(existing, columns));

      return;
    }

    await manager.save(
      Invoice,
      manager.create(Invoice, {
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        provider: 'stripe',
        ...columns,
      }),
    );
  }

  /**
   * Populate the tenant's billing identity from a completed session (ADR-118).
   *
   * ⚠️ **Only ever fills a blank, never overwrites.** A merchant who moves house
   * updates their details at the provider, and a stale local copy is a reporting
   * question rather than a reason to silently rewrite a VAT number that an
   * invoice was already issued against. The columns are set once, at the first
   * paid checkout, which is what the ADR describes.
   */
  private async recordBillingIdentity(
    tenantId: string,
    session: Record<string, unknown>,
  ): Promise<void> {
    const tenant = await this.tenants.findOne({ where: { id: tenantId } });

    if (tenant === null) {
      return;
    }

    const details = this.asRecord(session.customer_details);
    const address = this.asRecord(details.address);

    const country = this.asCode(address.country, 2);
    const currency = this.asCode(session.currency, 3);
    const vatNumber = this.readTaxId(details.tax_ids);

    if (tenant.country === null && country !== null) {
      tenant.country = country;
    }

    if (tenant.billingCurrency === null && currency !== null) {
      tenant.billingCurrency = currency;
    }

    if (tenant.vatNumber === null && vatNumber !== null) {
      tenant.vatNumber = vatNumber;
    }

    await this.tenants.save(tenant);
  }

  /**
   * ⚠️ **The column is `varchar(32)`**, so a longer id is dropped rather than
   * truncated into a different — and invalid — VAT number.
   */
  private readTaxId(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return null;
    }

    for (const entry of value) {
      const id = this.asRecord(entry).value;

      if (typeof id === 'string' && id.trim() !== '' && id.length <= 32) {
        return id.trim().toUpperCase();
      }
    }

    return null;
  }

  /**
   * Move the local plan to whatever price the provider now bills (H3).
   *
   * 🔴 **`plan_prices.providerPriceId` is the join**, which is why that column
   * exists: it is the only thing tying Stripe's price to the plan whose limits
   * this system enforces. A price we do not recognise leaves the plan untouched
   * and says so — guessing would grant or revoke entitlements on a hunch.
   */
  private async adoptPlanFromPrice(
    subscription: Subscription,
    remote: Record<string, unknown>,
  ): Promise<void> {
    const providerPriceId = this.readPriceId(remote);

    if (providerPriceId === null) {
      return;
    }

    const price = await this.prices.findOne({ where: { providerPriceId } });

    if (price === null) {
      this.logger.warn(
        `Subscription ${subscription.providerSubscriptionId ?? '?'} bills an unknown price ` +
          `${providerPriceId}; the plan was left unchanged.`,
      );

      return;
    }

    subscription.planId = price.planId;
    subscription.planPriceId = price.id;
  }

  /** Stripe carries the price on the subscription's first line item. */
  private readPriceId(remote: Record<string, unknown>): string | null {
    const items = this.asRecord(remote.items).data;

    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    return this.asId(this.asRecord(items[0]).price);
  }

  /** A fixed-length code, or nothing — these columns are `char(2)` and `char(3)`. */
  private asCode(value: unknown, length: number): string | null {
    return typeof value === 'string' && value.length === length ? value.toUpperCase() : null;
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
