import { Resvg } from '@resvg/resvg-js';

import {
  MAX_RENDER_MS,
  checkRenderBounds,
  type RenderBoundsFailure,
} from '../common/render/render-bounds';

/**
 * Rasterising a resolved scene to a flat image (M26e.4).
 *
 * 🔴 **The only place in this repository that calls a rasteriser.**
 * `check-render-bounds.sh` requires every file reaching one to name BOTH
 * `checkRenderBounds` and `MAX_RENDER_MS`, because an audit found half a guard
 * enforced and half not — and half a guard reads as a whole one.
 *
 * ⚠️ **An unbounded canvas is an OOM KILL, not an error.** The Stage 0 spike
 * measured a 50000×50000 input rendering successfully for 46 seconds and ~10 GB
 * of RGBA before the kernel intervened — and a kernel kill produces nothing the
 * application can catch, log or report. Three hostile inputs threw catchably;
 * the fourth succeeded, which is worse.
 *
 * 📌 **Text needs no outline conversion.** `resvg` draws `<textPath>` from a
 * font FILE, which is what removes `optionia-app`'s ~470-line glyph-outlining
 * subsystem — and why M26e.4's *"no font needs installing at render time"* is
 * met by shipping the files.
 */

/** What a caller gets back when a scene rasterises. */
export interface RasterResult {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  /** Wall-clock milliseconds the rasteriser itself took. */
  readonly ms: number;
}

/** Why a render was refused or failed, in terms an order can carry. */
export interface RasterFailure {
  readonly reason: RenderBoundsFailure['reason'] | 'render-failed' | 'timed-out';
  readonly message: string;
}

export type RasterOutcome =
  | { readonly ok: true; readonly result: RasterResult }
  | { readonly ok: false; readonly failure: RasterFailure };

/**
 * The fonts a render may draw with.
 *
 * 🔴 **Explicit files, never the system's.** A render that silently depended on
 * whatever the host had installed would produce a different print file on a
 * laptop and on App Platform — and the merchant would find out from a customer.
 * `loadSystemFonts: false` is what makes the output reproducible.
 *
 * ⚠️ **A missing family falls back rather than vanishing**, measured in the
 * spike; Japanese renders as tofu boxes. Visibly wrong beats silently blank,
 * but it is still wrong — font coverage is a packaging decision (G2), not
 * something this module can fix.
 */
export interface RasterFonts {
  /** Absolute paths to the font files this render may use. */
  readonly files: readonly string[];
}

/**
 * Rasterise an SVG string to PNG, or say why not.
 *
 * 🔴 **The bounds are checked BEFORE a `Resvg` exists.** Constructing one with
 * a hostile canvas is the thing that cannot be undone — so the guard runs
 * against the caller's intended dimensions, not against anything the renderer
 * reports back.
 *
 * ⚠️ **`MAX_RENDER_MS` is enforced by MEASUREMENT, not by cancellation.**
 * `resvg` renders synchronously in a native call that no timer can interrupt;
 * promising a cancelling timeout would be a guard that cannot fire. What this
 * does is refuse to return a result that took longer than the ceiling, so a
 * runaway is recorded as a failure the order can act on rather than passing
 * silently as a success. The real protection against a runaway is the bound
 * above, which is why both exist.
 */
export function rasteriseScene(
  svg: string,
  width: number,
  height: number,
  fonts: RasterFonts,
): RasterOutcome {
  const refused = checkRenderBounds(width, height);

  if (refused !== null) {
    return { ok: false, failure: { reason: refused.reason, message: refused.message } };
  }

  const started = Date.now();

  let rendered: { png: Buffer; width: number; height: number };

  try {
    const resvg = new Resvg(svg, {
      /* 📌 Width alone: the scene's own viewBox decides the aspect. */
      fitTo: { mode: 'width', value: Math.round(width) },
      font: {
        loadSystemFonts: false,
        fontFiles: [...fonts.files],
      },
    });

    const image = resvg.render();

    rendered = { png: image.asPng(), width: image.width, height: image.height };
  } catch (error) {
    /*
     * ⚠️ **Malformed XML, billion laughs and an empty string all throw**, which
     * the spike verified — so this path is reachable by ordinary bad input and
     * is not a theoretical catch.
     */
    return {
      ok: false,
      failure: {
        reason: 'render-failed',
        message: error instanceof Error ? error.message : 'The scene could not be rendered.',
      },
    };
  }

  const ms = Date.now() - started;

  if (ms > MAX_RENDER_MS) {
    return {
      ok: false,
      failure: {
        reason: 'timed-out',
        message: `The render took ${ms}ms; the limit is ${MAX_RENDER_MS}ms.`,
      },
    };
  }

  return { ok: true, result: { ...rendered, ms } };
}
