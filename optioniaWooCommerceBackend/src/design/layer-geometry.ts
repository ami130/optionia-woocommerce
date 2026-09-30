import type { DesignLayer, LayerCrop, LayerShape, PathShape } from './design-geometry.types';

/**
 * Where a layer and its framed image sit on the canvas (M26c.1).
 *
 * ## Why this is ported rather than rewritten
 *
 * 🔴 **Every branch here is a resolved disagreement between rendering
 * surfaces.** `optionia-app` derived these across an editor canvas, a React SVG
 * preview, a string-serialised storefront overlay and a rasterised order image —
 * four surfaces that had to agree to the pixel. The plan calls re-deriving them
 * *"the most expensive avoidable work in this project"*, and the comments are
 * the part that cannot be recovered from the formulas.
 *
 * ## The coordinate model, in one sentence
 *
 * 🔴 **The viewBox is the background's natural pixel size, and every stored
 * position is a fraction of it** — so a design re-places exactly at any display
 * size and again at print resolution. Nothing here is an absolute length.
 */

/**
 * Each shape mask as a single SVG path in a 0..1 unit box.
 *
 * ⚠️ **Scaled to the frame rect with `userSpaceOnUse`, never
 * `objectBoundingBox`.** The image covers and overflows its frame, so a
 * bounding-box clip would resolve against the *image* and trim to the wrong
 * box — visible as artwork cropped somewhere the merchant never placed it.
 */
export const SHAPE_CLIP_PATHS: Record<PathShape, string> = {
  square: 'M0 0H1V1H0Z',
  rounded:
    'M0.12 0H0.88A0.12 0.12 0 0 1 1 0.12V0.88A0.12 0.12 0 0 1 0.88 1H0.12A0.12 0.12 0 0 1 0 0.88V0.12A0.12 0.12 0 0 1 0.12 0Z',
  circle: 'M0.5 0A0.5 0.5 0 1 1 0.5 1A0.5 0.5 0 1 1 0.5 0Z',
  heart:
    'M0.5 1C0.5 1 0 0.66 0 0.32C0 0.14 0.14 0 0.31 0C0.39 0 0.46 0.035 0.5 0.09C0.54 0.035 0.61 0 0.69 0C0.86 0 1 0.14 1 0.32C1 0.66 0.5 1 0.5 1Z',
  star: 'M0.5 0L0.6123 0.3455L0.9755 0.3455L0.6817 0.559L0.7939 0.9045L0.5 0.691L0.2061 0.9045L0.3183 0.559L0.0245 0.3455L0.3877 0.3455Z',
};

/** A resolved box on the canvas. */
export interface LayerRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
  readonly rot: number;
}

/**
 * Keep a box centred at `v` inside `[0, span]`.
 *
 * ⚠️ **A box LARGER than the span is kept covering it**, not clamped to the
 * middle — otherwise an oversized layer would reveal an empty edge the merchant
 * never asked for.
 */
export function clampInside(v: number, half: number, span: number): number {
  if (2 * half <= span) {
    return Math.max(half, Math.min(span - half, v));
  }

  return Math.max(span - half, Math.min(half, v));
}

/**
 * A layer's shape, with legacy data normalised.
 *
 * 🔴 **`square` once meant "no mask", and still does in older data.** Real
 * square frames always carry a crop; a stored `square` without one predates the
 * frame model and is a plain layer. A reader that skips this treats every such
 * design as masked and clips artwork that was never framed.
 *
 * ⚠️ **An `image` shape without its mask URL degrades to plain**, because a
 * custom PNG mask whose file is gone would otherwise clip the layer to nothing.
 */
export function effectiveShape(layer: {
  shape?: LayerShape;
  crop?: LayerCrop | null;
  shapeSrc?: string | null;
}): LayerShape {
  const shape = layer.shape ?? 'none';

  if (shape === 'square' && !(layer.crop && Number.isFinite(layer.crop.wPct))) {
    return 'none';
  }

  if (shape === 'image' && !layer.shapeSrc) {
    return 'none';
  }

  return shape;
}

