import { describe, expect, it } from 'vitest';

import { layerRect } from '@shared/design/layer-geometry';
import type { DesignLayer, LayerShape, LayerStyle } from '@shared/design/design-geometry.types';

import { editorLayerToDesign } from './store';
import { applyStyleGeometry, freeDefaultSize } from './style-geometry';
import type { EditorLayer } from './layer.types';

/**
 * The editor and the renderer must agree about fit modes.
 *
 * 🔴 **Nothing enforced this before.** `applyStyleGeometry` writes a layer when
 * its style changes; `layerRect` reads one on every render. Both implement
 * `cover` / `fit` / `fullw` / `fullh`, in different coordinate spaces, and the
 * only thing tying them together in `optionia-app` was a comment in each file
 * pointing at the other — the arrangement that produced this project's `1.25`
 * line-height and `'month' | 'year'` defects.
 *
 * ⚠️ **A merchant picks a fit mode in the editor and a factory prints the
 * result.** If the two drift, the proof they approved is not the object they
 * receive.
 */

const CW = 400;
const CH = 460;

function editorLayer(over: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id: 'L1',
    name: 'layer',
    src: 'img.png',
    natW: 200,
    natH: 100,
    kind: 'layer',
    cx: 150,
    cy: 200,
    w: 120,
    h: 60,
    rot: 0,
    style: 'free',
    opacity: 100,
    shape: 'none',
    visible: true,
    locked: false,
    ...over,
  };
}

/**
 * The editor layer as the renderer would read it back.
 *
 * 🔴 **The PRODUCTION conversion, not a copy.** This fixture previously did the
 * arithmetic by hand — so the suite validated a test helper against the renderer
 * while production had no conversion at all, and writing one later would have
 * been a second implementation nothing checked. That is the duplication class
 * this port exists to prevent, created by the test meant to prevent it.
 *
 * 📌 Verified by hand before being trusted: a centre of (200, 230) on a 400×460
 * canvas is x 0.5 / y 0.5, and the round trip is lossless. If a case below
 * fails, this conversion is the FIRST suspect — not the two implementations it
 * compares.
 */
function asDesignLayer(layer: EditorLayer): DesignLayer {
  return editorLayerToDesign(layer, CW, CH);
}


/* 🔴 `free` is excluded BY NAME, not silently — see the suite below. */
const SHARED_STYLES: readonly LayerStyle[] = ['cover', 'fit', 'fullw', 'fullh'];
const SHAPES: readonly LayerShape[] = ['none', 'square', 'image', 'circle', 'star'];

