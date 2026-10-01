import { describe, expect, it } from 'vitest';

import { layerRect } from '@shared/design/layer-geometry';
import type { DesignLayer, LayerShape, LayerStyle } from '@shared/design/design-geometry.types';

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
 * 📌 **Verified by hand before being trusted.** A centre of (200, 230) on a
 * 400×460 canvas is x 0.5 / y 0.5, and the round trip is lossless. If a case
 * below fails, this conversion is the FIRST suspect — not the two
 * implementations it compares.
 */
function asDesignLayer(layer: EditorLayer): DesignLayer {
  return {
    name: layer.name,
    src: layer.src,
    natW: layer.natW,
    natH: layer.natH,
    pos: {
      xPct: layer.cx / CW,
      yPct: layer.cy / CH,
      wPct: layer.w / CW,
      hPct: layer.h / CH,
    },
    rot: layer.rot,
    style: layer.style,
    opacity: layer.opacity,
    shape: layer.shape,
    visible: layer.visible,
  };
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
