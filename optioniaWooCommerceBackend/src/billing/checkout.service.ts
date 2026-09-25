import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { requireTenantId } from '../common/context/request-context';
import { loadConfig } from '../config/env';
import { PlanPrice } from '../plans/entities/plan-price.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import {
  BILLING_PROVIDER,
  type BillingProviderOrNull,
  requireBillingProvider,
} from './billing-provider';

/**
 * Starting a payment — the entrance Phase 22 did not have (H1).
 *
 * 🔴 **`createCheckout` was built, tested and unreachable.** No controller, no
 * service, no route called it, so `checkout.session.completed` could never fire
 * for a session nothing created: every lifecycle handler downstream was waiting
 * on an event no merchant could produce. The same defect class as F94/E1 and G5,
 * one level up — the parts were wired to each other but not to a user.
 *
 * ⚠️ **It was never in my step-C plan**, which is why it was not forgotten but
 * never scheduled. An audit that only reads the code it just wrote cannot find
 * that; this one was found by asking who calls it.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProviderOrNull,
    @InjectRepository(PlanPrice)
    private readonly prices: Repository<PlanPrice>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  /**
   * Start a checkout for the current tenant against one pinned price.
   *
   * 🔴 **Takes a `planPriceId`, never a `planId`** — the interface's own rule:
   * what a merchant is charged is the immutable price row they bought, not the
   * plan's current figure. A plan whose price staff edit tomorrow must not
   * re-price a merchant who paid today.
   */
  async start(input: { planPriceId: string }): Promise<{ url: string; reference: string }> {
    const provider = requireBillingProvider(this.provider);
    const tenantId = requireTenantId();

    const price = await this.prices.findOne({ where: { id: input.planPriceId } });

    if (price === null) {
      throw new NotFoundException('Unknown plan price');
    }

    /*
     * ⚠️ **A retired price cannot be bought.** `isCurrent` is how a superseded
     * price stays readable for the subscriptions pinned to it without remaining
     * on sale — selling one would pin a new merchant to terms that were
     * deliberately withdrawn.
     */
    if (!price.isCurrent) {
      throw new BadRequestException('That price is no longer offered');
    }

    if (price.providerPriceId === null) {
      /*
       * 📌 A price that exists locally but was never created at the provider.
       * Surfaced rather than passed through, because Stripe's own error for an
       * unknown price id reads like an integration fault and would be debugged
       * in the wrong place.
       */
      throw new BadRequestException('That price is not available for purchase yet');
    }

    const tenant = await this.tenants.findOne({ where: { id: tenantId } });

    if (tenant === null) {
      throw new NotFoundException('Unknown tenant');
    }

    this.assertCurrencyAgrees(tenant, price);

    const subscription = await this.subscriptions.findOne({ where: { tenantId } });

    const config = loadConfig();

    const session = await provider.createCheckout({
      tenantId,
      planPriceId: price.providerPriceId,

      /*
       * 📌 Reusing the provider customer when one exists keeps a merchant's
       * payment methods, tax ids and invoice history on one customer rather than
       * scattering them across a new one per purchase.
       */
      providerCustomerId: subscription?.providerCustomerId ?? null,
      successUrl: `${config.appUrl}/billing?checkout=success`,
      cancelUrl: `${config.appUrl}/billing?checkout=cancelled`,
    });

    /*
     * 📌 **`reference`, not "sessionId".** The interface names it that
     * deliberately: checkout completes asynchronously, so this is the handle
     * that links a browser redirect to the webhook that follows — not a
     * subscription id, which does not exist yet.
     */
    return { url: session.url, reference: session.reference };
  }

  /**
   * 🔴 **F94/E4, closed here.** Nothing checked that a tenant's billing currency
   * agreed with the price it was sent to — so a tenant recorded as billing in
   * EUR could be charged in USD, and every later total would mix two currencies
   * in one column that stores no currency per amount.
   *
   * ⚠️ **A tenant with no currency yet is fine**, and this is the reason the
   * column is nullable (ADR-118/F84): a free-tier tenant has never been billed,
   * and its currency is *established* by this first purchase rather than checked
   * against it.
   */
  private assertCurrencyAgrees(tenant: Tenant, price: PlanPrice): void {
    if (tenant.billingCurrency === null) {
      return;
    }

    if (tenant.billingCurrency.toUpperCase() !== price.currency.toUpperCase()) {
      throw new BadRequestException(
        `This account is billed in ${tenant.billingCurrency}; that price is in ${price.currency}`,
      );
    }
  }
}
