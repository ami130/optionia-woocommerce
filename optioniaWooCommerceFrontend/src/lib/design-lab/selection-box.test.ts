import { describe, expect, it } from 'vitest';

import { dragIntentFor } from './drag-dispatch';
import type { EditorLayer } from './layer.types';
import {
  ALL_HANDLES,
  CORNER_HANDLES,
  drawnSelectionRect,
  handlesFor,
  layerCursor,
  selectionRect,
  showsHandles,
} from './selection-box';

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

describe('selectionRect', () => {
  /*
   * ⚠️ Asymmetric on purpose: cx !== cy and w !== h, so a transposed or
   * halved term cannot land on the right answer by coincidence.
   */
  it('resolves centre-and-size to corner-and-size', () => {
    expect(selectionRect(layer({ cx: 150, cy: 200, w: 120, h: 60 }))).toEqual({
      left: 90,
      top: 170,
      w: 120,
      h: 60,
    });
  });

  it('places a layer whose centre sits off the canvas at a negative corner', () => {
    expect(selectionRect(layer({ cx: -10, cy: 5, w: 80, h: 40 }))).toEqual({
      left: -50,
      top: -15,
      w: 80,
      h: 40,
    });
  });
});

describe('drawnSelectionRect', () => {
  /*
   * 🔴 The fixture that would have been degenerate: a layer wholly INSIDE the
   * canvas clips to itself, so clipping and not clipping agree and every
   * mutation survives. Each case below overhangs an edge by a known amount,
   * and the two clipped cases overhang DIFFERENT edges so a single-edge clamp
   * cannot pass both.
   */
  it('trims a fitted box that overhangs the top-left', () => {
    /* left = -40, top = -30: both past the origin by distinct amounts. */
    expect(
      drawnSelectionRect(layer({ style: 'fit', cx: 60, cy: 70, w: 200, h: 200 }), CW, CH),
    ).toEqual({ left: 0, top: 0, w: 160, h: 170 });
  });

  it('trims a fitted box that overhangs the bottom-right', () => {
    /* right = 440 (> 400), bottom = 500 (> 460), left/top inside. */
    expect(
      drawnSelectionRect(layer({ style: 'fit', cx: 340, cy: 400, w: 200, h: 200 }), CW, CH),
    ).toEqual({ left: 240, top: 300, w: 160, h: 160 });
  });

  it('leaves a fitted box that is already inside untouched', () => {
    expect(
      drawnSelectionRect(layer({ style: 'fit', cx: 150, cy: 200, w: 120, h: 60 }), CW, CH),
    ).toEqual({ left: 90, top: 170, w: 120, h: 60 });
  });

  it('never trims a free layer, however far it hangs off', () => {
    /*
     * ⚠️ The guard that matters: a free layer dragged half off-canvas keeps
     * its handles. Clipping here would hide the grip needed to drag it back.
     */
    expect(
      drawnSelectionRect(layer({ style: 'free', cx: -20, cy: 200, w: 200, h: 60 }), CW, CH),
    ).toEqual({ left: -120, top: 170, w: 200, h: 60 });
  });

  it('leaves a rotated box alone even when it overhangs', () => {
    /*
     * 🔴 Same overhang as the first case, differing ONLY in rot. If the
     * rotation guard is removed this returns the clipped rect, so the pair
     * pins the guard rather than the clamp.
     */
    expect(
      drawnSelectionRect(
        layer({ style: 'fit', rot: 12, cx: 60, cy: 70, w: 200, h: 200 }),
        CW,
        CH,
      ),
    ).toEqual({ left: -40, top: -30, w: 200, h: 200 });
  });

  it('collapses a box entirely off-canvas to zero rather than a negative size', () => {
    /* right = -20, so right - left is negative before the Math.max. */
    expect(
      drawnSelectionRect(layer({ style: 'cover', cx: -70, cy: 200, w: 100, h: 60 }), CW, CH),
    ).toMatchObject({ w: 0 });
  });

  it('clips a cover layer, which overhangs by construction', () => {
    /* cover fills the canvas and then some; the drawn box is the canvas. */
    expect(
      drawnSelectionRect(
        layer({ style: 'cover', cx: 200, cy: 230, w: 520, h: 600 }),
        CW,
        CH,
      ),
    ).toEqual({ left: 0, top: 0, w: CW, h: CH });
  });
});

describe('showsHandles', () => {
  it('shows handles on an unlocked free layer', () => {
    expect(showsHandles(layer())).toBe(true);
  });

  it('hides them on a locked layer', () => {
    expect(showsHandles(layer({ locked: true }))).toBe(false);
  });

  it('hides them on a styled layer, whose size the style owns', () => {
    /*
     * ⚠️ Both non-free styles are checked: `fit` resizes on every re-fit and
     * `cover` is pinned outright. Testing one would leave the other free to
     * drift.
     */
    expect(showsHandles(layer({ style: 'fit' }))).toBe(false);
    expect(showsHandles(layer({ style: 'cover' }))).toBe(false);
  });

  it('hides them on a layer that is both locked and styled', () => {
    expect(showsHandles(layer({ locked: true, style: 'fit' }))).toBe(false);
  });
});

