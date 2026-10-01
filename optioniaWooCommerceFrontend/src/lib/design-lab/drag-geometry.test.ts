import { describe, expect, it } from 'vitest';

import {
  MIN_LAYER_SIZE,
  ROTATION_SNAP_DEGREES,
  handleDirection,
  moveAxes,
  moveTo,
  resizeFrom,
  rotateTo,
} from './drag-geometry';
import type { EditorLayer } from './layer.types';

const CW = 400;
const CH = 460;

function layer(over: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id: 'L1',
    name: 'layer',
    src: 'img.png',
    natW: 200,
    natH: 100,
    kind: 'layer',
    cx: 200,
    cy: 230,
    w: 100,
    h: 50,
    rot: 0,
    style: 'free',
    opacity: 100,
    shape: 'none',
    visible: true,
    locked: false,
    ...over,
  };
}

describe('moveAxes', () => {
  it('pins both axes for cover, which already fills the canvas', () => {
    expect(moveAxes(layer({ style: 'cover' }), CW, CH)).toEqual({
      x: false,
      y: false,
      clamp: false,
    });
  });

  it('frees the axis a full-width or full-height style does not own', () => {
    expect(moveAxes(layer({ style: 'fullw' }), CW, CH)).toMatchObject({ x: false, y: true });
    expect(moveAxes(layer({ style: 'fullh' }), CW, CH)).toMatchObject({ x: true, y: false });
  });

  /**
   * 🔴 **`fit` is conditional, and that is the case a degenerate fixture hides.**
   * It fills one axis exactly, so the other is draggable only while the layer is
   * smaller than the canvas — the same band `clampInside` works in.
   */
  it('allows a fit layer to move only on the axis it does not fill', () => {
    /* Narrow: horizontal play, vertical filled. */
    expect(moveAxes(layer({ style: 'fit', w: 115, h: 460 }), CW, CH)).toMatchObject({
      x: true,
      y: false,
    });

    /* Wide: the mirror. */
    expect(moveAxes(layer({ style: 'fit', w: 400, h: 200 }), CW, CH)).toMatchObject({
      x: false,
      y: true,
    });
  });

  it('clamps every style that is defined relative to the canvas', () => {
    for (const style of ['fit', 'fullw', 'fullh'] as const) {
      expect(moveAxes(layer({ style }), CW, CH).clamp).toBe(true);
    }

    /* `free` may hang off the edge — artwork that bleeds is ordinary. */
    expect(moveAxes(layer({ style: 'free' }), CW, CH).clamp).toBe(false);
  });
});

describe('moveTo', () => {
  const start = { cx: 200, cy: 230, w: 100, h: 50 };
  const size = { w: 100, h: 50 };
  const canvas = { cw: CW, ch: CH };

  it('moves by the delta on a free axis', () => {
    const next = moveTo(start, { dx: 30, dy: -20 }, { x: true, y: true, clamp: false }, size, canvas);

    expect(next).toEqual({ cx: 230, cy: 210 });
  });

  it('ignores the delta on a pinned axis', () => {
    const next = moveTo(start, { dx: 30, dy: -20 }, { x: false, y: true, clamp: false }, size, canvas);

    expect(next.cx).toBe(200);
    expect(next.cy).toBe(210);
  });

  it('holds a clamped layer fully on-canvas', () => {
    const next = moveTo(start, { dx: -500, dy: 0 }, { x: true, y: true, clamp: true }, size, canvas);

    /* Caught at half its own width, not at zero. */
    expect(next.cx).toBeCloseTo(size.w / 2, 6);
  });

  /**
   * ⚠️ **A free layer MAY hang off the edge, but never entirely.** Artwork that
   * bleeds past the product edge is ordinary; a layer dragged out of reach is a
   * layer the merchant cannot grab back.
   */
  it('lets a free layer overhang, but keeps a grabbable margin', () => {
    const far = moveTo(start, { dx: -5000, dy: 0 }, { x: true, y: true, clamp: false }, size, canvas);

    expect(far.cx).toBeLessThan(0);
    expect(far.cx).toBeCloseTo(-size.w / 2 + 20, 6);
  });
});

describe('handleDirection', () => {
  it.each([
    ['nw', -1, -1],
    ['ne', 1, -1],
    ['sw', -1, 1],
    ['se', 1, 1],
    ['n', 0, -1],
    ['s', 0, 1],
    ['e', 1, 0],
    ['w', -1, 0],
  ])('%s pulls (%i, %i)', (dir, hx, hy) => {
    expect(handleDirection(dir)).toEqual({ hx, hy });
  });
});

