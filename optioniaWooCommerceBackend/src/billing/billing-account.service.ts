import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { requireTenantId } from '../common/context/request-context';
import { loadConfig } from '../config/env';
import { InvoiceStatus, SubscriptionStatus } from '../common/database/enums';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import {
  BILLING_PROVIDER,
  type BillingProviderOrNull,
  requireBillingProvider,
} from './billing-provider';
import { Invoice } from './entities/invoice.entity';

/** What a merchant is currently on, and what state it is in. */
export interface SubscriptionSummary {
  readonly planCode: string;
  readonly planName: string;
  readonly status: SubscriptionStatus;
  readonly currency: string | null;
  readonly amountMinor: number | null;
  readonly interval: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAt: string | null;
  readonly trialEndsAt: string | null;

  /**
   * When read-only authoring begins if nothing is paid (ADR-116).
   *
   * 📌 Exposed because a merchant cannot act on a deadline they cannot see. The
   * guard that enforces it is Phase 24; this is the number the dashboard banner
   * needs regardless.
   */
  readonly graceEndsAt: string | null;
}

/** One invoice, as a merchant needs to see it. */
export interface InvoiceSummary {
  readonly id: string;
  readonly number: string;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly issuedAt: string | null;
  readonly paidAt: string | null;

  /**
   * ⚠️ **The provider's hosted invoice, not one we render.** A tax-compliant
   * invoice PDF is the provider's output; re-rendering it here would mean two
   * documents for one charge that must agree forever.
   */
  readonly hostedUrl: string | null;
}

/**
 * What a merchant can see and do about their own billing (M22.E1–E4).
 *
 * ## Why these exist
 *
 * 🔴 **Phase 22's exit criterion is four verbs — subscribe, upgrade, downgrade,
 * cancel — and only the first had a route.** `cancelSubscription` and
 * `updatePlan` were built, tested, and called by nothing, which is H1's defect
 * repeated: I fixed the single instance for `createCheckout` and did not ask
 * whether its siblings had the same problem. They did.
 *
 * ## Why nothing here writes subscription state
 *
 * 🔴 **Every method calls the provider and returns.** M22.4 is explicit that
 * `subscriptions` is updated **only** from verified webhooks — so a cancel
 * records intent at Stripe and the resulting `customer.subscription.updated`
 * records the truth. Writing the status here would create a second source that
 * disagrees with the provider the moment a call succeeds and its webhook does
 * not arrive.
 */
@Injectable()
export class BillingAccountService {
  constructor(
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProviderOrNull,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(Invoice)
    private readonly invoices: Repository<Invoice>,
    @InjectRepository(PlanPrice)
    private readonly prices: Repository<PlanPrice>,
  ) {}

  /** E1 — the current subscription, with the plan and price it is pinned to. */
  async summary(): Promise<SubscriptionSummary> {
    const subscription = await this.load({ withPrice: true });
    const price = subscription.planPrice;

    return {
      planCode: subscription.plan?.code ?? 'unknown',
      planName: subscription.plan?.name ?? 'Unknown',
      status: subscription.status,

      /*
       * ⚠️ **From the pinned price, never the plan's current figure.** A
       * merchant sees what they are charged, which is the row they bought —
       * the whole point of `plan_prices` (ADR-117, grandfathering).
       */
      currency: price?.currency ?? null,
      amountMinor: price?.amountMinor ?? null,
      interval: price?.interval ?? null,

      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      cancelAt: subscription.cancelAt?.toISOString() ?? null,
      trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
      graceEndsAt: subscription.graceEndsAt?.toISOString() ?? null,
    };
  }

  /**
   * E2 — invoice history, newest first.
   *
   * 🔴 **This gives `invoices` its first reader.** The table has been written by
   * the webhook since F91 and read by nothing, which is the `isPublic`/G8
   * pattern at table scale: a compliance record nobody can retrieve is a record
   * whose correctness is untested.
   */
  async listInvoices(limit: number): Promise<InvoiceSummary[]> {
    const tenantId = requireTenantId();

    const rows = await this.invoices.find({
      where: { tenantId },

      /*
       * ⚠️ **Ordered by `issuedAt`, with `id` breaking ties.** Ids are uuidv7 so
       * they are time-ordered anyway, but an invoice with a null `issuedAt` (a
       * draft) would otherwise sort unpredictably between runs.
       */
      order: { issuedAt: 'DESC', id: 'DESC' },
      take: limit,
    });

    return rows.map((invoice) => ({
      id: invoice.id,
      number: invoice.providerInvoiceId,
      status: invoice.status,
      currency: invoice.currency,
      subtotalMinor: invoice.subtotalMinor,
      taxMinor: invoice.taxMinor,
      totalMinor: invoice.totalMinor,
      issuedAt: invoice.issuedAt?.toISOString() ?? null,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      hostedUrl: invoice.hostedUrl,
    }));
  }

