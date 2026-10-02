import { describe, expect, it } from 'vitest';

import { SHAPE_CLIP_PATHS, frameImageRect } from '@shared/design/layer-geometry';
import type { LayerCrop } from '@shared/design/design-geometry.types';
import {
  CROP_OFF_FRAME_MARGIN,
  MAX_CROP_SCALE,
  clampCropBox,
  cropAxes,
  cropBoxToCrop,
  cropDefault,
  innerPlacement,
  shapeChangeFor,
  type CroppableLayer,
} from './crop-geometry';
import { MIN_LAYER_SIZE } from './drag-geometry';

/*
 * 🔴 **A frame that is NOT square and a photo that is NOT square.** The outer
 * drag suite learned this the hard way: a fixture where every term cancels lets
 * a transposed width and height pass. 200x120 frame, 400x100 photo — nothing
 * here is interchangeable.
 */
function layer(crop: Partial<LayerCrop> | null = null, over: Partial<CroppableLayer> = {}): CroppableLayer {
  return {
    w: 200,
    h: 120,
    natW: 400,
    natH: 100,
    shape: 'circle',
    crop: crop === null ? null : ({ ...cropDefault({ w: 200, h: 120, natW: 400, natH: 100, shape: 'circle' }), ...crop } as LayerCrop),
    ...over,
  };
}

describe('cropAxes', () => {
  it('pins a cover image, which fills the frame by definition', () => {
    expect(cropAxes(layer({ style: 'cover' }))).toEqual({ x: false, y: false, clamp: false });
  });

  /*
   * ⚠️ **No crop means cover, not free.** An image with no crop fills its frame,
   * so it has nowhere to pan; treating it as free would let a merchant drag an
   * image that visibly cannot move.
   */
  it('pins an image with no crop at all', () => {
    expect(cropAxes(layer(null))).toEqual({ x: false, y: false, clamp: false });
  });

  it('lets a free image pan both ways, unclamped', () => {
    expect(cropAxes(layer({ style: 'free' }))).toEqual({ x: true, y: true, clamp: false });
  });

  it('lets a full-width image move only vertically', () => {
    expect(cropAxes(layer({ style: 'fullw' }))).toEqual({ x: false, y: true, clamp: true });
  });

  it('lets a full-height image move only horizontally', () => {
    expect(cropAxes(layer({ style: 'fullh' }))).toEqual({ x: true, y: false, clamp: true });
  });

  /*
   * 🔴 **`fit` is the CONDITIONAL case**, and the one the outer suite's audits
   * were about. It measures the PLACED image against the frame, so the answer
   * differs per axis — a wide photo fitted into a tall frame letterboxes
   * vertically and touches both sides.
   */
  it('reads a fitted image axis by axis', () => {
    /* 400x100 into 200x120: scale = min(0.5, 1.2) = 0.5 → 200x50. */
    const fitted = layer({ style: 'fit' });
    const placed = frameImageRect(fitted, 0, 0, fitted.w, fitted.h);

    expect(placed.w).toBeCloseTo(200);
    expect(placed.h).toBeCloseTo(50);

    /* Fills the width exactly, is shorter than the frame: y moves, x does not. */
    expect(cropAxes(fitted)).toEqual({ x: false, y: true, clamp: true });
  });

  /*
   * ⚠️ **`fit` ALWAYS fills exactly one axis**, by definition — it scales by the
   * smaller ratio, so one dimension meets the frame and the other is shorter.
   * My first fixture here claimed a 40x40 photo would fill neither: it scales
   * by min(5, 3) = 3 to 120x120 and fills the height exactly. There is no
   * fixture where a fitted image moves both ways, and asserting the pair is
   * worth more than a case that cannot exist.
   */
  it('always pins exactly one axis of a fitted image', () => {
    const wide = layer({ style: 'fit' });
    const tall = layer({ style: 'fit' }, { natW: 40, natH: 400 });

    /* 400x100 into 200x120 → 200x50: fills the width. */
    expect(cropAxes(wide)).toEqual({ x: false, y: true, clamp: true });

    /* 40x400 into 200x120 → 12x120: fills the height. */
    expect(cropAxes(tall)).toEqual({ x: true, y: false, clamp: true });
  });
});

