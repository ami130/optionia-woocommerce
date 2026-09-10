import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { SiteMatchGuard } from '../auth/guards/site-match.guard';
import { StoreRoute } from '../auth/guards/store-route.decorator';
import { StoreTokenGuard } from '../auth/guards/store-token.guard';
import { getStoreId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { StoresService, type HeartbeatResult } from './stores.service';

/**
 * The store realm's first route (M8.5).
 *
 * `@StoreRoute()` rather than `@Public()`: the marker tells the global
 * `JwtAuthGuard` to stand aside for a different realm, it does not waive
 * authentication. A route carrying it without `StoreTokenGuard` reaches the
 * handler with no realm, tenant or store — unusable rather than unprotected.
 */
@Controller('store')
@StoreRoute()
/**
 * `SiteMatchGuard` runs **after** `StoreTokenGuard`, and the order is the point:
 * the first resolves the store from the credential, the second checks the
 * request came from that store's address (M8.1b).
 */
@UseGuards(StoreTokenGuard, SiteMatchGuard)
@ApiBearerAuth('store')
export class StoreHeartbeatController {
  constructor(private readonly service: StoresService) {}

  /**
   * A daily authenticated ping: the support and analytics backbone.
   *
   * 60 per hour per store — a daily job with retries, not a stream. The
   * throttler keys on the hash of the presented credential, because it runs
   * ahead of authentication and `store_id` is not in context yet; a credential
   * belongs to one store, so the two are equivalent for rate limiting.
   */
  @Post('heartbeat')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 429)
  async heartbeat(@Body() dto: HeartbeatDto): Promise<HeartbeatResult> {
    const storeId = getStoreId();

    if (!storeId) {
      // Unreachable while `StoreTokenGuard` guards this route, and asserted
      // rather than assumed: a marker without its guard must fail closed.
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return this.service.heartbeat(storeId, dto);
  }

  /**
   * The plugin telling the cloud it is leaving (U8).
   *
   * ## Why this route has to exist
   *
   * 🔴 **A merchant pressing Disconnect in WordPress left a live credential
   * behind.** The plugin's own disconnect is *local* — it clears its token so a
   * merchant can always recover, even with the cloud unreachable — and nothing
   * told the backend. The store stayed `connected`, its credential stayed valid,
   * and the dashboard kept offering a Disconnect for a store already gone.
   *
   * Reconciling through the heartbeat cannot work: a disconnected plugin has
   * **deleted the very credential** the heartbeat authenticates with, so it can
   * never report in again. The message has to be sent *before* it forgets.
   *
   * ## Why it is safe
   *
   * It revokes only the credential that authenticated the call, so it can do
   * nothing a stolen token could not already do — and a thief revoking their own
   * access is the one abuse nobody minds. `SiteMatchGuard` still requires the
   * call to come from that store's own address.
   *
   * Idempotent, and answers `200` for a store already disconnected: the plugin
   * calls this on its way out and must not be blocked by the answer.
   */
  @Post('disconnect')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @ApiErrors(200, 401, 429)
  async disconnect(): Promise<{ disconnected: boolean }> {
    const storeId = getStoreId();

    if (!storeId) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    await this.service.disconnect(storeId);

    return { disconnected: true };
  }
}
