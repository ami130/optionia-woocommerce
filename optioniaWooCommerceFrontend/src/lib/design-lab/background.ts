import type { DesignImage } from '@shared/design/design-geometry.types';

import { isVectorImage } from './layer-source';

/**
 * The product photo a design is composed over.
 *
 * 🔴 **Why this exists.** The Design Lab opened on a blank 392×464 canvas
 * because nothing supplied a background, so a merchant placed artwork without
 * seeing what it sat on. The data was already there — Phase 19 syncs every
 * product with its `imageUrl` — and M26d.5's asset library turned out to be the
 * wrong place to look for it: that milestone is about merchant UPLOADS, needs
 * storage the SaaS does not have, and has an open architectural question
 * (ADR-040) at its centre. A product's own photo needs none of that.
 *
 * ⚠️ **The stored design does not change.** Geometry is fractions of the canvas,
 * so a design composed against a tall photo re-places correctly against a square
 * one. What a background changes is what the merchant SEES while composing, and
 * the canvas aspect they see it at.
 */

/** A product as the dashboard knows it — only the fields a background needs. */
export interface BackgroundSource {
  readonly name: string;
  readonly imageUrl: string | null;
}

/**
 * Whether a product can supply a background.
 *
 * 📌 **A product with no photo is the ordinary case**, not an error: a synced
 * catalogue carries plenty of them. The lab falls back to a blank canvas, which
 * is what it did before this existed.
 */
export function canBeBackground(product: BackgroundSource | null): boolean {
  if (product === null || typeof product.imageUrl !== 'string' || product.imageUrl === '') {
    return false;
  }

  /*
   * 🔴 **SVG is refused here as it is on the layer path**, through the SAME
   * function. M26d.5 states the rule — *"a design lab is not a reason to accept
   * an XSS vector"* — and a backdrop is drawn by the same canvas and reaches the
   * same server-side rasteriser. A second copy of the test would be two rules
   * that agree until one is edited.
   */
  return !isVectorImage(product.imageUrl);
}

/**
 * Build the background from a product and the dimensions a browser measured.
 *
 * 🔴 **The dimensions cannot come from the product record.** Phase 19 syncs a
 * URL and no size, and `DesignImage` needs `natW`/`natH` because the canvas
 * adopts the photo's aspect — `setCanvasSize` divides by them. Only loading the
 * image yields those, which is why this takes them rather than fetching.
 *
 * ⚠️ **A zero or missing dimension falls back to 1, never to zero.** The store
 * computes `natW / natH`, and a zero height is a division that silently produces
 * Infinity and a canvas width of NaN — which renders as nothing at all, with no
 * error anywhere.
 */
export function backgroundFor(
  product: BackgroundSource | null,
  natural: { width: number; height: number },
): DesignImage | null {
  /*
   * 📌 Narrowed explicitly rather than with `!`. An assertion would keep
   * compiling if `canBeBackground` ever stopped implying a non-null URL, and
   * would then put `null` into `src` at runtime.
   */
  if (product === null || product.imageUrl === null || product.imageUrl === '') {
    return null;
  }

  /*
   * 🔴 **The SVG rule again, because this function is exported separately.**
   * Narrowing above repeats `canBeBackground`'s null checks and did NOT repeat
   * this one — so a caller reaching here directly got an SVG background while
   * `canBeBackground` refused it. Caught by a test written for exactly that
   * shape, after the identical gap in the empty-URL check.
   */
  if (isVectorImage(product.imageUrl)) {
    return null;
  }

  return {
    src: product.imageUrl,
    name: product.name || 'Product photo',
    natW: natural.width > 0 ? natural.width : 1,
    natH: natural.height > 0 ? natural.height : 1,
  };
}