describe('resizeFrom', () => {
  const start = { cx: 200, cy: 200, w: 100, h: 100 };

  it('grows by the delta when unrotated', () => {
    const next = resizeFrom(start, { dx: 40, dy: 0 }, 'e', 0, 'square');

    expect(next.w).toBeCloseTo(140, 6);
    /* An edge handle moves one axis only. */
    expect(next.h).toBeCloseTo(100, 6);
  });

  /**
   * 🔴 **The case that makes the trigonometry load-bearing.**
   *
   * Verified by hand before being asserted: at 90°, `cos` is 0 and `sin` is 1,
   * so a screen-right drag maps to `ldx = 0` — it runs along the layer's HEIGHT
   * axis, not its width. The east handle therefore does not widen it at all.
   *
   * ⚠️ At `rot = 0` every rotation term vanishes, so a test there passes with
   * the trigonometry deleted. This one cannot.
   */
  it('rotates the delta into the layer frame, not the screen frame', () => {
    const next = resizeFrom(start, { dx: 40, dy: 0 }, 'e', 90, 'square');

    /* The drag ran across the width axis, so the width is unchanged. */
    expect(next.w).toBeCloseTo(100, 6);
  });

  it('widens a 90°-rotated layer when dragged along ITS width axis', () => {
    /* At 90°, the layer's width axis points down the screen. */
    const next = resizeFrom(start, { dx: 0, dy: 40 }, 'e', 90, 'square');

    expect(next.w).toBeCloseTo(140, 6);
  });

  it.each([37, 125, 180, -60])('holds the opposite corner at %i°', (rot) => {
    /*
     * 🔴 **The centre compensation, which is invisible at rot = 0.** Resizing
     * from the south-east handle must leave the north-west corner exactly where
     * it was; without the rotated shift the layer drifts, which reads as jitter
     * rather than as a maths error.
     */
    const r = (rot * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);

    const cornerBefore = {
      x: start.cx + ((-start.w / 2) * cos - (-start.h / 2) * sin),
      y: start.cy + ((-start.w / 2) * sin + (-start.h / 2) * cos),
    };

    const next = resizeFrom(start, { dx: 25, dy: 15 }, 'se', rot, 'square');

    const cornerAfter = {
      x: next.cx + ((-next.w / 2) * cos - (-next.h / 2) * sin),
      y: next.cy + ((-next.w / 2) * sin + (-next.h / 2) * cos),
    };

    expect(cornerAfter.x).toBeCloseTo(cornerBefore.x, 6);
    expect(cornerAfter.y).toBeCloseTo(cornerBefore.y, 6);
  });

  /**
   * 🔴 **The SIZE the rotation produces, not merely a self-consistent one.**
   *
   * ⚠️ The corner test above computes its expected corner FROM the result's own
   * `nw`/`nh` — so it proves the compensation matches the size, not that the
   * size is right. A sign flip in the inverse rotation passed all thirty cases
   * because both halves moved together.
   *
   * 📌 Hand-computed at 37°: `ldx = 25·cos37 + 15·sin37 ≈ 28.993` and
   * `ldy = −25·sin37 + 15·cos37 ≈ −3.066`, so a 100×100 square becomes
   * ≈128.993 × ≈96.934. With the sign flipped the height would be ≈127.025 —
   * which is what this catches.
   */
  it('produces the size the rotation dictates, at 37°', () => {
    const next = resizeFrom(start, { dx: 25, dy: 15 }, 'se', 37, 'square');

    expect(next.w).toBeCloseTo(128.993113, 5);
    expect(next.h).toBeCloseTo(96.934157, 5);
  });

  it('keeps the aspect for a plain layer, whatever the handle', () => {
    const wide = { cx: 200, cy: 200, w: 200, h: 100 };

    for (const dir of ['e', 's', 'se', 'nw']) {
      const next = resizeFrom(wide, { dx: 30, dy: 30 }, dir, 0, 'none');

      expect(next.w / next.h).toBeCloseTo(2, 6);
    }
  });

  it('frees both axes for a square frame, which the image re-covers', () => {
    const next = resizeFrom(start, { dx: 60, dy: 10 }, 'se', 0, 'square');

    /* Independent: the ratio changed. */
    expect(next.w / next.h).not.toBeCloseTo(1, 3);
  });

  it('never shrinks below the minimum, however far the drag', () => {
    const next = resizeFrom(start, { dx: -5000, dy: -5000 }, 'se', 0, 'square');

    expect(next.w).toBeGreaterThanOrEqual(MIN_LAYER_SIZE);
    expect(next.h).toBeGreaterThanOrEqual(MIN_LAYER_SIZE);
  });

  it('bounds the size in the LAYER frame, at every angle', () => {
    /*
     * ⚠️ The minimum is the layer's own width and height — not its screen
     * bounding box, which is larger whenever it is rotated. A 24×24 layer at 45°
     * occupies ~34px on screen, and that is correct: the handles sit on the
     * layer's edges, so the bound is what keeps them grabbable.
     *
     * ✏️ **The first version of this case dragged `(-5000, -5000)` at every
     * angle and failed at 90°**, where that screen delta maps to ZERO along the
     * layer's height axis — so the height never shrank. The delta must be
     * expressed in the LAYER's frame and rotated forward into screen space,
     * which is the same error the module exists to prevent, made in its test.
     */
    for (const rot of [0, 45, 90, 137]) {
      const r = (rot * Math.PI) / 180;
      const cos = Math.cos(r);
      const sin = Math.sin(r);

      /* A hard shrink along BOTH of the layer's own axes… */
      const localDx = -5000;
      const localDy = -5000;

      /* …expressed as the screen drag that produces it. */
      const next = resizeFrom(
        start,
        { dx: localDx * cos - localDy * sin, dy: localDx * sin + localDy * cos },
        'se',
        rot,
        'square',
      );

      expect(next.w).toBeCloseTo(MIN_LAYER_SIZE, 6);
      expect(next.h).toBeCloseTo(MIN_LAYER_SIZE, 6);
    }
  });
});

