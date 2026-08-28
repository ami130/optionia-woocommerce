import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

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
@UseGuards(StoreTokenGuard)
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
}
