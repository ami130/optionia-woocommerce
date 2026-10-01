import { describe, expect, it } from 'vitest';

import { dragIntentFor, selectsLayer } from './drag-dispatch';
import type { EditorLayer } from './layer.types';

const CANVAS = { cw: 400, ch: 460 };

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

describe('dragIntentFor', () => {
  it('starts a move on a free layer, carrying its box', () => {
    const intent = dragIntentFor('layer', layer({ cx: 150, cy: 200 }), CANVAS);

    expect(intent).toMatchObject({
      kind: 'move',
      layerId: 'L1',
      start: { cx: 150, cy: 200, w: 120, h: 60 },
    });
  });

  it('starts a rotate from the layer’s current angle', () => {
    const intent = dragIntentFor('rotate-handle', layer({ rot: 137 }), CANVAS);

    expect(intent).toEqual({ kind: 'rotate', layerId: 'L1', startRotationDeg: 137 });
  });

  it('starts a resize carrying the handle and the box', () => {
    const intent = dragIntentFor('resize-handle', layer(), CANVAS, 'se');

    expect(intent).toMatchObject({ kind: 'resize', dir: 'se', start: { w: 120, h: 60 } });
  });

  it('deselects when the click lands on empty canvas', () => {
    expect(dragIntentFor('empty', null, CANVAS)).toEqual({ kind: 'deselect' });
  });

  it('does nothing for a hit that resolves to no layer', () => {
    /* A stale `data-id` after an undo replaced the layer array. */
    expect(dragIntentFor('layer', null, CANVAS)).toEqual({ kind: 'none' });
  });

  it('refuses a resize handle with no direction rather than guessing a corner', () => {
    expect(dragIntentFor('resize-handle', layer(), CANVAS)).toEqual({ kind: 'none' });
  });

  /**
   * 🔴 **Selection happens even when dragging does not, and the order matters.**
   *
   * A locked layer must still select: the merchant needs to see its properties
   * and reach the control that unlocks it. Refusing the whole interaction would
   * make a locked layer unselectable and the lock irreversible from the canvas.
   */
  describe('a layer that cannot be dragged', () => {
    it('still selects a locked layer, and says why it did not move', () => {
      const intent = dragIntentFor('layer', layer({ locked: true }), CANVAS);

      expect(intent).toEqual({ kind: 'select-only', layerId: 'L1', reason: 'locked' });
      expect(selectsLayer(intent)).toBe(true);
    });

    it('still selects a cover layer, whose style pins both axes', () => {
      const intent = dragIntentFor('layer', layer({ style: 'cover' }), CANVAS);

      expect(intent).toEqual({ kind: 'select-only', layerId: 'L1', reason: 'pinned' });
    });

    /**
     * ⚠️ **`fit` pins both axes only when the layer fills both**, which is a
     * CONDITIONAL path `cover` would never exercise. Testing only `cover` would
     * leave this one degenerate — the same trap that has produced a finding in
     * each of the last four audits.
     */
    it('pins a fit layer that fills both axes, and frees one that does not', () => {
      const filling = dragIntentFor(
        'layer',
        layer({ style: 'fit', w: 400, h: 460 }),
        CANVAS,
      );

      expect(filling).toMatchObject({ kind: 'select-only', reason: 'pinned' });

      /* The same style, narrower: one axis is free, so it moves. */
      const narrow = dragIntentFor(
        'layer',
        layer({ style: 'fit', w: 115, h: 460 }),
        CANVAS,
      );

      expect(narrow.kind).toBe('move');
    });

    it('distinguishes locked from pinned, which are different refusals', () => {
      /*
       * 📌 A lock is the merchant's own choice and reversible from the sidebar;
       * a pin is a consequence of the fit mode and needs a style change.
       * Collapsing them would leave the UI unable to explain either.
       */
      const locked = dragIntentFor('layer', layer({ locked: true, style: 'cover' }), CANVAS);

      /* Locked wins: it is the reason the merchant can act on. */
      expect(locked).toMatchObject({ reason: 'locked' });
    });

    it('lets a locked layer still be rotated or resized from its handles', () => {
      /*
       * ⚠️ Handles only render on the SELECTED layer's box, and the original
       * checks `locked` only on the layer branch — so reaching a handle means
       * the merchant deliberately grabbed one. Asserted so a later "tidy" that
       * adds a lock check to every branch is a visible change, not a silent one.
       */
      expect(dragIntentFor('rotate-handle', layer({ locked: true }), CANVAS).kind).toBe(
        'rotate',
      );
      expect(
        dragIntentFor('resize-handle', layer({ locked: true }), CANVAS, 'se').kind,
      ).toBe('resize');
    });
  });
});

describe('selectsLayer', () => {
  it('is true for every layer hit, draggable or not', () => {
    expect(selectsLayer(dragIntentFor('layer', layer(), CANVAS))).toBe(true);
    expect(selectsLayer(dragIntentFor('layer', layer({ locked: true }), CANVAS))).toBe(true);
  });

  it('is false for handles, which only exist on an already-selected layer', () => {
    expect(selectsLayer(dragIntentFor('rotate-handle', layer(), CANVAS))).toBe(false);
    expect(selectsLayer(dragIntentFor('resize-handle', layer(), CANVAS, 'se'))).toBe(false);
  });

  it('is false for a deselect', () => {
    expect(selectsLayer(dragIntentFor('empty', null, CANVAS))).toBe(false);
  });
});