describe('rotateTo', () => {
  it('follows the pointer from where the drag began', () => {
    /* Start east of centre, drag to due north: a quarter turn anticlockwise. */
    const deg = rotateTo({ x: 200, y: 100 }, { x: 200, y: 200 }, 0, 0);

    expect(deg).toBeCloseTo(270, 6);
  });

  it('keeps the handle under the cursor rather than jumping to it', () => {
    /*
     * 📌 Starting mid-gesture at 45° with the layer already at 45° must leave it
     * unchanged — the offset is what stops the layer snapping to the pointer.
     *
     * ⚠️ **This case is DEGENERATE on its own**: the pointer angle, the start
     * angle and the layer's rotation are all 45°, so every term cancels and
     * removing the offset entirely still produces 45. The case below is the one
     * that actually pins it.
     */
    const start = Math.PI / 4;
    const deg = rotateTo({ x: 300, y: 300 }, { x: 200, y: 200 }, start, 45);

    expect(deg).toBeCloseTo(45, 6);
  });

  /**
   * 🔴 **The offset is what stops the layer SNAPPING to the cursor**, and
   * nothing proved it until a mutation removed it and all thirty-one cases
   * passed.
   *
   * Both earlier fixtures cancelled the offset — one had `start = 0` and
   * `rot0 = 0`, the other had the pointer, the start and the rotation all at
   * 45°. Deleting the term is invisible in either.
   *
   * 📌 Hand-computed, with coordinates chosen so the arithmetic is exact: the
   * pointer due EAST of the centre makes `atan2` exactly 0. A layer already at
   * 100° whose drag began at 30° must therefore read 100 − 30 = **70**.
   *
   * ⚠️ One case distinguishes BOTH failure modes: dropping the offset entirely
   * gives 0, and keeping `rot0` while dropping `start` gives 100.
   */
  it('applies the full offset, so the layer does not snap to the cursor', () => {
    const deg = rotateTo(
      /* Due east of the centre: atan2 is exactly 0. */
      { x: 300, y: 200 },
      { x: 200, y: 200 },
      /* The gesture began with the handle 30° round… */
      (30 * Math.PI) / 180,
      /* …and the layer already turned 100°. */
      100,
    );

    expect(deg).toBeCloseTo(70, 9);
  });

  /**
   * ⚠️ **Normalised into 0..360, not left negative.** A stored `-90` renders
   * identically to `270` but compares unequal — which is how a "did the rotation
   * change?" check starts lying.
   */
  it('normalises into 0..360', () => {
    const deg = rotateTo({ x: 200, y: 300 }, { x: 200, y: 200 }, 0, -180);

    expect(deg).toBeGreaterThanOrEqual(0);
    expect(deg).toBeLessThan(360);
  });

  /**
   * ⚠️ **Asserted against a LITERAL fifteen, not against the constant.**
   *
   * The first version checked `snapped % ROTATION_SNAP_DEGREES === 0`, which
   * reads the very value it is meant to verify — so changing the constant to 1
   * passed. That is the same shape as a gate asserting a name is present rather
   * than that work was done.
   */
  it('snaps to fifteen degrees when asked', () => {
    expect(ROTATION_SNAP_DEGREES).toBe(15);

    const free = rotateTo({ x: 290, y: 160 }, { x: 200, y: 200 }, 0, 0, false);
    const snapped = rotateTo({ x: 290, y: 160 }, { x: 200, y: 200 }, 0, 0, true);

    expect(snapped % 15).toBeCloseTo(0, 9);
    /* And it snapped to the NEAREST multiple, not to an arbitrary one. */
    expect(Math.abs(snapped - free)).toBeLessThanOrEqual(7.5 + 1e-9);
  });

  it.each([
    [10, 15],
    [22, 15],
    [23, 30],
    [37, 30],
    [38, 45],
  ])('snaps %i° to %i°', (from, expected) => {
    /*
     * 📌 Concrete pairs rather than a modulo property: a wrong increment moves
     * these, where `x % n === 0` holds for any n.
     */
    const deg = rotateTo({ x: 300, y: 200 }, { x: 200, y: 200 }, 0, from, true);

    expect(deg).toBeCloseTo(expected, 9);
  });
});