describe('clampCropBox', () => {
  it('derives the height from the width and the photo aspect', () => {
    /*
     * ⚠️ A caller supplies ONE dimension. Accepting both would make a squashed
     * image expressible, which is what a frame exists to avoid.
     */
    const box = clampCropBox(layer({ style: 'free' }), { icx: 100, icy: 60, w: 400 });

    expect(box.w).toBe(400);
    /* The box carries width only; the height is derived where it is drawn. */
    expect(Object.keys(box).sort()).toEqual(['icx', 'icy', 'w']);
  });

  it('refuses to shrink an image below the minimum', () => {
    const box = clampCropBox(layer({ style: 'free' }), { icx: 100, icy: 60, w: 2 });

    expect(box.w).toBe(MIN_LAYER_SIZE);
  });

  it('caps the scale, so a stray wheel gesture cannot produce nonsense', () => {
    const box = clampCropBox(layer({ style: 'free' }), { icx: 100, icy: 60, w: 99_999 });

    expect(box.w).toBe(200 * MAX_CROP_SCALE);
  });

  /*
   * 🔴 **The clamp, on a box that does NOT saturate it.** The outer suite's
   * audit found a fixture where lo === hi, so centring and clamping agreed and
   * a mutation survived 25 tests. Here the image is smaller than the frame and
   * dragged well past one edge, so the two answers differ.
   */
  it('keeps a bounded image inside its frame', () => {
    /* fit: 400x100 into 200x120 → 200x50. Dragged far above the top. */
    const box = clampCropBox(layer({ style: 'fit' }), { icx: 100, icy: -500, w: 200 });

    /* Clamped to half its height from the top edge, not to zero. */
    expect(box.icy).toBeCloseTo(25);
  });

  it('clamps each axis independently', () => {
    /*
     * ⚠️ One axis far out and one inside. A shared clamp would move both, and a
     * transposed one would move the wrong one.
     */
    const box = clampCropBox(layer({ style: 'fit' }), { icx: 100, icy: 9_999, w: 200 });

    expect(box.icx).toBeCloseTo(100);
    expect(box.icy).toBeCloseTo(120 - 25);
  });

  /*
   * 📌 **A free image may hang over the edge**, by exactly the margin that keeps
   * a corner grabbable — the same 20px the outer drag allows.
   */
  it('lets a free image hang over the frame edge, but not escape it', () => {
    const box = clampCropBox(layer({ style: 'free' }), { icx: -9_999, icy: 60, w: 200 });

    expect(box.icx).toBeCloseTo(-100 + CROP_OFF_FRAME_MARGIN);
  });

  it('lets a free image hang over the far edge too', () => {
    const box = clampCropBox(layer({ style: 'free' }), { icx: 9_999, icy: 60, w: 200 });

    expect(box.icx).toBeCloseTo(200 + 100 - CROP_OFF_FRAME_MARGIN);
  });

  it('leaves a box that is already in bounds alone', () => {
    const box = clampCropBox(layer({ style: 'free' }), { icx: 90, icy: 55, w: 220 });

    expect(box.icx).toBeCloseTo(90);
    expect(box.icy).toBeCloseTo(55);
    expect(box.w).toBeCloseTo(220);
  });
});

describe('cropDefault', () => {
  /*
   * 🔴 **A centred COVER**: a merchant who picks a circle wants a circle of
   * photo, not a photo with gaps. Scaling by the LARGER ratio is what
   * guarantees no gap on either axis.
   */
  it('covers the frame rather than fitting inside it', () => {
    const crop = cropDefault(layer(null));

    /* 200/400 = 0.5, 120/100 = 1.2 → the larger, 1.2. Width = 400*1.2 = 480. */
    expect(crop.wPct).toBeCloseTo(480 / 200);
    expect(crop.wPct).toBeGreaterThan(1);
  });

  it('centres the image', () => {
    const crop = cropDefault(layer(null));

    expect(crop.xPct).toBe(0.5);
    expect(crop.yPct).toBe(0.5);
  });

  it('starts unrotated and fully opaque', () => {
    const crop = cropDefault(layer(null));

    expect(crop.rot).toBe(0);
    expect(crop.opacity).toBe(100);
  });

  it('takes the style it is given', () => {
    expect(cropDefault(layer(null), 'fit').style).toBe('fit');
    expect(cropDefault(layer(null)).style).toBe('free');
  });

  it('survives a layer with no natural size rather than dividing by zero', () => {
    /* ⚠️ A browser reports zeroes for an image that failed to decode. */
    const crop = cropDefault(layer(null, { natW: 0, natH: 0 }));

    expect(Number.isFinite(crop.wPct)).toBe(true);
  });
});

