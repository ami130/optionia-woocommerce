import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WritableWhenLapsed } from '../auth/guards/writable-when-lapsed.decorator';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import {
  BillingAccountService,
  type InvoiceSummary,
  type SubscriptionSummary,
} from './billing-account.service';
import { PlansAdminService, type PlanAdminView } from '../plans/plans-admin.service';
import { CheckoutService } from './checkout.service';
import {
  CancelSubscriptionDto,
  ChangePlanDto,
  ListInvoicesDto,
  StartCheckoutDto,
} from './dto/checkout.dto';

/** 📌 Enough for a year of monthly invoices on one screen. */
const DEFAULT_INVOICE_PAGE_SIZE = 25;

/**
 * Where a merchant starts paying (M22.D1) — the entrance H1 found missing.
 *
 * 📌 **The opposite of the webhook in every respect**, deliberately: that route
 * is public and signature-authenticated because Stripe carries no token; this
 * one is a merchant acting in their own tenant, so it takes the full guard
 * chain. Two routes in one subsystem with opposite auth models is the kind of
 * asymmetry worth stating rather than leaving a reader to infer.
 */
/*
 * 🔴 **Exempt from the lapsed-subscription guard, at the CONTROLLER level.**
 *
 * Every route here is part of paying: starting a checkout, changing plan,
 * cancelling, and opening the provider's portal to fix a card. ADR-116 pauses
 * authoring when a subscription lapses — and a read-only state that blocks the
 * payment which would lift it is a trap, not a policy. The merchant could never
 * recover, and the pressure the policy applies would have nowhere to convert.
 *
 * ⚠️ **Whole controller rather than four decorators**, because the exemption is
 * a property of what this controller IS. A fifth billing route added later
 * should inherit it; a route that should *not* be exempt does not belong here.
 */
@Controller('billing')
@WritableWhenLapsed()
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly account: BillingAccountService,
    private readonly plansAdmin: PlansAdminService,
  ) {}

  /**
   * Begin a checkout, and answer with the URL to send the browser to.
   *
   * 🔴 **`BILLING_MANAGE`, not `BILLING_VIEW`.** Starting a payment commits the
   * tenant to money; seeing what a plan costs does not. The capability model
   * already separates the two and this is exactly the distinction it was drawn
   * for.
   *
   * ⚠️ **Rate limited well below the global default.** A checkout creates a
   * session at the provider, so an unbounded loop here is billable traffic
   * against our own account — and no honest merchant starts thirty checkouts an
   * hour.
   */
  @Post('checkout')
  @RequireCapability(Capability.BILLING_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async start(@Body() body: StartCheckoutDto): Promise<{ url: string; reference: string }> {
    return this.checkout.start({ planPriceId: body.planPriceId });
  }

  /**
   * The plans a merchant may buy (M22.5).
   *
   * 🔴 **`BILLING_VIEW`, and it must exist for checkout to be usable at all.**
   * `POST /billing/checkout` takes a `planPriceId`; until this route the only
   * list of prices was staff-only, so the dashboard had a pay button and no way
   * to fill it in.
   *
   * 📌 **Hidden plans and unsellable prices are excluded**, so every row here is
   * one checkout will actually accept — a plan comparison that offers something
   * the next screen refuses is worse than one that omits it.
   */
  @Get('plans')
  @RequireCapability(Capability.BILLING_VIEW)
  @ApiErrors(200, 401, 403, 429)
  async plans(): Promise<PlanAdminView[]> {
    return this.plansAdmin.listPublic();
  }

  /**
   * E1 — what this account is on right now.
   *
   * 📌 **`BILLING_VIEW`, not `BILLING_MANAGE`.** Seeing the plan and its renewal
   * date is what a finance-facing member needs; committing the tenant to money
   * is not. The capability model already draws that line.
   */
  @Get('subscription')
  @RequireCapability(Capability.BILLING_VIEW)
  @ApiErrors(200, 401, 403, 404, 429)
  async subscription(): Promise<SubscriptionSummary> {
    return this.account.summary();
  }

  /**
   * E2 — invoice history, newest first.
   *
   * ⚠️ **`hostedUrl` points at the provider's own invoice.** A tax-compliant
   * PDF is the provider's output; re-rendering one here would mean two
   * documents for one charge that must agree forever.
   */
  @Get('invoices')
  @RequireCapability(Capability.BILLING_VIEW)
  @ApiErrors(200, 400, 401, 403, 429)
  async invoices(@Query() query: ListInvoicesDto): Promise<InvoiceSummary[]> {
    return this.account.listInvoices(query.limit ?? DEFAULT_INVOICE_PAGE_SIZE);
  }

  /**
   * E3 — upgrade or downgrade.
   *
   * 🔴 **Answers `accepted`, not the new plan.** The change is the provider's to
   * confirm: `customer.subscription.updated` is what moves `planId` locally.
   * Returning the new plan here would assert an outcome this route has not
   * observed, and M22.4 is explicit that state comes from the webhook.
   */
  @Post('plan')
  @RequireCapability(Capability.BILLING_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async changePlan(@Body() body: ChangePlanDto): Promise<{ accepted: true }> {
    return this.account.changePlan(body.planPriceId);
  }

  /**
   * E4 — cancel.
   *
   * ⚠️ **At the period's end unless asked otherwise.** The merchant has paid for
   * the term; ending it immediately takes something they bought.
   *
   * 📌 **200 rather than 204**, because the body carries `accepted` — a bare 204
   * would leave a client unable to distinguish "cancelled" from "route missing".
   */
  @Delete('subscription')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(Capability.BILLING_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async cancel(@Body() body: CancelSubscriptionDto): Promise<{ accepted: true }> {
    return this.account.cancel({
      atPeriodEnd: body.atPeriodEnd ?? true,
      reason: body.reason ?? null,
    });
  }

  /**
   * E5 — send the merchant to the provider's billing portal.
   *
   * 🔴 **`BILLING_MANAGE`.** The portal can change a payment method and cancel
   * a subscription; it is not a read surface however much of it is readable.
   *
   * 📌 **A fresh session each time, by design.** Portal links are short-lived
   * and single-use at the provider — caching one would hand a merchant a dead
   * link, or worse, a live one to whoever saw it next.
   */
  @Post('portal')
  @RequireCapability(Capability.BILLING_MANAGE)
  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async portal(): Promise<{ url: string }> {
    return this.account.portalSession();
  }
}