  /**
   * E3 — move to a different plan price.
   *
   * 📌 **ADR-117 governs what the merchant experiences**: the provider prorates,
   * limit raises apply as soon as the webhook lands, and cuts apply at renewal.
   * None of that is computed here — *"two implementations of what is owed on a
   * mid-term upgrade is one more than a billing system can afford."*
   */
  async changePlan(planPriceId: string): Promise<{ accepted: true }> {
    const provider = requireBillingProvider(this.provider);
    const subscription = await this.load({ withPrice: false });

    if (subscription.providerSubscriptionId === null) {
      throw new BadRequestException(
        'This account has no paid subscription to change. Start a checkout instead.',
      );
    }

    const price = await this.prices.findOne({ where: { id: planPriceId } });

    if (price === null) {
      throw new NotFoundException('Unknown plan price');
    }

    if (!price.isCurrent) {
      throw new BadRequestException('That price is no longer offered');
    }

    if (price.providerPriceId === null) {
      throw new BadRequestException('That price is not available for purchase yet');
    }

    if (price.id === subscription.planPriceId) {
      throw new BadRequestException('This account is already on that price');
    }

    /*
     * 🔴 **The currency must still agree** — F94/E4 again, on the path that did
     * not exist when that check was written. An upgrade into another currency
     * would leave one tenant with invoices in two currencies and a column that
     * stores no currency per amount.
     */
    const current = await this.prices.findOne({
      where: { id: subscription.planPriceId ?? '' },
    });

    if (current !== null && current.currency.toUpperCase() !== price.currency.toUpperCase()) {
      throw new BadRequestException(
        `This subscription is billed in ${current.currency}; that price is in ${price.currency}`,
      );
    }

    await provider.updatePlan({
      providerSubscriptionId: subscription.providerSubscriptionId,
      planPriceId: price.providerPriceId,
    });

    /*
     * 📌 **`accepted`, not the new plan.** The change is the provider's to
     * confirm: `customer.subscription.updated` moves `planId` and
     * `planPriceId` locally (H3). Returning the new plan here would be this
     * service asserting an outcome it has not observed.
     */
    return { accepted: true };
  }

  /**
   * E4 — cancel.
   *
   * ⚠️ **At the period's end by default.** The merchant has paid for the term;
   * ending it immediately takes something they bought. Immediate cancellation
   * exists for the case where they ask for it explicitly.
   */
  async cancel(input: { atPeriodEnd: boolean; reason: string | null }): Promise<{ accepted: true }> {
    const provider = requireBillingProvider(this.provider);
    const subscription = await this.load({ withPrice: false });

    if (subscription.providerSubscriptionId === null) {
      throw new BadRequestException('This account has no paid subscription to cancel.');
    }

    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new BadRequestException('This subscription is already cancelled.');
    }

    await provider.cancelSubscription({
      providerSubscriptionId: subscription.providerSubscriptionId,
      atPeriodEnd: input.atPeriodEnd,
    });

    /*
     * ⚠️ **The reason is recorded on the subscription, not sent to the
     * provider.** M22.5 asks for cancellation with reason capture, and it is
     * ours to analyse — a field in Stripe's metadata would be readable only by
     * whoever opens their dashboard.
     *
     * 📌 This is the one local write in this class, and it is deliberate: it is
     * *our* datum, not a mirror of provider state, so it cannot disagree with a
     * webhook.
     */
    if (input.reason !== null) {
      await this.subscriptions.update(
        { id: subscription.id },
        { cancellationReason: input.reason },
      );
    }

    return { accepted: true };
  }

  /**
   * E5 — a session at the provider's billing portal (M22.3, M22.5).
   *
   * 🔴 **Payment method management is the provider's surface, deliberately.**
   * Collecting card details ourselves would put this service in PCI scope for
   * no benefit a merchant can see. The portal also carries invoice history, tax
   * ids and cancellation — all of which the provider must agree with anyway, so
   * a second implementation would be a second thing to keep in sync.
   *
   * ⚠️ **A tenant that has never paid has no provider customer**, and there is
   * nothing for a portal to show. Refused with a reason rather than sending
   * them to an empty page.
   */
  async portalSession(): Promise<{ url: string }> {
    const provider = requireBillingProvider(this.provider);
    const subscription = await this.load({ withPrice: false });

    if (subscription.providerCustomerId === null) {
      throw new BadRequestException(
        'This account has no billing profile yet. Start a checkout first.',
      );
    }

    const config = loadConfig();

    return provider.createPortalSession({
      providerCustomerId: subscription.providerCustomerId,
      returnUrl: `${config.appUrl}/billing`,
    });
  }

  /**
   * The current tenant's subscription.
   *
   * 🔴 **Scoped by `requireTenantId()`, never by a parameter.** A billing route
   * that took a tenant id would be one `WHERE` clause away from showing one
   * merchant another's invoices.
   */
  private async load(options: { withPrice: boolean }): Promise<Subscription> {
    const tenantId = requireTenantId();

    const subscription = await this.subscriptions.findOne({
      where: { tenantId },
      relations: options.withPrice ? { plan: true, planPrice: true } : { plan: true },
    });

    if (subscription === null) {
      /*
       * ⚠️ Every tenant gets a subscription at provisioning, so this is a data
       * fault rather than a state a merchant can reach — surfaced rather than
       * papered over with a fabricated free plan.
       */
      throw new NotFoundException('This account has no subscription record');
    }

    return subscription;
  }
}
