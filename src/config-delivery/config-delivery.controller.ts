import { Controller, Get, Headers, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { SiteMatchGuard } from '../auth/guards/site-match.guard';
import { StoreRoute } from '../auth/guards/store-route.decorator';
import { StoreTokenGuard } from '../auth/guards/store-token.guard';
import { getStoreId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import type { ConfigDocument } from '../option-sets/serialization/projections';
import { ConfigDeliveryService } from './config-delivery.service';

/**
 * The document a storefront renders from (M9.1).
 *
 * Guarded exactly as the heartbeat is: `StoreTokenGuard` resolves the store
 * from the credential, `SiteMatchGuard` then checks the request came from that
 * store's address. Order matters — the second needs what the first put in
 * context.
 *
 * `@StoreRoute()` rather than `@Public()`: the marker tells the isolation gate
 * this route is authenticated by a store credential rather than left open, and
 * a route carrying it without `StoreTokenGuard` reaches the handler with no
 * store in context — unusable rather than unprotected.
 */
@Controller('store')
@StoreRoute()
@UseGuards(StoreTokenGuard, SiteMatchGuard)
@ApiBearerAuth('store')
export class ConfigDeliveryController {
  constructor(private readonly service: ConfigDeliveryService) {}

  /**
   * Fetch the store's configuration, conditionally.
   *
   * ## Why `@Res({ passthrough: true })`
   *
   * A 304 carries **no body** (RFC 9110 §15.4.5), and this API wraps every
   * returned value in the `{data, meta}` envelope. Returning `undefined` would
   * not help: the interceptor turns that into `{data: null, meta}`, so the
   * response would carry a body the status forbids.
   *
   * The handler therefore writes the 304 itself and returns nothing, which
   * ends the response before the interceptor sees a payload. On the 200 path it
   * only sets headers and returns the document, so the envelope still applies —
   * the plugin unwraps it like every other response.
   *
   * ## What the e2e tests can and cannot prove here
   *
   * Nest and Express run their **own** freshness check against the `ETag`
   * header this handler sets, and answer `304` when it matches whatever the
   * client sent. So a request-level test asserting `304` passes whether or not
   * this code decided anything — measured directly: with the ETag comparison
   * deliberately broken, `matchesEtag` returned `false`, this handler sent
   * `200` with a full document, and the client still observed `304`.
   *
   * Two consequences, both deliberate:
   *
   * - The **weak comparison** is asserted against `matchesEtag` directly rather
   *   than through a request, because only the unit assertion can fail.
   * - The **cost** of a conditional request is asserted by counting queries, not
   *   by reading a status code — the framework's `304` is free, but building a
   *   document to discard it is not, and that is the waste worth preventing.
   *
   * The handler still ends the response itself rather than leaning on that
   * behaviour: relying on a framework to hide a body this code should not have
   * produced would be correct by accident.
   *
   * ## Rate limit
   *
   * 120 per hour: a fifteen-minute cron is 4, and the rest is headroom for
   * push-triggered pulls, a merchant pressing "Sync now", and retries. Well
   * below anything that would let a misbehaving install hammer the endpoint.
   */
  @Get('config')
  @Throttle({ default: { limit: 120, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The store configuration document.' })
  @ApiResponse({ status: 304, description: 'The presented ETag is current; no body is sent.' })
  @ApiErrors(200, 401, 404, 429)
  async config(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConfigDocument | undefined> {
    const storeId = getStoreId();

    if (!storeId) {
      /**
       * Unreachable while `StoreTokenGuard` runs, and asserted anyway: a route
       * that lost its guard would otherwise serve one store's configuration to
       * whoever asked.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    const result = await this.service.deliver(storeId, ifNoneMatch);

    response.setHeader('ETag', result.etag);

    /**
     * `private`: this document belongs to one store and must never be held by
     * a shared cache. `must-revalidate` keeps the plugin's own conditional
     * request honest rather than letting an intermediary answer from a copy.
     */
    response.setHeader('Cache-Control', 'private, no-cache, must-revalidate');

    if (result.kind === 'not-modified') {
      response.status(304).end();

      return undefined;
    }

    return result.document;
  }
}
