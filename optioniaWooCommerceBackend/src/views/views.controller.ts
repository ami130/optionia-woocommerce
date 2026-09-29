import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { StoreRoute } from '../auth/guards/store-route.decorator';
import { SiteMatchGuard } from '../auth/guards/site-match.guard';
import { StoreTokenGuard } from '../auth/guards/store-token.guard';
import { getStoreId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { ReportViewsDto } from './dto/report-views.dto';
import { ViewsService } from './views.service';

/**
 * How many customers saw each option (M25.1, stage 25-4).
 *
 * ## Why this is a store route and not a public one
 *
 * 🔴 **A browser must never call this.** The design's first constraint is that
 * the store credential never reaches a customer's page — so a beacon posted
 * straight here would need either the secret in page source, readable by
 * anyone, or no authentication at all, which is a free tool for inflating or
 * poisoning any merchant's analytics.
 *
 * ⚠️ **The beacon goes to the merchant's OWN WordPress**, which aggregates and
 * drains here on cron with the credential it already holds. That is what keeps
 * this endpoint authenticated while the thing a customer's browser touches is
 * the site it is already on.
 *
 * ## Why the counts are deltas
 *
 * 📌 **The plugin clears its counter only after a 2xx**, so a failed drain
 * resends and a successful one has nothing left to send. `ViewsService` records
 * why that is the whole idempotency story and what it rests on.
 */
@Controller('store')
@StoreRoute()
@UseGuards(StoreTokenGuard, SiteMatchGuard)
@ApiBearerAuth('store')
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  /**
   * Record a batch of option view counts.
   *
   * ## Why 200 rather than 201
   *
   * The same reasoning as order reporting: the call may be retried after a lost
   * response, and a 201 would claim rows were created on a request that may have
   * created none. The plugin acts on one bit — *stop retrying* — and both
   * statuses say it.
   *
   * ## Rate limit
   *
   * 📌 **60 per hour, a fifth of the order route's, and deliberately lower.**
   * Views are aggregated before they are sent: however much traffic a shop has,
   * the drain runs on a schedule the plugin controls. A store needing more than
   * one drain a minute is misconfigured rather than busy — and unlike orders,
   * nothing is lost to a 429, because the plugin's counter is only cleared on
   * success.
   */
  @Post('views')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The view counts were added to this store’s totals.' })
  @ApiErrors(200, 400, 401, 429)
  async report(@Body() dto: ReportViewsDto): Promise<{ recorded: number }> {
    const storeId = getStoreId();

    if (!storeId) {
      /*
       * Unreachable while `StoreTokenGuard` runs, and asserted anyway — the
       * same defensive read `OrdersController` makes, for the same reason: a
       * route that silently wrote for no store would be worse than one that
       * failed.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return { recorded: await this.views.record(storeId, dto.views) };
  }
}
