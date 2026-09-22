import { Body, Controller, Delete, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { SiteMatchGuard } from '../auth/guards/site-match.guard';
import { StoreRoute } from '../auth/guards/store-route.decorator';
import { StoreTokenGuard } from '../auth/guards/store-token.guard';
import { getStoreId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import {
  CatalogueIngestService,
  type IngestResult,
  type ReconcileResult,
  type RemoveResult,
} from './catalogue-ingest.service';
import { IngestProductsDto } from './dto/ingest-products.dto';
import { ReconcileProductsDto } from './dto/reconcile-products.dto';

/**
 * Catalogue ingest (M19.1).
 *
 * Guarded exactly as `POST /store/orders` is, and in the same order:
 * `StoreTokenGuard` resolves the store from the credential, then
 * `SiteMatchGuard` checks the request came from that store's address. The
 * second reads what the first put in context, so the order is load-bearing.
 *
 * 🔴 **`POST /orders` is the precedent, not an analogy** (ADR-067). It is a
 * store-authenticated write of store facts behind those two guards; this is the
 * same shape with a different payload.
 */
@Controller('store')
@StoreRoute()
@UseGuards(StoreTokenGuard, SiteMatchGuard)
@ApiBearerAuth('store')
export class CatalogueIngestController {
  constructor(private readonly service: CatalogueIngestService) {}

  /**
   * Accept one batch of the store's catalogue.
   *
   * ## Why 200 rather than 201
   *
   * The call is idempotent — a re-push of the same products updates rows rather
   * than creating them — so a retry after a lost response answers the same 200
   * as the first delivery. The plugin acts on one bit either way: stop
   * retrying, advance the cursor.
   *
   * ## Rate limit
   *
   * 300 per hour per credential, matching `POST /orders`. ⚠️ **Nowhere near
   * binding, and that is deliberate.** The push runs on the plugin's 900-second
   * schedule — four requests an hour — so this leaves room for reconciliation
   * (M19.3), for an incremental sync (M19.2) sharing the endpoint, and for
   * retries, while still bounding a store that misbehaves.
   *
   * A store that does exceed it is not lost: the cursor holds its position and
   * the next run resumes from there, so a 429 delays a batch rather than
   * dropping products.
   */
  @Post('products')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The batch was written.' })
  @ApiErrors(200, 400, 401, 413, 429)
  async ingest(@Body() dto: IngestProductsDto): Promise<IngestResult> {
    const storeId = getStoreId();

    if (!storeId) {
      /*
       * Unreachable while `StoreTokenGuard` runs, and asserted anyway: a route
       * that lost its guard would otherwise let one store overwrite another's
       * catalogue — the whole of AC8 in a single missing decorator.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return this.service.ingest(storeId, dto);
  }

  /**
   * Reconcile one page of the store's ids against the mirror (M19.3).
   *
   * 🔴 **The store is the authority on what exists** (ADR-067). The cloud
   * cannot detect a product it has never heard of, so the sweep is driven from
   * the plugin: it sends the ids it holds, and this reports — and on the final
   * page removes — the rows the store did not claim.
   *
   * ⚠️ **A non-final page never deletes.** Absence from a *page* is not
   * absence from the store, and treating it as such would delete a catalogue
   * during an ordinary paged sweep (ADR-075).
   *
   * ## Rate limit
   *
   * Its own bucket, and a generous one: a 100k catalogue is **ten** requests at
   * 10,000 ids each, and the sweep runs daily. The limit exists to bound a
   * store that misbehaves, not to pace one that does not.
   */
  @Post('products/reconcile')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The page was compared against the mirror.' })
  @ApiErrors(200, 400, 401, 413, 429)
  async reconcile(@Body() dto: ReconcileProductsDto): Promise<ReconcileResult> {
    const storeId = getStoreId();

    if (!storeId) {
      /* Same assertion as the ingest: a route without its guard is AC8 gone. */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return this.service.reconcile(storeId, dto);
  }

  /**
   * Remove one product from the mirror (M19.2).
   *
   * 🔴 **Both of WooCommerce's endings arrive here** (ADR-074).
   * `woocommerce_delete_product` removes the row from WordPress;
   * `woocommerce_trash_product` leaves it with `post_status = trash`, which the
   * catalogue walk **excludes**. Mirroring trash as a status would leave the
   * walk and the increment disagreeing about the same product, so both mean
   * *remove*.
   *
   * ## Why 200 rather than 204
   *
   * The response carries `removed`, which separates a real deletion from a
   * redelivery in the plugin's log. A 204 would make the two indistinguishable
   * — and a queue that can deliver twice is exactly what this endpoint takes.
   *
   * ⚠️ **Removing something that was never here is a 200, not a 404.** The
   * plugin queues a deletion for a product that may never have been pushed —
   * deleted before its first walk reached it — and a 404 would make it retry a
   * request whose desired end state already holds.
   *
   * ## Rate limit
   *
   * Shares the ingest's 300 per hour. A bulk delete of a hundred products is
   * one drain of the plugin's queue, not a hundred separate wake-ups.
   */
  @Delete('products/:externalId')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The product is not in the mirror.' })
  @ApiErrors(200, 401, 429)
  async remove(@Param('externalId') externalId: string): Promise<RemoveResult> {
    const storeId = getStoreId();

    if (!storeId) {
      /* Same assertion as the ingest: a route without its guard is AC8 gone. */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    return this.service.remove(storeId, externalId);
  }
}
