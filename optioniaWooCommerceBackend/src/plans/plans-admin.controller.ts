import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { RequireStaffRole, StaffGuard } from '../admin/staff.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffRole } from '../common/database/enums';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import {
  SetPlanFeaturesDto,
  SetPlanLimitsDto,
  SetPlanPriceDto,
  SetPlanVisibilityDto,
} from './dto/plans-admin.dto';
import { PlansAdminService, type PlanAdminView } from './plans-admin.service';

/**
 * Plan and price administration (M22.1a).
 *
 * ## Why this is not behind `TenantGuard`
 *
 * 🔴 **Platform staff, not tenant admins.** *"A tenant admin editing what they
 * pay is not a feature, it is a vulnerability."* The guard chain is therefore
 * `JwtAuthGuard` then `StaffGuard` — deliberately **without** `TenantGuard`,
 * because these routes act on the platform's own data and belong to no tenant.
 *
 * ⚠️ **`BILLING_OPS` and `SUPER_ADMIN` only.** `SUPPORT` can help a merchant and
 * `READ_ONLY` can look; neither may change what anyone is charged.
 */
@Controller('admin/plans')
@ApiBearerAuth('staff')
@UseGuards(JwtAuthGuard, StaffGuard)
export class PlansAdminController {
  constructor(private readonly plans: PlansAdminService) {}

  /**
   * Every plan, including ones hidden from signup.
   *
   * 📌 **Hidden plans are included on purpose.** Staff need to see what exists
   * in order to decide what to publish; a list that showed only public plans
   * would make a withdrawn plan invisible to the people responsible for it.
   */
  @Get()
  @RequireStaffRole(StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS, StaffRole.READ_ONLY)
  @ApiErrors(200, 401, 403, 429)
  async list(): Promise<PlanAdminView[]> {
    return this.plans.list();
  }

  /**
   * Set a plan's price for one currency and interval.
   *
   * 🔴 **This SUPERSEDES rather than edits.** The response names the retired
   * row precisely so a reader can see that happened — a route that silently
   * mutated would look identical from the outside, and the difference is
   * whether every existing subscriber was just re-priced.
   *
   * ⚠️ **The new price cannot be sold until it is linked to the provider.**
   * `npm run billing:link-prices` creates the counterpart; until then checkout
   * refuses it, which is the correct order — a local price the provider has
   * never heard of must not be purchasable.
   */
  @Post(':code/price')
  @RequireStaffRole(StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async setPrice(
    @Param('code') code: string,
    @Body() body: SetPlanPriceDto,
  ): Promise<{ priceId: string; superseded: string | null }> {
    return this.plans.setPrice({
      planCode: code,
      currency: body.currency,
      interval: body.interval,
      amountMinor: body.amountMinor,
    });
  }

  /**
   * Show or hide a plan at signup.
   *
   * 🔴 **Hiding does not cancel anyone.** A merchant already on the plan keeps
   * it, keeps their pinned price and keeps their limits — only what a new
   * signup may choose changes.
   */
  @Patch(':code/visibility')
  @RequireStaffRole(StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async setVisibility(
    @Param('code') code: string,
    @Body() body: SetPlanVisibilityDto,
  ): Promise<PlanAdminView> {
    return this.plans.setVisibility(code, body.isPublic);
  }

  /**
   * Who a proposed limit change would put over (B10).
   *
   * 🔴 **A read, not a write, and it must be called before the PUT.** ADR-117's
   * 2026-09-29 amendment applies limit cuts **at once**, so a merchant mid-term
   * can lose headroom they paid for. The amendment trades that protection for
   * predictability on the condition that an admin can see who a cut affects
   * before saving it — this route is that condition.
   *
   * ⚠️ **It never blocks.** Refusing a change while any tenant is over would
   * let one large merchant make a plan unchangeable for everyone. The decision
   * stays the admin's; this only removes the excuse of not knowing.
   *
   * 📌 **`READ_ONLY` may call it.** It changes nothing, and someone answering a
   * merchant's question about their allowance needs the same view.
   */
  @Post(':code/limits/preview')
  @RequireStaffRole(StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS, StaffRole.READ_ONLY)
  @Throttle({ default: { limit: 120, ttl: 3_600_000 } })
  @ApiErrors(201, 400, 401, 403, 404, 429)
  async previewLimits(
    @Param('code') code: string,
    @Body() body: SetPlanLimitsDto,
  ): Promise<ReadonlyArray<{ metric: string; affected: number; worstExcess: number }>> {
    return this.plans.previewLimitChange(code, body.limits);
  }

  /**
   * Replace a plan's enforceable allowances (B10).
   *
   * 🔴 **Unlike a price, this reaches existing subscribers immediately.**
   * `plan_prices` protects a buyer structurally — a subscription is pinned to
   * the row it bought — and `plans.limits` has no such pin: `PlanLimitGuard`
   * reads it live on every request. ADR-117 was amended on 2026-09-29 to say so
   * rather than to promise a renewal boundary the code never had.
   *
   * ⚠️ **PUT, because it REPLACES.** An absent key is how a plan stops metering
   * a metric at all, and a PATCH-shaped merge could never express that.
   */
  @Put(':code/limits')
  @RequireStaffRole(StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async setLimits(
    @Param('code') code: string,
    @Body() body: SetPlanLimitsDto,
  ): Promise<PlanAdminView> {
    return this.plans.setLimits(code, body.limits);
  }

  /**
   * Replace a plan's capability flags (B10).
   *
   * ⚠️ **Turning one off takes the screen away from every tenant on the plan at
   * once**, because `PlanFeatureGuard` reads `plans.features` live — the same
   * absence of a renewal boundary as limits above.
   *
   * 📌 **PUT for the same reason as limits**: an omitted key is how a plan stops
   * including a feature, since an absent key reads as off.
   */
  @Put(':code/features')
  @RequireStaffRole(StaffRole.SUPER_ADMIN, StaffRole.BILLING_OPS)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async setFeatures(
    @Param('code') code: string,
    @Body() body: SetPlanFeaturesDto,
  ): Promise<PlanAdminView> {
    return this.plans.setFeatures(code, body.features);
  }
}