describe('handlesFor', () => {
  it('gives a plain layer all eight', () => {
    expect(handlesFor(layer({ shape: 'none' }))).toEqual(ALL_HANDLES);
  });

  it('gives a square frame all eight, since it sizes freely', () => {
    expect(handlesFor(layer({ shape: 'square' }))).toEqual(ALL_HANDLES);
  });

  it('gives a ratio-locked frame corners only', () => {
    expect(handlesFor(layer({ shape: 'circle' }))).toEqual(CORNER_HANDLES);
  });

  it('treats a custom PNG frame as ratio-locked', () => {
    expect(handlesFor(layer({ shape: 'image', shapeSrc: 'mask.png' }))).toEqual(
      CORNER_HANDLES,
    );
  });

  /*
   * 📌 Pins the SETS themselves, not just which is returned. Writing the
   * expectation as `toEqual(ALL_HANDLES)` above compares a constant against
   * itself — true however that constant is edited. This is the one assertion
   * that would notice.
   */
  it('offers the eight compass points, corners among them', () => {
    expect([...ALL_HANDLES].sort()).toEqual(
      ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'].sort(),
    );
    expect([...CORNER_HANDLES].sort()).toEqual(['ne', 'nw', 'se', 'sw'].sort());
  });
});

describe('the overlay and the dispatcher agree', () => {
  /*
   * 🔴 The cross-check the two modules exist to make possible. A handle drawn
   * on a layer the dispatcher will not resize is a grip that does nothing;
   * the shared rule is `showsHandles`.
   */
  it('draws no handles on exactly the layers that cannot be freely resized', () => {
    const cases: Array<{ l: EditorLayer; drawn: boolean }> = [
      { l: layer(), drawn: true },
      { l: layer({ locked: true }), drawn: false },
      { l: layer({ style: 'fit' }), drawn: false },
      { l: layer({ style: 'cover' }), drawn: false },
      { l: layer({ style: 'fullw' }), drawn: false },
    ];

    for (const c of cases) {
      expect(showsHandles(c.l)).toBe(c.drawn);
    }
  });
});

describe('layerCursor', () => {
  it('offers a move cursor on a freely placed layer', () => {
    expect(layerCursor(layer({ style: 'free' }), CW, CH)).toBe('move');
  });

  it('shows the default arrow on a locked layer, whatever its style allows', () => {
    /*
     * ⚠️ The lock outranks the style. A free layer would otherwise read
     * `move`, promising a drag the dispatcher refuses.
     */
    expect(layerCursor(layer({ style: 'free', locked: true }), CW, CH)).toBe('default');
  });

  it('shows the default arrow on a cover layer, which cannot move at all', () => {
    expect(layerCursor(layer({ style: 'cover' }), CW, CH)).toBe('default');
  });

  it('offers a vertical cursor when only the vertical axis is free', () => {
    /* `fullw` spans the width, so only up and down remain. */
    expect(layerCursor(layer({ style: 'fullw' }), CW, CH)).toBe('ns-resize');
  });

  it('offers a horizontal cursor when only the horizontal axis is free', () => {
    expect(layerCursor(layer({ style: 'fullh' }), CW, CH)).toBe('ew-resize');
  });

  /*
   * 🔴 `fit` is the CONDITIONAL case, and the one the last four audits were
   * about: its axes depend on whether the layer fills each dimension, so a
   * fixture that fills both exercises a different branch from one that fills
   * neither. Testing a single `fit` layer would leave the comparison
   * degenerate.
   */
  it('reads a fitted layer axis by axis', () => {
    const narrow = layer({ style: 'fit', w: 100, h: 100 });

    expect(layerCursor(narrow, CW, CH)).toBe('move');

    const fillsWidth = layer({ style: 'fit', w: CW, h: 100 });

    expect(layerCursor(fillsWidth, CW, CH)).toBe('ns-resize');

    const fillsHeight = layer({ style: 'fit', w: 100, h: CH });

    expect(layerCursor(fillsHeight, CW, CH)).toBe('ew-resize');

    const fillsBoth = layer({ style: 'fit', w: CW, h: CH });

    expect(layerCursor(fillsBoth, CW, CH)).toBe('default');
  });

  /*
   * 📌 The cross-check that gives this function its purpose: the cursor must
   * say `default` on exactly the layers the dispatcher refuses to drag.
   * Anything else promises a gesture that will not happen.
   */
  it('shows the default arrow on exactly the layers that cannot be dragged', () => {
    const cases = [
      layer({ style: 'free' }),
      layer({ style: 'free', locked: true }),
      layer({ style: 'cover' }),
      layer({ style: 'fullw' }),
      layer({ style: 'fit', w: CW, h: CH }),
      layer({ style: 'fit', w: 100, h: 100 }),
    ];

    for (const l of cases) {
      const intent = dragIntentFor('layer', l, { cw: CW, ch: CH });
      const refused = intent.kind === 'select-only';

      expect(layerCursor(l, CW, CH) === 'default').toBe(refused);
    }
  });
});