describe('cropBoxToCrop', () => {
  it('stores the box as fractions of the frame', () => {
    const crop = cropBoxToCrop(layer({ style: 'free' }), { icx: 50, icy: 30, w: 100 });

    /* 50/200, 30/120, 100/200 — three DIFFERENT fractions, so a transposed
     * denominator cannot pass. */
    expect(crop.xPct).toBeCloseTo(0.25);
    expect(crop.yPct).toBeCloseTo(0.25);
    expect(crop.wPct).toBeCloseTo(0.5);
  });

  it('keeps the rotation and opacity the merchant set', () => {
    const previous = { ...cropDefault(layer(null)), rot: 42, opacity: 60 };
    const crop = cropBoxToCrop(layer({ style: 'free' }), { icx: 50, icy: 30, w: 100 }, previous);

    expect(crop.rot).toBe(42);
    expect(crop.opacity).toBe(60);
  });

  it('falls back to a default when there is no previous crop', () => {
    const crop = cropBoxToCrop(layer(null), { icx: 50, icy: 30, w: 100 }, null);

    expect(crop.rot).toBe(0);
    expect(crop.opacity).toBe(100);
  });

  /*
   * 🔴 **The round trip.** A box converted to fractions and placed again must
   * land where it started — that is what makes a design re-place correctly on
   * another canvas.
   */
  it('round-trips through frameImageRect', () => {
    const base = layer({ style: 'free' });
    const box = clampCropBox(base, { icx: 90, icy: 55, w: 220 });
    const stored = cropBoxToCrop(base, box);
    const placed = frameImageRect({ ...base, crop: stored }, 0, 0, base.w, base.h);

    expect(placed.x + placed.w / 2).toBeCloseTo(box.icx);
    expect(placed.y + placed.h / 2).toBeCloseTo(box.icy);
    expect(placed.w).toBeCloseTo(box.w);
  });
});

describe('shapeChangeFor', () => {
  it('squares the box and creates a crop when entering a frame', () => {
    /* A 200x120 plain layer becoming a circle: squares to its shorter edge. */
    const change = shapeChangeFor(layer(null, { shape: 'none' }), 'circle');

    expect(change.shape).toBe('circle');
    expect(change.size).toEqual({ w: 120, h: 120 });
    expect(change.crop).not.toBeNull();
    expect(change.resetStyle).toBe(false);
  });

  /*
   * 🔴 **The crop covers the SQUARED box, not the old one.** Computing it
   * against 200x120 would cover the wrong rectangle and leave a gap on one axis
   * once the box became 120x120. The order is load-bearing.
   */
  it('crops to the squared box, not the box it had before', () => {
    const change = shapeChangeFor(layer(null, { shape: 'none' }), 'circle');
    const placed = frameImageRect(
      { natW: 400, natH: 100, crop: change.crop },
      0,
      0,
      120,
      120,
    );

    /* A cover leaves no gap on either axis. */
    expect(placed.w).toBeGreaterThanOrEqual(120 - 0.5);
    expect(placed.h).toBeGreaterThanOrEqual(120 - 0.5);
  });

  /*
   * ⚠️ **`square` is the one frame that stretches**, so it alone keeps a
   * non-square box. The same split `resizeFrom` makes.
   */
  it('leaves a square frame free to stay rectangular', () => {
    const change = shapeChangeFor(layer(null, { shape: 'none' }), 'square');

    expect(change.size).toEqual({ w: 200, h: 120 });
  });

  /*
   * 🔴 **Switching frames KEEPS the inner placement.** A merchant who has
   * positioned a face inside a circle and tries a star has not asked to start
   * again. This is the case most easily lost when the three transitions are one
   * inline `if`.
   */
  it('keeps the inner placement when switching between frames', () => {
    const positioned = layer({ style: 'free', xPct: 0.2, yPct: 0.8 }, { shape: 'circle', w: 120, h: 120 });
    const change = shapeChangeFor(positioned, 'heart');

    expect(change.crop?.xPct).toBeCloseTo(0.2);
    expect(change.crop?.yPct).toBeCloseTo(0.8);
  });

  it('re-squares a stretched square frame when a ratio-locked shape is chosen', () => {
    const stretched = layer({ style: 'free' }, { shape: 'square', w: 300, h: 100 });

    expect(shapeChangeFor(stretched, 'circle').size).toEqual({ w: 100, h: 100 });
  });

  it('clears the frame when the current shape is chosen again', () => {
    /* 📌 What makes a shape button a toggle rather than a one-way door. */
    const framed = layer({ style: 'free' }, { shape: 'circle' });
    const change = shapeChangeFor(framed, 'circle');

    expect(change.shape).toBe('none');
    expect(change.crop).toBeNull();
    expect(change.resetStyle).toBe(true);
  });

  it('clears the frame when `none` is chosen explicitly', () => {
    const change = shapeChangeFor(layer({ style: 'free' }, { shape: 'star' }), 'none');

    expect(change.shape).toBe('none');
    expect(change.crop).toBeNull();
    expect(change.resetStyle).toBe(true);
  });

  it('creates a crop for a framed layer that somehow has none', () => {
    /* Legacy data: a shape with no crop predates the two-level model. */
    const change = shapeChangeFor(layer(null, { shape: 'circle', w: 120, h: 120 }), 'heart');

    expect(change.crop).not.toBeNull();
  });

  /*
   * 📌 The three transitions give three DIFFERENT answers for `crop`, which is
   * what stops them collapsing into one branch.
   */
  it('answers differently for the three transitions', () => {
    const entering = shapeChangeFor(layer(null, { shape: 'none' }), 'circle');
    const switching = shapeChangeFor(layer({ style: 'free', xPct: 0.2 }, { shape: 'circle', w: 120, h: 120 }), 'star');
    const leaving = shapeChangeFor(layer({ style: 'free' }, { shape: 'circle' }), 'circle');

    expect(entering.crop?.xPct).toBe(0.5);
    expect(switching.crop?.xPct).toBeCloseTo(0.2);
    expect(leaving.crop).toBeNull();
  });
});

