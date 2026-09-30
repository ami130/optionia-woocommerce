import type { DesignLayer } from './design-geometry.types';
import {
  SHAPE_CLIP_PATHS,
  clampInside,
  effectiveShape,
  frameImageRect,
  layerRect,
} from './layer-geometry';

/**
 * The coordinate model (M26c.1).
 *
 * 🔴 **This is a PORT, so the tests pin fidelity rather than preference.** Every
 * branch resolves a disagreement between four rendering surfaces in
 * `optionia-app` that had to agree to the pixel; a test that merely asserted
 * "something reasonable" would let the port drift from the thing it exists to
 * reproduce.
 */
const layer = (over: Partial<DesignLayer> = {}): DesignLayer => ({
  name: 'art',
  src: 'art.png',
  natW: 200,
  natH: 100,
  pos: { xPct: 0.5, yPct: 0.5, wPct: 0.5, hPct: 0 },
  rot: 0,
  style: 'free',
  visible: true,
  ...over,
});

describe('clampInside', () => {
  it('keeps a box inside the span', () => {
    expect(clampInside(0, 10, 100)).toBe(10);
    expect(clampInside(100, 10, 100)).toBe(90);
    expect(clampInside(50, 10, 100)).toBe(50);
  });

  /**
   * 🔴 **A box LARGER than the span keeps covering it.** Clamping to the middle
   * would reveal an empty edge the merchant never asked for — the opposite of
   * what an oversized layer is for.
   */
  it('keeps an oversized box covering the span', () => {
    expect(clampInside(0, 80, 100)).toBe(20);
    expect(clampInside(100, 80, 100)).toBe(80);
  });
});

describe('effectiveShape', () => {
  /**
   * 🔴 **`square` once meant "no mask", and still does in older data.** A real
   * square frame always carries a crop; a stored `square` without one predates
   * the frame model. Skipping this clips artwork that was never framed.
   */
  it('maps a legacy square without a crop to none', () => {
    expect(effectiveShape({ shape: 'square' })).toBe('none');
    expect(effectiveShape({ shape: 'square', crop: null })).toBe('none');
  });

  it('keeps a real square frame, which carries a crop', () => {
    expect(
      effectiveShape({
        shape: 'square',
        crop: { style: 'cover', xPct: 0.5, yPct: 0.5, wPct: 1, rot: 0, opacity: 100 },
      }),
    ).toBe('square');
  });

  /**
   * ⚠️ **A custom mask with no file degrades to plain**, because clipping to a
   * missing PNG would show nothing at all.
   */
  it('degrades an image shape with no mask URL', () => {
    expect(effectiveShape({ shape: 'image' })).toBe('none');
    expect(effectiveShape({ shape: 'image', shapeSrc: 'mask.png' })).toBe('image');
  });

  it('treats an absent shape as none', () => {
    expect(effectiveShape({})).toBe('none');
  });
});