/**
 * A document-unique id for one frame's clip path.
 *
 * 🔴 **Unique across the whole DOCUMENT, not the scene.** Several designs can
 * render on one page — a grid of choices, a preview beside an editor — and
 * `url(#id)` resolves against the document. Two scenes sharing an id means one
 * clips through the other's path, and the symptom is artwork cropped to a shape
 * the merchant never chose.
 *
 * ⚠️ **The colon strip is not cosmetic.** React's `useId()` returns values
 * containing `:`, which is not valid inside a `url(#…)` reference — so a
 * prefix taken straight from it produces a clip that silently does nothing and
 * a frame that shows its whole image.
 *
 * 📌 **Shared with the storefront and the order renderer**, which pass their own
 * prefixes. The id format has to agree across all three or a clip defined by one
 * surface is unreferenced by another.
 */
export function frameClipId(prefix: string, groupIndex: number, imageIndex: number): string {
  return `${prefix.replaceAll(':', '')}-dlf-${groupIndex}-${imageIndex}`;
}

/**
 * Where the image sits INSIDE a shape frame.
 *
 * 📌 **The frame is the image's canvas**, one level down: the crop's `style`
 * fits the image to the frame with the same rules the layer's own `style` uses
 * to fit the frame to the canvas.
 *
 * ⚠️ **The returned rect may overflow the frame** — the clip trims it, which is
 * what makes `cover` work at all.
 */
export function frameImageRect(
  layer: { natW: number; natH: number; crop?: LayerCrop | null },
  fx: number,
  fy: number,
  fw: number,
  fh: number,
): { x: number; y: number; w: number; h: number } {
  const natW = layer.natW || 1;
  const natH = layer.natH || 1;
  const aspect = natW / natH;

  /* ⚠️ Older crops predate the box model and lack `wPct` — treat as unset. */
  const crop = layer.crop && Number.isFinite(layer.crop.wPct) ? layer.crop : undefined;

  let w: number;
  let h: number;
  let cx: number;
  let cy: number;

  /*
   * 📌 **A stored box with no style predates the two-level model**, and is
   * treated as `free` because the box was placed deliberately. No crop at all
   * means a centred cover.
   */
  switch (crop ? (crop.style ?? 'free') : 'cover') {
    case 'cover': {
      const scale = Math.max(fw / natW, fh / natH);

      w = natW * scale;
      h = natH * scale;
      cx = fw / 2;
      cy = fh / 2;
      break;
    }

    case 'fit': {
      const scale = Math.min(fw / natW, fh / natH);

      w = natW * scale;
      h = natH * scale;

      /* Honour the stored pan so a fitted image can move within its letterbox. */
      cx = clampInside((crop?.xPct ?? 0.5) * fw, w / 2, fw);
      cy = clampInside((crop?.yPct ?? 0.5) * fh, h / 2, fh);
      break;
    }

    case 'fullw': {
      w = fw;
      h = w / aspect;
      cx = fw / 2;
      cy = (crop?.yPct ?? 0.5) * fh;
      break;
    }

    case 'fullh': {
      h = fh;
      w = h * aspect;
      cy = fh / 2;
      cx = (crop?.xPct ?? 0.5) * fw;
      break;
    }

    default: {
      /* free: the stored box, else a centred cover. */
      if (crop) {
        w = crop.wPct * fw;
        h = w / aspect;
        cx = crop.xPct * fw;
        cy = crop.yPct * fh;
      } else {
        const scale = Math.max(fw / natW, fh / natH);

        w = natW * scale;
        h = natH * scale;
        cx = fw / 2;
        cy = fh / 2;
      }
    }
  }

  return { x: fx + cx - w / 2, y: fy + cy - h / 2, w, h };
}

/**
 * Where a layer sits on the canvas, in viewBox pixels.
 *
 * 🔴 **Three geometries, not one**, and conflating them is the defect this
 * function exists to prevent:
 *
 * - **`square` and `image` frames are FREELY sized rectangles** — both stored
 *   fractions count, and the frame's own aspect drives `fullw`/`fullh`.
 * - **Every other frame is a RATIO-LOCKED square** (`w === h`), fitted to the
 *   canvas exactly like a plain layer's box, just squared.
 * - **A plain layer** uses the image's natural aspect.
 *
 * ⚠️ **Only `free` carries rotation.** Every other style zeroes it on apply, so
 * honouring a stored rotation here would rotate a layer the editor shows
 * straight.
 */
