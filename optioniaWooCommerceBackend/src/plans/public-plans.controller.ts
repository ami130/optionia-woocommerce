import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { Public } from '../auth/guards/public.decorator';
import { PlansAdminService, type PlanAdminView } from './plans-admin.service';

/**
 * What Optionia costs, to anyone.
 *
 * 🔴 **Its own controller, because `@Public()` alone would not have been
 * enough.** The first attempt put this route on `BillingController`, which
 * applies `JwtAuthGuard, TenantGuard, CapabilityGuard` at class level.
 * `@Public()` is read by `JwtAuthGuard` — and `TenantGuard` does not consult it,
 * so the route would still have refused a signed-out visitor with a 401. A
 * public route on an authenticated controller is public in name only.
 *
 * ⚠️ **No guards at all, and nothing here needs them.** The handler takes no
 * argument, reads no tenant and returns platform data — the plans on sale and
 * their current prices. There is no caller identity for it to respect.
 */
/*
 * 📌 **`@Public()` at CLASS level, not on the method.** Every route here is
 * public by construction, and the OpenAPI gate reads the class-level marker to
 * decide which operations may omit a security scheme — a method-level marker
 * left this looking like an operation that had simply forgotten to declare a
 * realm, which is the defect that check exists to catch.
 */
@Public()
@ApiTags('plans')
@Controller('plans')
export class PublicPlansController {
  constructor(private readonly plans: PlansAdminService) {}

  /**
   * The plans a prospect may buy, for the pricing page.
   *
   * 📌 **The SAME `listPublic()` the in-app list uses**, deliberately. It
   * already excludes plans hidden from signup and prices with no provider link —
   * its name and filter were written for exactly this — so the public page and
   * the merchant's own plan picker cannot disagree about what is on sale. Two
   * queries would be two answers to one question.
   *
   * ⚠️ **Rate limited, unlike the health probe.** An unauthenticated route that
   * runs two queries is worth a bucket: 120 an hour per address is far above
   * what a person reading a pricing page needs, and far below what would make
   * hammering it useful.
   */
  @Get()
  @Throttle({ default: { limit: 120, ttl: 3_600_000 } })
  @ApiErrors(200, 429)
  async list(): Promise<PlanAdminView[]> {
    return this.plans.listPublic();
  }
}
