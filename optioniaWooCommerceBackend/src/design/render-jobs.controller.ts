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
import { RequestRenderDto } from './dto/request-render.dto';
import { RenderJobsService, type AcceptedRender } from './render-jobs.service';

/**
 * Render requests from a store (M26e.4).
 *
 * Guarded exactly as the heartbeat, config delivery and order reporting are,
 * and in the same order: `StoreTokenGuard` resolves the store from the
 * credential, then `SiteMatchGuard` checks the request came from that store's
 * address. The second reads what the first put in context, so the order is
 * load-bearing.
 */
@Controller('store')
@StoreRoute()
@UseGuards(StoreTokenGuard, SiteMatchGuard)
@ApiBearerAuth('store')
export class RenderJobsController {
  constructor(private readonly service: RenderJobsService) {}

  /**
   * Ask for one print file.
   *
   * ## Why 200 rather than 202
   *
   * 202 would be the honest code for accepted-not-done, and it is the wrong
   * one here for the same reason `POST /store/orders` answers 200: the call is
   * idempotent, and a retry after a lost response must look identical to the
   * first delivery. The plugin acts on one thing — *stop retrying* — and
   * cannot tell a fresh acceptance from a repeat anyway. The body says which
   * it was, for anyone diagnosing a plugin that retries too much.
   *
   * ## Why a failure here must not fail a sale
   *
   * 🔴 **M26e.6's first rule: never block a sale on artwork generation.** A
   * 429, a 500 or a timeout means the plugin proceeds with the purchase and
   * has no preview — not that the customer cannot buy. That rule lives in the
   * plugin, and this route is written to make it easy to honour: nothing here
   * is required for checkout to complete.
   *
   * ## Rate limit
   *
   * 600 per hour per credential — double the order route's, because a cart can
   * hold several designed lines and each asks once. A store that legitimately
   * exceeds it is not lost: the render is a preview and a print file, neither
   * of which is on the purchase path, so a 429 delays artwork rather than
   * dropping an order.
   */
  @Post('renders')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The render was accepted, or already had been.' })
  @ApiErrors(200, 400, 401, 429)
  async request(@Body() dto: RequestRenderDto): Promise<AcceptedRender> {
    const storeId = getStoreId();

    if (!storeId) {
      /**
       * Unreachable while `StoreTokenGuard` runs, and asserted anyway: a route
       * that lost its guard would otherwise render one store's artwork against
       * whoever asked — and bill the work to the wrong tenant.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return this.service.accept(storeId, {
      lineRef: dto.line_ref,
      scene: dto.scene,
      width: dto.width,
      height: dto.height,
    });
  }
}
