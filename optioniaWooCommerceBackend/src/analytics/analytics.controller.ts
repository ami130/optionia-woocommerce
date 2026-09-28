import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { getContext } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { PlanFeatureGuard } from '../usage/plan-feature.guard';
import { AnalyticsService, type AnalyticsSummary } from './analytics.service';

/**
 * What a merchant's options earned (M25.3).
 *
 * ## Two gates, answering different questions
 *
 * 🔴 **`ANALYTICS_VIEW` asks *may this person*; `PlanFeatureGuard` asks *does
 * this tenant's plan include it*.** A viewer on Business passes the first and
 * the second; an owner on Free passes the first and fails the second. Collapsing
 * them would make an upgrade prompt indistinguishable from a permissions error,
 * and the remedies are opposite — *ask someone else* against *change the plan*.
 *
 * ⚠️ **This route is why `PlanFeatureGuard` exists, and it shipped a commit
 * before this one with NO caller.** `plans.features` carried `analytics` from
 * Phase 22 and nothing read it; the guard was built in 25-0 and deliberately
 * left unticked because a guard with fifteen passing tests and no route
 * invoking it is F130 exactly. This is the caller, and
 * `analytics-http.e2e-spec` asserts the refusal **over HTTP** rather than at the
 * service, because a service-level test would pass on an unwired route.
 *
 * ## Why the tenant is never a parameter
 *
 * It comes from the request context, so there is no id for a caller to
 * substitute and cross-tenant reads are unrepresentable rather than merely
 * refused (ADR-010).
 */
@Controller('analytics')
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class AnalyticsController {
  constructor(
    private readonly service: AnalyticsService,
    private readonly planFeatures: PlanFeatureGuard,
  ) {}

  /**
   * Everything the analytics screen renders.
   *
   * 📌 **One endpoint rather than four.** The four sections answer one question
   * — *which options make money and which are ignored* — and splitting them
   * would let a merchant see revenue computed at one moment beside dead options
   * computed at another, which reads as a contradiction rather than as a lag.
   */
  @Get()
  @RequireCapability(Capability.ANALYTICS_VIEW)
  @ApiOkResponse({ description: 'Option revenue, chosen values, and unused options.' })
  @ApiErrors(200, 401, 403, 429)
  async summary(): Promise<AnalyticsSummary> {
    const tenantId = getContext()?.tenantId;

    if (!tenantId) {
      /*
       * Unreachable behind `TenantGuard`, and asserted rather than assumed: a
       * later change to the guard chain that dropped the tenant would otherwise
       * make this query `WHERE s.tenantId = undefined`, which MySQL answers with
       * an empty set — a merchant shown "no data" instead of an auth failure.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    /*
     * 🔴 **Before the read, not after.** A refusal that arrives with the data
     * already fetched has still done the work, and on a plan that does not
     * include analytics the work is the thing being sold.
     */
    await this.planFeatures.assertHasFeature(tenantId, 'analytics');

    return this.service.summary(tenantId);
  }
}
