import { describe, expect, it } from 'vitest';

import type { LayerCrop } from '@shared/design/design-geometry.types';
import { canEnterCrop, cropIntentFor } from './crop-dispatch';
import { cropDefault } from './crop-geometry';
import type { EditorLayer } from './layer.types';

/*
 * A non-square frame and a non-square photo, as the geometry suite uses — so a
 * transposed axis cannot pass on a symmetric fixture.
 */
function layer(crop: Partial<LayerCrop> | null = { style: 'free' }, over: Partial<EditorLayer> = {}): EditorLayer {
  const base = { w: 200, h: 120, natW: 400, natH: 100, shape: 'circle' as const };

  return {
    id: 'L1',
    name: 'layer',
    src: 'art.png',
    natW: 400,
    natH: 100,
    kind: 'layer',
    cx: 100,
    cy: 100,
    w: 200,
    h: 120,
    rot: 0,
    style: 'free',
    opacity: 100,
    shape: 'circle',
    crop: crop === null ? null : ({ ...cropDefault(base), ...crop } as LayerCrop),
    visible: true,
    locked: false,
    ...over,
  };
}

describe('cropIntentFor', () => {
  it('pans the image when the merchant drags it', () => {
    const intent = cropIntentFor('cropped-layer', layer());

    expect(intent).toMatchObject({ kind: 'crop-move' });
  });

  it('carries the axes the inner style allows', () => {
    const intent = cropIntentFor('cropped-layer', layer({ style: 'fullw' }));

    expect(intent).toEqual({
      kind: 'crop-move',
      axes: { x: false, y: true, clamp: true },
    });
  });

  /*
   * 🔴 **A pinned image answers `none`, NOT `exit-crop`.** A `cover` image
   * fills its frame and cannot pan — but both grips live inside the same box,
   * so leaving crop mode on a press would make it impossible to rotate or
   * resize. The merchant has not asked to leave.
   */
  it('refuses to pan a pinned image without leaving crop mode', () => {
    expect(cropIntentFor('cropped-layer', layer({ style: 'cover' }))).toEqual({
      kind: 'none',
    });
  });

  it('starts a rotation from the image’s current angle', () => {
    expect(cropIntentFor('crop-rotate-handle', layer({ style: 'free', rot: 42 }))).toEqual({
      kind: 'crop-rotate',
      startRotationDeg: 42,
    });
  });

  it('starts a rotation from zero when there is no crop at all', () => {
    expect(cropIntentFor('crop-rotate-handle', layer(null))).toEqual({
      kind: 'crop-rotate',
      startRotationDeg: 0,
    });
  });

  it('resizes from the handle that was grabbed', () => {
    expect(cropIntentFor('crop-resize-handle', layer(), 'nw')).toEqual({
      kind: 'crop-resize',
      dir: 'nw',
    });
  });

  it('refuses a handle with no direction rather than guessing a corner', () => {
    expect(cropIntentFor('crop-resize-handle', layer())).toEqual({ kind: 'none' });
  });

  /*
   * ⚠️ **Outside the cropped layer LEAVES, and does not also act.** A click on
   * another layer while adjusting a photo is far more likely to be "I am
   * finished" than "select that, instantly" — the second click selects.
   */
  it('leaves crop mode on a click outside', () => {
    expect(cropIntentFor('outside', layer())).toEqual({ kind: 'exit-crop' });
  });

  it('leaves crop mode when the layer has gone', () => {
    /* A stale id: leaving is the safe answer rather than a dangling mode. */
    expect(cropIntentFor('cropped-layer', null)).toEqual({ kind: 'exit-crop' });
  });

  /*
   * 📌 Every hit answers differently, which is what stops the branches
   * collapsing into one.
   */
  it('gives four distinct answers for four distinct hits', () => {
    const kinds = [
      cropIntentFor('crop-rotate-handle', layer()).kind,
      cropIntentFor('crop-resize-handle', layer(), 'se').kind,
      cropIntentFor('cropped-layer', layer()).kind,
      cropIntentFor('outside', layer()).kind,
    ];

    expect(new Set(kinds).size).toBe(4);
  });
});

describe('canEnterCrop', () => {
  it('allows a shaped, unlocked layer', () => {
    expect(canEnterCrop(layer())).toBe(true);
  });

  it('refuses a plain layer, which has no frame to crop against', () => {
    expect(canEnterCrop(layer(null, { shape: 'none' }))).toBe(false);
  });

  it('refuses a locked layer, which is the merchant’s own refusal', () => {
    expect(canEnterCrop(layer(null, { locked: true }))).toBe(false);
  });

  it('refuses the background, which is fixed furniture', () => {
    expect(canEnterCrop(layer(null, { kind: 'background' }))).toBe(false);
  });

  it('refuses when nothing is selected', () => {
    expect(canEnterCrop(null)).toBe(false);
  });

  /*
   * 🔴 The cross-check: `canEnterCrop` must refuse exactly what `enterCrop`
   * refuses, or the UI offers a control that silently does nothing — the
   * lesson `layerCursor` already carries for dragging.
   */
  it('refuses every combination that makes cropping impossible', () => {
    const cases: Array<[EditorLayer, boolean]> = [
      [layer(), true],
      [layer(null, { shape: 'none' }), false],
      [layer(null, { locked: true }), false],
      [layer(null, { kind: 'background' }), false],
      [layer(null, { shape: 'none', locked: true }), false],
    ];

    for (const [l, expected] of cases) {
      expect(canEnterCrop(l)).toBe(expected);
    }
  });
});