describe('innerPlacement', () => {
  it('places the image where frameImageRect says', () => {
    const framed = layer({ style: 'free' });
    const placement = innerPlacement(framed);
    const expected = frameImageRect(framed, 0, 0, framed.w, framed.h);

    expect(placement.rect).toEqual(expected);
  });

  /*
   * 🔴 **Only a `free` inner image rotates.** Every other style derives its box
   * from the frame on each re-fit, so the angle would survive in the data and
   * be visibly ignored — the same rule `canRotate` applies one level up.
   */
  it('rotates a free image and refuses to rotate any other style', () => {
    expect(innerPlacement(layer({ style: 'free', rot: 30 })).rot).toBe(30);

    for (const style of ['cover', 'fit', 'fullw', 'fullh'] as const) {
      expect(innerPlacement(layer({ style, rot: 30 })).rot).toBe(0);
    }
  });

  it('carries the inner opacity, which is separate from the layer’s', () => {
    expect(innerPlacement(layer({ style: 'free', opacity: 40 })).opacity).toBe(40);
  });

  it('treats a layer with no crop as a fully opaque, unrotated cover', () => {
    const placement = innerPlacement(layer(null));

    expect(placement.rot).toBe(0);
    expect(placement.opacity).toBe(100);
    /* A cover leaves no gap: the placed image is at least the frame. */
    expect(placement.rect.w).toBeGreaterThanOrEqual(200 - 0.5);
    expect(placement.rect.h).toBeGreaterThanOrEqual(120 - 0.5);
  });
});

/**
 * The frames a merchant may pick, against the paths that draw them.
 *
 * 🔴 **A picker offering a shape with no path clips every layer to nothing.**
 * The panel's list is a hand-written mirror of `SHAPE_CLIP_PATHS` — the exact
 * shape that drifted in `swatchFieldsFor` and in the design carriers — so it is
 * compared against the source of truth rather than trusted.
 */
describe('every offered frame has a path', () => {
  /* Mirrors `FRAMES` in `properties-panel.tsx`. */
  const OFFERED = ['square', 'rounded', 'circle', 'heart', 'star'];

  it('offers exactly the shapes the renderer can draw', () => {
    expect([...OFFERED].sort()).toEqual(Object.keys(SHAPE_CLIP_PATHS).sort());
  });

  it('gives every offered frame a non-empty path', () => {
    for (const shape of OFFERED) {
      expect(SHAPE_CLIP_PATHS[shape as keyof typeof SHAPE_CLIP_PATHS]).toMatch(/\S/);
    }
  });
});
