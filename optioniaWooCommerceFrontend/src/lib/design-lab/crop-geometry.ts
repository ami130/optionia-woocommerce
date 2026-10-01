import type { LayerCrop, LayerStyle } from '@shared/design/design-geometry.types';
import { clampInside, frameImageRect } from '@shared/design/layer-geometry';

import { MIN_LAYER_SIZE, type MoveAxes } from './drag-geometry';

/**
 * Where the image sits INSIDE its frame (M26d.2).
 *
 * 🔴 **The same decisions as `drag-geometry`, one level down.** A shaped layer
 * is two placements, not one: the frame sits on the canvas, and the image sits
 * in the frame. The plan calls this *"where most of the geometry complexity
 * lives"* — and the hard half, `frameImageRect`, is already in `shared/design`
 * and byte-verified against the renderer. What is missing is the EDITOR half:
 * which axes the image may pan along, and where a drag may put it.
 *
 * ⚠️ **The frame is the image's canvas.** `cropAxes` mirrors `moveAxes` and
 * `clampCropBox` mirrors `moveTo`, reading `crop.style` where the outer versions
 * read `layer.style`. That parallel is the point: the outer pair is already
 * tested and mutation-proven, so the inner pair follows a shape that works.
 *
 * 📌 **Stored as FRACTIONS of the frame**, like every other geometry in this
 * project — `xPct`, `yPct`, `wPct`. The editor works in frame pixels and
 * converts at the boundary, exactly as the canvas does.
 */

/** A shaped layer, reduced to what these decisions need. */
export interface CroppableLayer {
  w: number;
  h: number;
  natW: number;
  natH: number;
  shape: string;
  crop?: LayerCrop | null;
}

/**
 * How far past the frame edge a freely placed image may sit.
 *
 * 📌 **The same 20px the outer drag allows**, and for the same reason: a handle
 * must stay reachable. An image dragged entirely out of its frame could not be
 * dragged back.
 */
export const CROP_OFF_FRAME_MARGIN = 20;

/**
 * The largest an inner image may be, as a multiple of the frame.
 *
 * ⚠️ **Eight frames wide is a cap, not a target.** Zooming into a corner of a
 * photo is the ordinary reason to scale past the frame; without a ceiling a
 * stray wheel gesture produces a box whose fractions are enormous and whose
 * re-placement on another canvas is nonsense.
 */
export const MAX_CROP_SCALE = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Which axes the inner image may pan along.
 *
 * 🔴 **`moveAxes` one level down, and the cases differ from it in one place.**
 * The outer `fit` asks whether the LAYER is smaller than the canvas; this asks
 * whether the IMAGE is smaller than the frame — so it must measure the placed
 * image rather than read a stored size.
 *
 * ⚠️ **No crop means `cover`, not `free`.** An image with no crop fills its
 * frame by definition, so it has nowhere to pan; treating it as free would let
 * a merchant drag an image that visibly cannot move.
 */
export function cropAxes(layer: CroppableLayer): MoveAxes {
  const style: LayerStyle = layer.crop?.style ?? 'cover';

  if (style === 'cover') return { x: false, y: false, clamp: false };
  if (style === 'fullw') return { x: false, y: true, clamp: true };
  if (style === 'fullh') return { x: true, y: false, clamp: true };

  if (style === 'fit') {
    const placed = frameImageRect(layer, 0, 0, layer.w, layer.h);

    /*
     * ⚠️ The 0.5px slack the outer `fit` uses, for the same reason: an image
     * fitted to the frame is the same size as it to within rounding, and a
     * strict comparison makes the axes flicker as the frame resizes.
     */
    return {
      x: placed.w < layer.w - 0.5,
      y: placed.h < layer.h - 0.5,
      clamp: true,
    };
  }

  return { x: true, y: true, clamp: false };
}

/** An inner image box in FRAME pixels: centre and width (height follows aspect). */
export interface CropBox {
  icx: number;
  icy: number;
  w: number;
}

/**
 * Where a crop drag may put the image.
 *
 * 🔴 **`moveTo` one level down, with the frame as the canvas.** Bounded styles
 * clamp the image inside the frame; a free one may hang over the edge by
 * {@link CROP_OFF_FRAME_MARGIN}, so a corner stays grabbable.
 *
 * ⚠️ **The height is DERIVED, never passed.** An inner image keeps the photo's
 * aspect — stretching it is what a frame exists to avoid — so a caller supplies
 * one dimension and this computes the other. Accepting both would make a
 * squashed image expressible.
 */