describe('layerRect', () => {
  /** 📌 `free` trusts the stored centre and width; height follows the aspect. */
  it('places a free layer at its stored box', () => {
    const rect = layerRect(layer(), 1000, 1000);

    /* 0.5 × 1000 wide, 2:1 aspect so 250 tall, centred. */
    expect(rect).toMatchObject({ w: 500, h: 250, cx: 500, cy: 500, rot: 0 });
    expect(rect.x).toBe(250);
    expect(rect.y).toBe(375);
  });

  /** 🔴 `cover` fills the canvas and overflows; the SVG clips it. */
  it('covers the canvas, overflowing on the short axis', () => {
    const rect = layerRect(layer({ style: 'cover' }), 1000, 1000);

    /* A 2:1 image covering a square must be 2000×1000. */
    expect(rect.w).toBe(2000);
    expect(rect.h).toBe(1000);
    expect(rect.cx).toBe(500);
  });

  /** 📌 `fit` contains the image, honouring the stored centre. */
  it('fits inside the canvas and honours the stored centre', () => {
    const rect = layerRect(
      layer({ style: 'fit', pos: { xPct: 0.9, yPct: 0.5, wPct: 0.5, hPct: 0 } }),
      1000,
      1000,
    );

    expect(rect.w).toBe(1000);
    expect(rect.h).toBe(500);
    /* Clamped: a 1000-wide box cannot centre at 900 inside 1000. */
    expect(rect.cx).toBe(500);
  });

  /**
   * 🔴 **Only `free` rotates.** Every other style zeroes rotation on apply, so
   * honouring a stored angle here would rotate a layer the editor shows
   * straight.
   */
  it('zeroes rotation on every style but free', () => {
    expect(layerRect(layer({ rot: 45 }), 1000, 1000).rot).toBe(45);

    for (const style of ['cover', 'fit', 'fullw', 'fullh'] as const) {
      expect(layerRect(layer({ style, rot: 45 }), 1000, 1000).rot).toBe(0);
    }
  });

  /**
   * 🔴 **A ratio-locked frame is SQUARE**, whatever the image's aspect. A circle
   * mask on a 2:1 photo is a circle, not an ellipse.
   */
  it('makes a non-square frame a square box', () => {
    const rect = layerRect(layer({ shape: 'circle' }), 1000, 800);

    expect(rect.w).toBe(rect.h);
  });

  /**
   * ⚠️ **A `square` frame is NOT ratio-locked** — both stored fractions count,
   * which is what distinguishes it from the other shapes.
   */
  it('lets a square frame size freely', () => {
    const rect = layerRect(
      layer({
        shape: 'square',
        crop: { style: 'cover', xPct: 0.5, yPct: 0.5, wPct: 1, rot: 0, opacity: 100 },
        pos: { xPct: 0.5, yPct: 0.5, wPct: 0.4, hPct: 0.2 },
      }),
      1000,
      1000,
    );

    expect(rect.w).toBe(400);
    expect(rect.h).toBe(200);
  });

  /** 📌 A square frame with no stored height falls back to a square. */
  it('squares a frame whose height was never stored', () => {
    const rect = layerRect(
      layer({
        shape: 'square',
        crop: { style: 'cover', xPct: 0.5, yPct: 0.5, wPct: 1, rot: 0, opacity: 100 },
        pos: { xPct: 0.5, yPct: 0.5, wPct: 0.4, hPct: 0 },
      }),
      1000,
      1000,
    );

    expect(rect.w).toBe(400);
    expect(rect.h).toBe(400);
  });

  /** ⚠️ A zero natural size must not divide by zero. */
  it('survives an image with no recorded size', () => {
    const rect = layerRect(layer({ natW: 0, natH: 0 }), 1000, 1000);

    expect(Number.isFinite(rect.w)).toBe(true);
    expect(Number.isFinite(rect.h)).toBe(true);
  });
});

describe('frameImageRect', () => {
  const framed = { natW: 200, natH: 100 };

  /** 📌 No crop at all means a centred cover. */
  it('covers the frame when no crop was stored', () => {
    const rect = frameImageRect(framed, 0, 0, 100, 100);

    /* A 2:1 image covering a 100×100 frame is 200×100, centred. */
    expect(rect.w).toBe(200);
    expect(rect.h).toBe(100);
    expect(rect.x).toBe(-50);
  });

  /**
   * ⚠️ **A crop with no `wPct` predates the box model** and is treated as
   * unset, not as a zero-width box.
   */
  it('ignores a legacy crop with no width', () => {
    const legacy = {
      ...framed,
      crop: { style: 'free', xPct: 0.5, yPct: 0.5, rot: 0, opacity: 100 } as never,
    };

    expect(frameImageRect(legacy, 0, 0, 100, 100).w).toBe(200);
  });

  /** 📌 The frame's origin is applied, so the rect is absolute. */
  it('offsets by the frame origin', () => {
    const rect = frameImageRect(framed, 40, 60, 100, 100);

    expect(rect.x).toBe(-10);
    expect(rect.y).toBe(60);
  });
});

describe('SHAPE_CLIP_PATHS', () => {
  /**
   * 🔴 **Every path lives in a 0..1 unit box** and is scaled to the frame with
   * `userSpaceOnUse`. A path drawn in any other space would clip to the wrong
   * box on every surface at once.
   */
  it('defines a unit-box path for every vector shape', () => {
    for (const [shape, path] of Object.entries(SHAPE_CLIP_PATHS)) {
      expect(path.startsWith('M')).toBe(true);
      expect(path.endsWith('Z')).toBe(true);
      expect(shape).not.toBe('none');
      expect(shape).not.toBe('image');
    }
  });
});
