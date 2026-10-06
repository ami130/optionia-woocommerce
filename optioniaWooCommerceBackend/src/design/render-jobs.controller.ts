import { Body, Controller, Get, Header, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProduces, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { SiteMatchGuard } from '../auth/guards/site-match.guard';
import { StoreRoute } from '../auth/guards/store-route.decorator';
import { StoreTokenGuard } from '../auth/guards/store-token.guard';
import { getStoreId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { checkRenderBounds } from '../common/render/render-bounds';
import { CollectedRenderDto } from './dto/collected-render.dto';
import { PreviewSceneDto } from './dto/preview-scene.dto';
import { RequestRenderDto } from './dto/request-render.dto';
import { buildScene, sceneToSvgString } from '@shared/design/design-scene';
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

  /**
   * The SVG a storefront overlays on the theme's product image (M26e.1).
   *
   * 🔴 **Built by the SHARED serializer — the same function the render worker
   * calls.** That is the entire reason this route exists rather than the
   * geometry being ported into plugin JavaScript: a second implementation of
   * the maths is a second thing to keep in step, and the moment it drifts the
   * customer approves one picture and the merchant prints another. M26e.1's
   * rule — *"no geometry computed in PHP"* — is honoured by the plugin
   * computing nothing at all.
   *
   * ⚠️ **Nothing is stored and nothing is queued.** A preview belongs to no
   * cart line, because a customer is still choosing; there is no idempotency
   * to preserve and no buffer to release. That is what separates this from
   * `POST renders`, which exists precisely to be a durable, idempotent
   * request.
   *
   * 📌 **The background node carries `data-design-bg`**, which the storefront
   * drops in overlay mode so the theme's real product image shows through
   * underneath. The shared serializer has emitted that marker since the scene
   * module was written; this route is what finally makes it reachable.
   *
   * ## Rate limit
   *
   * 1200 an hour — double the render routes', because a preview updates as a
   * customer types rather than once per line. A `429` costs a stale preview
   * for a moment, which is why it is a tolerable ceiling rather than a risk to
   * a sale: M26e.6's first rule is that artwork never blocks a purchase.
   */
  @Post('preview')
  @HttpCode(200)
  @Throttle({ default: { limit: 1200, ttl: 3_600_000 } })
  @Header('Content-Type', 'image/svg+xml')
  @ApiProduces('image/svg+xml')
  @ApiResponse({
    status: 200,
    description: 'The overlay SVG for this scene.',
    schema: { type: 'string' },
  })
  @ApiErrors(400, 401, 429)
  preview(@Body() dto: PreviewSceneDto, @Res() response: Response): void {
    const storeId = getStoreId();

    if (!storeId) {
      /*
       * Unreachable while `StoreTokenGuard` runs, and asserted anyway for the
       * reason `request()` above records: a route that lost its guard would
       * otherwise draw whatever scene it was handed for whoever asked.
       *
       * ⚠️ **An acknowledged equivalent mutant.** Removing this leaves every
       * test passing, because the guard refuses first — measured, not assumed.
       * It stays because the guard and this assertion protect the same
       * property by different means, and the cheaper one survives a future
       * decorator change.
       */
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    void storeId;

    /*
     * 🔴 **Bounded here too, though nothing is rasterised.** The dimensions
     * reach `viewBox` and every coordinate in the document; an unbounded
     * canvas produces a string no browser will mount, and letting preview and
     * print disagree about what is too large is how the two drift apart.
     */
    const refused = checkRenderBounds(dto.width, dto.height);

    if (refused !== null) {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, refused.message);
    }

    let svg: string;

    try {
      /*
       * 🔴 **`buildScene` resolves fractions to pixels**, exactly as the render
       * worker does. Without it this answered a valid but EMPTY `<svg>` for a
       * real composed scene — or threw, since `sceneToSvgString` reads
       * `images`/`texts` and the plugin sends `layers`/`textOptions`. Preview
       * and print file must come out of the same two calls, or the customer
       * approves one picture and the merchant prints another.
       */
      svg = sceneToSvgString(
        buildScene({ ...dto.scene, width: dto.width, height: dto.height } as never),
        'ov',
      );
    } catch {
      /*
       * ⚠️ **The serializer's own message is NOT returned.** It names internal
       * structure, and this route answers a storefront that reached it with a
       * store credential a customer's browser never sees — but the scene it
       * carries is shaped by whatever the plugin composed. A generic refusal
       * is what the caller can act on; the detail belongs in logs.
       */
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'That scene could not be drawn.',
      );
    }

    response.send(svg);
  }

  /**
   * Collect one rendered print file.
   *
   * 🔴 **The plugin PULLS; the cloud never pushes bytes.** Decision 3a chose
   * this shape because it is what M9.4 already proves safe — the inbound push
   * endpoint *"carries a version and nothing else"*, which is exactly what lets
   * it be a public route with a signature rather than a capability check. A
   * cloud that POSTed bytes to a public route would need that route to trust
   * its body.
   *
   * ⚠️ **A 404 covers four situations deliberately**: no such job, another
   * store's job, not yet rendered, already collected. A caller that could tell
   * them apart could enumerate other stores' job ids by the difference.
   *
   * ## Rate limit
   *
   * 600 an hour, matching the request route: a cart with several designed
   * lines collects once per line, and a retry after a lost response is normal.
   */
  @Get('renders/:id/file')
  @Throttle({ default: { limit: 600, ttl: 3_600_000 } })
  @Header('Content-Type', 'image/png')
  @ApiProduces('image/png')
  @ApiResponse({
    status: 200,
    description: 'The rendered print file.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiErrors(401, 404, 429)
  async file(@Param('id') id: string, @Res() response: Response): Promise<void> {
    const storeId = getStoreId();

    if (!storeId) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    const render = await this.service.collect(storeId, id);

    if (render === null) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'No collectable render for that id.');
    }

    /*
     * 📌 **`Content-Length` so the plugin can tell a truncated download from a
     * complete one.** A partially written print file is worse than a missing
     * one: it looks like a file and prints as damage.
     */
    response.setHeader('Content-Length', String(render.png.length));
    response.end(render.png);
  }

  /**
   * Confirm the plugin has stored it, and release the buffer.
   *
   * 🔴 **This is what ends the transfer**, and what makes `ready` mean
   * something. Until it arrives the bytes sit in the cloud's buffer and the job
   * reads `rendered`; after it, the merchant's WordPress holds the file.
   *
   * ⚠️ **The cloud learns the URL no other way.** Decision 3 put the permanent
   * home on the merchant's own server, so only the plugin knows where the file
   * landed.
   *
   * ## Why 200 rather than 204
   *
   * The call is idempotent and a retry must look identical to the first
   * delivery — the same reasoning the other two routes here record. A 204 would
   * also give the plugin nothing to distinguish "stored" from "there was
   * nothing to store".
   */
  @Post('renders/:id/collected')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 3_600_000 } })
  @ApiOkResponse({ description: 'The collection was recorded.' })
  @ApiErrors(200, 400, 401, 404, 429)
  async collected(
    @Param('id') id: string,
    @Body() dto: CollectedRenderDto,
  ): Promise<{ collected: true }> {
    const storeId = getStoreId();

    if (!storeId) {
      throw new DomainException(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }

    const recorded = await this.service.markCollected(storeId, id, dto.file_url);

    if (!recorded) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'No render job with that id.');
    }

    return { collected: true };
  }
}