export function layerRect(layer: DesignLayer, vbW: number, vbH: number): LayerRect {
  const natW = layer.natW || 1;
  const natH = layer.natH || 1;
  const aspect = natW / natH;
  const shape = effectiveShape(layer);

  let w: number;
  let h: number;
  let cx: number;
  let cy: number;

  if (shape === 'square' || shape === 'image') {
    const fw0 = layer.pos.wPct * vbW;
    const fh0 = layer.pos.hPct > 0 ? layer.pos.hPct * vbH : fw0;
    const frameAspect = fw0 / (fh0 || 1);

    switch (layer.style) {
      case 'cover': {
        const s = Math.max(vbW / fw0, vbH / fh0);

        w = fw0 * s;
        h = fh0 * s;
        cx = vbW / 2;
        cy = vbH / 2;
        break;
      }

      case 'fit': {
        const s = Math.min(vbW / fw0, vbH / fh0);

        w = fw0 * s;
        h = fh0 * s;
        cx = clampInside(layer.pos.xPct * vbW, w / 2, vbW);
        cy = clampInside(layer.pos.yPct * vbH, h / 2, vbH);
        break;
      }

      case 'fullw':
        w = vbW;
        h = w / frameAspect;
        cx = vbW / 2;
        cy = layer.pos.yPct * vbH;
        break;

      case 'fullh':
        h = vbH;
        w = h * frameAspect;
        cy = vbH / 2;
        cx = layer.pos.xPct * vbW;
        break;

      default:
        w = fw0;
        h = fh0;
        cx = layer.pos.xPct * vbW;
        cy = layer.pos.yPct * vbH;
    }

    return rectOf(cx, cy, w, h, rotationOf(layer));
  }

  if (shape !== 'none') {
    let side: number;

    switch (layer.style) {
      case 'cover':
        side = Math.max(vbW, vbH);
        cx = vbW / 2;
        cy = vbH / 2;
        break;

      case 'fit':
        side = Math.min(vbW, vbH);
        cx = clampInside(layer.pos.xPct * vbW, side / 2, vbW);
        cy = clampInside(layer.pos.yPct * vbH, side / 2, vbH);
        break;

      case 'fullw':
        side = vbW;
        cx = vbW / 2;
        cy = layer.pos.yPct * vbH;
        break;

      case 'fullh':
        side = vbH;
        cy = vbH / 2;
        cx = layer.pos.xPct * vbW;
        break;

      default:
        side = layer.pos.wPct * vbW;
        cx = layer.pos.xPct * vbW;
        cy = layer.pos.yPct * vbH;
    }

    return rectOf(cx, cy, side, side, rotationOf(layer));
  }

  switch (layer.style) {
    case 'cover': {
      /* Fills the background and overflows; the SVG clips it. */
      const scale = Math.max(vbW / natW, vbH / natH);

      w = natW * scale;
      h = natH * scale;
      cx = vbW / 2;
      cy = vbH / 2;
      break;
    }

    case 'fit': {
      const scale = Math.min(vbW / natW, vbH / natH);

      w = natW * scale;
      h = natH * scale;

      /*
       * ⚠️ **The stored centre is honoured, clamped** — it matches the editor's
       * own apply step, so a preview and an order render at the saved position
       * rather than snapping to the middle.
       */
      cx = clampInside(layer.pos.xPct * vbW, w / 2, vbW);
      cy = clampInside(layer.pos.yPct * vbH, h / 2, vbH);
      break;
    }

    case 'fullw':
      w = vbW;
      h = w / aspect;
      cx = vbW / 2;
      cy = layer.pos.yPct * vbH;
      break;

    case 'fullh':
      h = vbH;
      w = h * aspect;
      cy = vbH / 2;
      cx = layer.pos.xPct * vbW;
      break;

    default:
      /* free: the stored centre and width, height by the image's aspect. */
      w = layer.pos.wPct * vbW;
      h = w / aspect;
      cx = layer.pos.xPct * vbW;
      cy = layer.pos.yPct * vbH;
  }

  return rectOf(cx, cy, w, h, rotationOf(layer));
}

function rectOf(cx: number, cy: number, w: number, h: number, rot: number): LayerRect {
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, rot };
}

/** Only `free` layers rotate; every other style zeroes it on apply. */
function rotationOf(layer: DesignLayer): number {
  return layer.style === 'free' ? (layer.rot ?? 0) : 0;
}
