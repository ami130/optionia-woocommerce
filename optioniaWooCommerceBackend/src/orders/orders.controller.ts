import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { SiteMatchGuard } from '../auth/guards/site-match.guard';
import { StoreRoute } from '../auth/guards/store-route.decorator';
import { StoreTokenGuard } from '../auth/guards/store-token.guard';
import { getStoreId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { ReportOrderDto } from './dto/report-order.dto';
import { OrdersService, type ReportOrderResult } from './orders.service';

/**
 * Order reporting (M12.7).
 *
 * Guarded exactly as the heartbeat and config delivery are, and in the same
 * order: `StoreTokenGuard` resolves the store from the credential, then
 * `SiteMatchGuard` checks the request came from that store's address. The
 * second reads what the first put in context, so the order is load-bearing.
 */
@Controller('store')
@StoreRoute()
@UseGuards(StoreTokenGuard, SiteMatchGuard)
@ApiBearerAuth('store')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  /**
   * Record one completed order.
   *
   * ## Why 200 rather than 201
   *
   * The call is idempotent, so a retry after a lost response returns the same
   * 200 as the first delivery. A 201 would claim a row was created on a request
   * that created nothing, and the plugin cannot tell the two apart anyway —
   * both mean "stop retrying", which is the only thing it acts on.
   *
   * ## Rate limit
   *
   * 300 per hour per credential. A store reports one request per order, and the
   * plugin batches nothing, so this is a real order rate plus retries — a busy
   * shop at five orders a minute still fits. The throttler keys on the
   * credential hash because it runs ahead of authentication, and a credential
   * belongs to one store.
   *
   * A store that legitimately exceeds this is not lost: the plugin's queue
   * holds unreported orders and drains them on the next run, so a 429 delays a
   * report rather than dropping it.
   */
  @Post('orders')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The order was recorded, or already had been.' })
  @ApiErrors(200, 400, 401, 429)
  async report(@Body() dto: ReportOrderDto): Promise<ReportOrderResult> {
    const storeId = getStoreId();

    if (!storeId) {
      /**
       * Unreachable while `StoreTokenGuard` runs, and asserted anyway: a route
       * that lost its guard would otherwise attribute one store's revenue to
       * whoever asked.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return this.service.report(storeId, dto);
  }
}