describe('fit modes agree between the editor and the renderer', () => {
  it.each(
    SHARED_STYLES.flatMap((style) => SHAPES.map((shape) => [style, shape] as const)),
  )('%s on a %s layer', (style, shape) => {
    const layer = editorLayer({ style, shape });

    /* The editor writes the layer for its style… */
    applyStyleGeometry(layer, CW, CH);

    /* …and the renderer reads the same layer back. */
    const rect = layerRect(asDesignLayer(layer), CW, CH);

    expect(rect.w).toBeCloseTo(layer.w, 6);
    expect(rect.h).toBeCloseTo(layer.h, 6);
    expect(rect.cx).toBeCloseTo(layer.cx, 6);
    expect(rect.cy).toBeCloseTo(layer.cy, 6);
  });

  it('agrees at a different canvas aspect, so neither hard-codes one', () => {
    for (const style of SHARED_STYLES) {
      const layer = editorLayer({ style, natW: 300, natH: 400 });

      applyStyleGeometry(layer, 800, 300);

      const rect = layerRect(
        {
          ...asDesignLayer(layer),
          pos: {
            xPct: layer.cx / 800,
            yPct: layer.cy / 300,
            wPct: layer.w / 800,
            hPct: layer.h / 300,
          },
        },
        800,
        300,
      );

      expect(rect.w).toBeCloseTo(layer.w, 6);
      expect(rect.h).toBeCloseTo(layer.h, 6);
    }
  });

  /**
   * 🔴 **`fit` keeps a dragged centre, and the first version of this suite could
   * not see that.**
   *
   * Every case above used a 200×100 image on a 400×460 canvas, which `fit`
   * scales to exactly the canvas width — so `clampInside(cx, 200, 400)` has
   * `lo === hi === 200` and returns 200 whatever was stored. The clamp
   * SATURATED, and replacing it with plain centring passed all 25 tests.
   *
   * ⚠️ **A tall narrow image leaves a real band.** 50×200 fits to 115×460, so a
   * stored centre anywhere in [57.5, 342.5] must survive untouched — which is
   * the documented behaviour: *"a dragged `fit` frame remembers its position
   * across re-open"*.
   */
  describe('fit remembers where the merchant dragged it', () => {
    /* 50x200 fits to 115x460 on this canvas: the horizontal band is real. */
    const TALL = { natW: 50, natH: 200 };

    it('keeps a centre that sits inside the band', () => {
      const layer = editorLayer({ ...TALL, style: 'fit', cx: 120, cy: 300 });

      applyStyleGeometry(layer, CW, CH);

      /* Untouched horizontally — 120 is within [57.5, 342.5]. */
      expect(layer.cx).toBeCloseTo(120, 6);

      /* Vertically `fit` fills the axis, so the centre is forced. */
      expect(layer.cy).toBeCloseTo(CH / 2, 6);
    });

    it('pulls a centre that would hang off the edge back inside', () => {
      const layer = editorLayer({ ...TALL, style: 'fit', cx: 5, cy: 300 });

      applyStyleGeometry(layer, CW, CH);

      /* Clamped to half its own width, not to zero. */
      expect(layer.cx).toBeCloseTo(layer.w / 2, 6);
    });

    it('agrees with the renderer at a remembered position', () => {
      /*
       * 📌 The parity cases above all saturate here, so this is the one that
       * proves the editor and renderer treat a REMEMBERED centre the same way.
       */
      const layer = editorLayer({ ...TALL, style: 'fit', cx: 120, cy: 300 });

      applyStyleGeometry(layer, CW, CH);

      const rect = layerRect(asDesignLayer(layer), CW, CH);

      expect(rect.cx).toBeCloseTo(layer.cx, 6);
      expect(rect.cy).toBeCloseTo(layer.cy, 6);
      expect(rect.w).toBeCloseTo(layer.w, 6);
      expect(rect.h).toBeCloseTo(layer.h, 6);
    });
  });

  /**
   * ⚠️ **Rotation is zeroed for every non-free style, and nothing asserted it.**
   *
   * Removing `layer.rot = 0` from `cover` survived all 25 tests. The renderer
   * ignores stored rotation for non-free styles — `rotationOf` returns 0
   * regardless — so a drift here changes no pixel today. It is asserted anyway:
   * the stored value is what a future surface would read, and "harmless because
   * one reader happens to ignore it" is a property nothing holds in place.
   */
  it.each(SHARED_STYLES)('%s zeroes rotation, as the renderer assumes', (style) => {
    const layer = editorLayer({ style, rot: 37 });

    applyStyleGeometry(layer, CW, CH);

    expect(layer.rot).toBe(0);
  });

  /**
   * 🔴 **`free` is the one style that does NOT agree, and that is correct.**
   *
   * In the editor it picks a DEFAULT size for a newly added layer; in the
   * renderer it returns the STORED box. The store never calls
   * `applyStyleGeometry` for a free layer — `if (layer.style !== 'free')` — so
   * the asymmetry is unreachable rather than a disagreement.
   *
   * ⚠️ Asserted rather than skipped, so the exclusion is a recorded decision
   * and not a gap someone later mistakes for coverage.
   */
  it('free sizes a NEW layer in the editor and keeps the stored box when read', () => {
    const layer = editorLayer({ style: 'free', w: 10, h: 5 });

    applyStyleGeometry(layer, CW, CH);

    /* The editor replaced the tiny box with a sensible default… */
    expect(layer.w).toBeGreaterThan(10);
    expect(layer.w).toBe(freeDefaultSize(layer.natW, layer.natH, CW, CH).w);

    /* …and the renderer honours whatever is stored, whatever that is. */
    const stored = editorLayer({ style: 'free', w: 10, h: 5 });
    const rect = layerRect(asDesignLayer(stored), CW, CH);

    expect(rect.w).toBeCloseTo(10, 6);
  });
});

describe('freeDefaultSize', () => {
  it('takes half the constraining axis, keeping the image aspect', () => {
    /*
     * ✏️ A 2:1 image on a 400×460 canvas: `bgRatio` 0.87 is NOT greater than
     * `layerRatio` 2, so the WIDTH branch applies — half of 400, height follows
     * the image's own 2:1. My first expectation said `h: 200`, which would have
     * been square and is exactly the aspect distortion this function avoids.
     */
    expect(freeDefaultSize(200, 100, 400, 460)).toEqual({ w: 200, h: 100 });

    /* A 1:2 image on a wide canvas constrains by HEIGHT instead. */
    expect(freeDefaultSize(100, 200, 1000, 400)).toEqual({ w: 100, h: 200 });
  });

  it('never distorts the image, whatever the canvas', () => {
    for (const [natW, natH] of [[200, 100], [100, 200], [50, 50], [1920, 1080]]) {
      for (const [cw, ch] of [[400, 460], [1000, 400], [300, 300]]) {
        const size = freeDefaultSize(natW, natH, cw, ch);

        expect(size.w / size.h).toBeCloseTo(natW / natH, 9);
      }
    }
  });

  it('falls back to a square ratio rather than dividing by zero', () => {
    expect(freeDefaultSize(0, 0, 400, 460)).toEqual({ w: 200, h: 200 });
  });
});
