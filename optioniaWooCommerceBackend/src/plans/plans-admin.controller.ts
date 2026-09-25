import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { RequireStaffRole, StaffGuard } from '../admin/staff.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffRole } from '../common/database/enums';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { SetPlanPriceDto, SetPlanVisibilityDto } from './dto/plans-admin.dto';
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
}
