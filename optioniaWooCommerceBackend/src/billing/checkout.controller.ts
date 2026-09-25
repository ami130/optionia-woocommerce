import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { CheckoutService } from './checkout.service';
import { StartCheckoutDto } from './dto/checkout.dto';

/**
 * Where a merchant starts paying (M22.D1) — the entrance H1 found missing.
 *
 * 📌 **The opposite of the webhook in every respect**, deliberately: that route
 * is public and signature-authenticated because Stripe carries no token; this
 * one is a merchant acting in their own tenant, so it takes the full guard
 * chain. Two routes in one subsystem with opposite auth models is the kind of
 * asymmetry worth stating rather than leaving a reader to infer.
 */
@Controller('billing')
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

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
}