export function clampCropBox(layer: CroppableLayer, box: CropBox): CropBox {
  const fw = layer.w || 1;
  const fh = layer.h || 1;
  const aspect = (layer.natW || 1) / (layer.natH || 1);

  const w = clamp(box.w, MIN_LAYER_SIZE, fw * MAX_CROP_SCALE);
  const h = w / aspect;

  const axes = cropAxes(layer);

  if (axes.clamp) {
    return {
      icx: clampInside(box.icx, w / 2, fw),
      icy: clampInside(box.icy, h / 2, fh),
      w,
    };
  }

  return {
    icx: clamp(box.icx, -w / 2 + CROP_OFF_FRAME_MARGIN, fw + w / 2 - CROP_OFF_FRAME_MARGIN),
    icy: clamp(box.icy, -h / 2 + CROP_OFF_FRAME_MARGIN, fh + h / 2 - CROP_OFF_FRAME_MARGIN),
    w,
  };
}

/**
 * The crop a frame starts with.
 *
 * 📌 **A centred cover**, because a newly shaped layer should fill its frame —
 * a merchant who picks a circle wants a circle of photo, not a photo with gaps.
 * Scaling by the LARGER ratio is what guarantees no gap on either axis.
 */
export function cropDefault(layer: CroppableLayer, style: LayerStyle = 'free'): LayerCrop {
  const fw = layer.w || 1;
  const fh = layer.h || 1;
  const scale = Math.max(fw / (layer.natW || 1), fh / (layer.natH || 1));

  return {
    style,
    xPct: 0.5,
    yPct: 0.5,
    wPct: ((layer.natW || 1) * scale) / fw,
    rot: 0,
    opacity: 100,
  };
}

/**
 * Convert a clamped box back to the fractions that are stored.
 *
 * 🔴 **The conversion point, and the only one.** M26c.2's contract is that the
 * editor works in pixels and converts at a boundary — this is the inner frame's
 * boundary, mirroring `editorLayerToDesign` for the outer one.
 */
export function cropBoxToCrop(
  layer: CroppableLayer,
  box: CropBox,
  previous?: LayerCrop | null,
): LayerCrop {
  const fw = layer.w || 1;
  const fh = layer.h || 1;

  return {
    ...(previous ?? cropDefault(layer)),
    xPct: box.icx / fw,
    yPct: box.icy / fh,
    wPct: box.w / fw,
  };
}

/**
 * What changing a layer's shape does to its box and its crop.
 *
 * 🔴 **Three distinct transitions, and they are not interchangeable.** Entering
 * a frame squares the box and creates a crop; switching between frames keeps
 * both, except that a ratio-locked shape must re-square; leaving a frame
 * discards the crop and restores a plain layer. Written inline in a store
 * method these read as one `if` with branches, and the middle case — the one
 * that must NOT reset a merchant's inner placement — is the easiest to lose.
 *
 * ⚠️ **`square` is the odd shape.** It stretches freely, so it alone may keep a
 * non-square box; every other frame re-squares to its shorter edge. That is the
 * same split `resizeFrom` already makes.
 */
export interface ShapeChange {
  /** The shape to store. Toggling a shape off yields `none`. */
  shape: string;
  /** The box, re-squared where the new shape requires it. */
  size: { w: number; h: number };
  /**
   * The crop to store: a new default when entering a frame, the previous one
   * when switching between frames, and `null` when leaving.
   */
  crop: LayerCrop | null;
  /** Whether the layer must fall back to free placement (leaving a frame). */
  resetStyle: boolean;
}

export function shapeChangeFor(layer: CroppableLayer, next: string): ShapeChange {
  const leaving = next === 'none' || layer.shape === next;

  if (leaving) {
    /*
     * 📌 **Toggling the current shape clears it**, which is what makes a shape
     * button a toggle rather than a one-way door. The caller restores the
     * layer's default size — that needs the canvas, which this does not have.
     */
    return { shape: 'none', size: { w: layer.w, h: layer.h }, crop: null, resetStyle: true };
  }

  /* Every frame but `square` keeps w === h. */
  const mustSquare = next !== 'square' && layer.w !== layer.h;
  const edge = Math.min(layer.w, layer.h) || layer.w;
  const size = mustSquare ? { w: edge, h: edge } : { w: layer.w, h: layer.h };

  if (layer.shape === 'none') {
    /*
     * ⚠️ **Entering a frame squares the box FIRST, then crops to it.** The
     * default crop covers the frame, so computing it against the old box would
     * cover the wrong rectangle and leave a gap on one axis.
     */
    const squared = { ...layer, w: size.w, h: size.h };

    return { shape: next, size, crop: cropDefault(squared), resetStyle: false };
  }

  /*
   * 🔴 **Switching between frames KEEPS the inner placement.** A merchant who
   * has positioned a face inside a circle and tries a star has not asked to
   * start again. A crop is created only if there somehow is none.
   */
  return {
    shape: next,
    size,
    crop: layer.crop ?? cropDefault({ ...layer, w: size.w, h: size.h }),
    resetStyle: false,
  };
}
