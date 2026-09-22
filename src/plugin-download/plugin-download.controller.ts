import { Controller, Get, Header, Logger, Param, Res } from '@nestjs/common';
import { ApiProduces, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { Public } from '../auth/guards/public.decorator';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PluginDownloadService } from './plugin-download.service';

/** What the dashboard's install screen reads before offering the download. */
interface PluginRelease {
  version: string;
  filename: string;
  sizeBytes: number;
  downloadUrl: string;
}

/**
 * The plugin a merchant installs (M20b.3).
 *
 * ## Why this is public
 *
 * 🔴 **The plugin contains no secret, by design.** AC8 is explicit — "no SaaS
 * secret ever ships inside the plugin", and every installation is treated as
 * potentially hostile — so there is nothing here to protect with a login.
 *
 * And a login wall is a real cost at exactly the wrong moment: this milestone
 * calls the browser-tab-to-WordPress-admin journey "the weakest link", and a
 * merchant may well be installing from a WordPress admin on a machine where they
 * are not signed in to the dashboard. Guarding this would refuse the one file the
 * whole funnel depends on (ADR-095).
 */
@Controller('plugin')
@Public()
export class PluginDownloadController {
  private readonly logger = new Logger(PluginDownloadController.name);

  constructor(private readonly service: PluginDownloadService) {}

  /**
   * What the newest build is, without downloading it.
   *
   * The install screen reads this to name the version and size before a merchant
   * commits to a download — and to know whether to offer one at all.
   */
  @Get('latest')
  @ApiErrors(200, 404, 429)
  latest(): PluginRelease {
    const archive = this.service.latest();

    if (archive === null) {
      /*
       * Not an error state: a developer who has not run `bin/package.sh` has no
       * builds, and the honest answer is that there is nothing to download.
       */
      throw new DomainException(ErrorCode.NOT_FOUND, 'No plugin build is available.');
    }

    return {
      version: archive.version,
      filename: archive.filename,
      sizeBytes: archive.sizeBytes,
      downloadUrl: `/v1/plugin/download/${archive.version}`,
    };
  }

  /**
   * The zip itself.
   *
   * ⚠️ **The one route in this API that does not answer with the `{data, meta}`
   * envelope**, and it cannot: the body is a zip.
   *
   * ✏️ **Described in OpenAPI as a binary, not excluded from it.**
   * `@ApiExcludeEndpoint` was the first approach and it put two gates in
   * conflict: `check-api-contract` requires every `[built]` route to be
   * documented, and `check-openapi` then requires every documented `[built]`
   * route to appear in the generated spec. Hiding the route made it drift by the
   * second gate's definition. Declaring `application/zip` with a binary schema
   * says what it actually returns, which is what both gates are for.
   *
   * 📌 **Streamed, not read into memory.** The archive is small today, but a
   * route that buffers a file is one that stops working when the file grows, and
   * the fix is the same three lines either way.
   */
  @Get('download/:version')
  /**
   * 🔴 **The most expensive response in this API, on its only public file
   * route.** The global default is 300 per *minute* per IP, which at 432K is
   * roughly 130 MB a minute from one address with no authentication in front of
   * it. An hourly bucket is what every other costly route here already declares
   * — `catalogue-ingest` and `auth` both use exactly this shape.
   *
   * 300 an hour is still far above any real merchant: installing a plugin is
   * something done once, and retried a handful of times at worst.
   */
  @Throttle({ default: { limit: 300, ttl: 3_600_000 } })
  @Header('Content-Type', 'application/zip')
  @ApiProduces('application/zip')
  @ApiResponse({
    status: 200,
    description: 'The plugin archive.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiErrors(404, 429)
  download(@Param('version') version: string, @Res() response: Response): void {
    const archive = this.service.byVersion(version);

    if (archive === null) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'That plugin version is not available.');
    }

    /*
     * `attachment` rather than `inline`: a browser that renders a zip inline
     * shows a merchant a page of binary. The filename carries the version, so a
     * support conversation can ask "which file did you install?" and get an
     * answer.
     */
    response.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
    response.setHeader('Content-Length', String(archive.sizeBytes));

    const file = archive.stream();

    /**
     * 🔴 **An unhandled stream error takes down the whole process.**
     *
     * `existsSync` and `statSync` ran a moment ago, and the file can still stop
     * being readable before the first byte leaves: a deploy replacing `dist/`, a
     * log rotation, a permissions change. In Node a `ReadStream` that emits
     * `error` with **no listener** becomes an `uncaughtException` — verified
     * directly, `createReadStream('/missing').pipe(…)` prints `UNCAUGHT: ENOENT`
     * — so a missing file would not fail one merchant's download, it would drop
     * the API for everyone.
     *
     * ⚠️ **Destroyed, never re-answered.** The headers are already on the wire by
     * the time this can fire, and `AllExceptionsFilter` documents what writing
     * after `headersSent` costs: a half-written body left every later request on
     * that connection hanging until it timed out. So the response is destroyed,
     * which closes the connection and lets the client see a truncated download
     * for what it is, and the cause is logged rather than sent.
     */
    file.on('error', (error: Error) => {
      this.logger.error(`plugin download failed: ${archive.filename}: ${error.message}`);

      response.destroy(error);
    });

    file.pipe(response);
  }
}
