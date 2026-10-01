import { clampInside } from '@shared/design/layer-geometry';

import type { EditorLayer } from './layer.types';

/**
 * Editor-side style geometry — the WRITE half of the fit modes.
 *
 * 🔴 **This is not a duplicate of `layerRect`, and the distinction took reading
 * both to see.** They sit on opposite sides of persistence:
 *
 * - `layerRect` (shared) **reads** a stored layer and returns where it renders.
 *   It runs on every surface, every render.
 * - `applyStyleGeometry` **writes** a layer in place when its style changes or
 *   the canvas resizes. It runs at exactly two moments.
 *
 * ⚠️ **They must still agree for `cover`, `fit`, `fullw` and `fullh`**, because
 * a merchant who picks "cover" in the editor must see the same box the print
 * file renders. Nothing enforced that in `optionia-app` — each file carried a
 * comment pointing at the other, which is the arrangement that produced this
 * project's `1.25` line-height and `'month' | 'year'` defects.
 * `style-geometry.spec.ts` asserts it instead, and `check-fit-modes.sh` fails if
 * either grows a branch the other lacks.
 *
 * 📌 **`free` is deliberately NOT shared.** Here it picks a sensible DEFAULT
 * size for a newly added layer; in `layerRect` it returns the stored box. The
 * store never calls this for a free layer — `if (layer.style !== 'free')` — so
 * the asymmetry is unreachable rather than a disagreement.
 */

/** Logical canvas height; the width follows the background's aspect. */
export const CANVAS_BASE_H = 460;

/**
 * The size a newly added `free` layer takes: half the canvas on whichever axis
 * constrains it, keeping the image's own aspect.
 *
 * 📌 **A sizing POLICY, not geometry.** It decides an initial value and never a
 * rendered one, which is why it lives here rather than in the shared tree.
 */
export function freeDefaultSize(
  natW: number,
  natH: number,
  cw: number,
  ch: number,
): { w: number; h: number } {
  const layerRatio = natW > 0 && natH > 0 ? natW / natH : 1;
  const bgRatio = cw > 0 && ch > 0 ? cw / ch : 1;

  if (bgRatio > layerRatio) {
    const h = ch * 0.5;

    return { w: h * layerRatio, h };
  }

  const w = cw * 0.5;

  return { w, h: w / layerRatio };
}

/**
 * Re-fit a layer to the canvas for its style, in place.
 *
 * ⚠️ **Mutates `layer`.** The store calls this during a canvas resize and when a
 * style changes, then notifies once — returning a new object per layer would
 * allocate on every pointer-driven resize for no benefit.
 */
export function applyStyleGeometry(
  layer: EditorLayer,
  cw: number,
  ch: number,
): void {
  const aspect = layer.natW / layer.natH;

  /*
   * ⚠️ **`square` and `image` frames are FREELY sized rectangles**, so they fit
   * by the FRAME's own aspect rather than the image's. A custom PNG mask shares
   * that geometry — its w/h are trusted, and the resize interaction keeps it at
   * the PNG's aspect.
   */
  if (layer.shape === 'square' || layer.shape === 'image') {
    const frameAspect = (layer.h ? layer.w / layer.h : 1) || 1;

    if (layer.style === 'cover') {
      const s = Math.max(cw / (layer.w || 1), ch / (layer.h || 1));

      layer.w *= s;
      layer.h *= s;
      layer.cx = cw / 2;
      layer.cy = ch / 2;
      layer.rot = 0;
    } else if (layer.style === 'fit') {
      const s = Math.min(cw / (layer.w || 1), ch / (layer.h || 1));

      layer.w *= s;
      layer.h *= s;
      /*
       * 📌 **The moved centre is KEPT, clamped.** A dragged `fit` frame
       * remembers where the merchant put it across a re-open, which is how
       * `fullw`/`fullh` behave on their free axis too.
       */
      layer.cx = clampInside(layer.cx, layer.w / 2, cw);
      layer.cy = clampInside(layer.cy, layer.h / 2, ch);
      layer.rot = 0;
    } else if (layer.style === 'fullw') {
      layer.w = cw;
      layer.h = cw / frameAspect;
      layer.cx = cw / 2;
      layer.rot = 0;
    } else if (layer.style === 'fullh') {
      layer.h = ch;
      layer.w = ch * frameAspect;
      layer.cy = ch / 2;
      layer.rot = 0;
    }

    /* free: keep the stored size and position. */
    return;
  }

  /* Every other frame is a ratio-locked SQUARE (w === h). */
  if (layer.shape !== 'none') {
    let side: number;

    if (layer.style === 'cover') {
      side = Math.max(cw, ch);
      layer.cx = cw / 2;
      layer.cy = ch / 2;
      layer.rot = 0;
    } else if (layer.style === 'fit') {
      side = Math.min(cw, ch);
      layer.cx = clampInside(layer.cx, side / 2, cw);
      layer.cy = clampInside(layer.cy, side / 2, ch);
      layer.rot = 0;
    } else if (layer.style === 'fullw') {
      side = cw;
      layer.cx = cw / 2;
      layer.rot = 0;
    } else if (layer.style === 'fullh') {
      side = ch;
      layer.cy = ch / 2;
      layer.rot = 0;
    } else {
      /* free: keep the stored size. */
      side = Math.min(layer.w, layer.h) || layer.w;
    }

    layer.w = side;
    layer.h = side;

    return;
  }

  /* A plain layer fits by the IMAGE's natural aspect. */
  if (layer.style === 'cover') {
    const scale = Math.max(cw / layer.natW, ch / layer.natH);

    layer.w = layer.natW * scale;
    layer.h = layer.natH * scale;
    layer.cx = cw / 2;
    layer.cy = ch / 2;
    layer.rot = 0;
  } else if (layer.style === 'fit') {
    const scale = Math.min(cw / layer.natW, ch / layer.natH);

    layer.w = layer.natW * scale;
    layer.h = layer.natH * scale;
    layer.cx = clampInside(layer.cx, layer.w / 2, cw);
    layer.cy = clampInside(layer.cy, layer.h / 2, ch);
    layer.rot = 0;
  } else if (layer.style === 'fullw') {
    layer.w = cw;
    layer.h = cw / aspect;
    layer.cx = cw / 2;
    layer.rot = 0;
  } else if (layer.style === 'fullh') {
    layer.h = ch;
    layer.w = ch * aspect;
    layer.cy = ch / 2;
    layer.rot = 0;
  } else if (layer.style === 'free') {
    /*
     * 🔴 **The one branch that does NOT mirror `layerRect`.** Here `free` picks
     * a default size for a newly added layer; there it returns the stored box.
     * The store never calls this for a free layer, so the two never disagree in
     * practice — recorded rather than reconciled, because reconciling them would
     * mean one of the two behaviours becoming wrong.
     */
    const size = freeDefaultSize(layer.natW, layer.natH, cw, ch);

    layer.w = size.w;
    layer.h = size.h;
  }
}
