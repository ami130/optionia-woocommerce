import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

  /**
   * The same figures, as a spreadsheet (M25.5).
   *
   * ## Why a second route rather than a format parameter
   *
   * 📌 **A `?format=csv` on the summary would have to answer both shapes**, and
   * the two are not the same query: the screen is capped at fifty rows and this
   * is deliberately uncapped, because an export is for the whole dataset. One
   * route returning two different populations under one name is the kind of
   * thing that reads as a bug the first time somebody sums a column.
   *
   * ⚠️ **Gated identically to the summary**, on `ANALYTICS_VIEW` and on the
   * plan's `analytics` feature — and checked **before** the query runs. An
   * export is the most valuable read this service offers; a route that
   * refused only after building the file would have already done the work the
   * plan withholds.
   */
  @Get('export')
  @RequireCapability(Capability.ANALYTICS_VIEW)
  @ApiOkResponse({ description: 'Option revenue as CSV.' })
  @ApiErrors(200, 401, 403, 429)
  async exportCsv(@Res() response: Response): Promise<void> {
    const tenantId = getContext()?.tenantId;

    if (!tenantId) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    await this.planFeatures.assertHasFeature(tenantId, 'analytics');

    const csv = await this.service.exportOptionRevenue(tenantId);

    /*
     * 🔴 **`attachment`, and the date is in the filename.** A merchant exporting
     * twice in a month needs to tell the two apart, and a browser rendering CSV
     * inline shows them a wall of text rather than offering a download.
     *
     * 📌 **`text/csv; charset=utf-8` with a BOM.** Excel on Windows reads a
     * BOM-less UTF-8 file as the system codepage, which turns a merchant's
     * non-ASCII option label into mojibake in the one tool most of them open it
     * with.
     */
    const day = new Date().toISOString().slice(0, 10);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="optionia-option-revenue-${day}.csv"`,
    );

    response.send(`\uFEFF${csv}`);
  }
}
