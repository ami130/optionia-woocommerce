import { describe, expect, it } from 'vitest';

import type { LayerStyle } from '@shared/design/design-geometry.types';
import type { EditorLayer } from './layer.types';
import {
  canAlign,
  canRotate,
  canSetOpacity,
  isEditable,
  panelState,
} from './properties-panel';

function layer(over: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id: 'L1',
    name: 'layer',
    src: 'img.png',
    natW: 200,
    natH: 100,
    kind: 'layer',
    cx: 100,
    cy: 100,
    w: 80,
    h: 40,
    rot: 0,
    style: 'free',
    opacity: 100,
    shape: 'none',
    visible: true,
    locked: false,
    ...over,
  };
}

/* Every style the model has. Testing a subset is what leaves a branch untested. */
const ALL_STYLES: LayerStyle[] = ['free', 'cover', 'fit', 'fullw', 'fullh'];

describe('isEditable', () => {
  it('allows an unlocked layer', () => {
    expect(isEditable(layer())).toBe(true);
  });

  it('refuses a locked layer', () => {
    expect(isEditable(layer({ locked: true }))).toBe(false);
  });

  it('refuses when nothing is selected', () => {
    expect(isEditable(null)).toBe(false);
  });

  it('still allows a HIDDEN layer, which is a view state and not a freeze', () => {
    /*
     * ⚠️ Easy to conflate with locked. A merchant hides a layer to see what is
     * under it and keeps editing; disabling the panel would make hiding a
     * one-way trip through the property controls.
     */
    expect(isEditable(layer({ visible: false }))).toBe(true);
  });
});

describe('canAlign', () => {
  /*
   * 🔴 The rule most likely to be over-tightened. Only `cover` fills both axes;
   * `fullw` spans the width but still sits top, middle or bottom, and `fit`
   * usually touches neither edge. Asserting style by style is what stops a
   * future "non-free styles can't align" simplification.
   */
  it.each(ALL_STYLES)('decides per style: %s', (style) => {
    const expected = style !== 'cover';

    expect(canAlign(layer({ style }))).toBe(expected);
  });

  it('refuses a locked layer whatever its style', () => {
    for (const style of ALL_STYLES) {
      expect(canAlign(layer({ style, locked: true }))).toBe(false);
    }
  });

  it('refuses when nothing is selected', () => {
    expect(canAlign(null)).toBe(false);
  });
});

describe('canRotate', () => {
  /*
   * 🔴 Narrower than canAlign, and the pair is the point: `fit` may align but
   * may NOT rotate, so a fixture covering only `free` and `cover` would let the
   * two predicates be collapsed into one without any test noticing.
   */
  it.each(ALL_STYLES)('decides per style: %s', (style) => {
    const expected = style === 'free';

    expect(canRotate(layer({ style }))).toBe(expected);
  });

  it('refuses a locked free layer', () => {
    expect(canRotate(layer({ style: 'free', locked: true }))).toBe(false);
  });

  it('refuses when nothing is selected', () => {
    expect(canRotate(null)).toBe(false);
  });

  it('is strictly narrower than aligning', () => {
    /*
     * 📌 The relationship itself, asserted: anything rotatable is alignable,
     * and at least one style is alignable but not rotatable. A collapse of the
     * two into one predicate fails here even if both style tables were edited
     * to agree.
     */
    const rotatable = ALL_STYLES.filter((style) => canRotate(layer({ style })));
    const alignable = ALL_STYLES.filter((style) => canAlign(layer({ style })));

    expect(rotatable.every((style) => alignable.includes(style))).toBe(true);
    expect(alignable.length).toBeGreaterThan(rotatable.length);
  });
});

describe('canSetOpacity', () => {
  it.each(ALL_STYLES)('allows any editable layer, including %s', (style) => {
    /* Opacity is the one property no fit mode recomputes. */
    expect(canSetOpacity(layer({ style }))).toBe(true);
  });

  it('refuses a locked layer', () => {
    expect(canSetOpacity(layer({ locked: true }))).toBe(false);
  });
});

describe('panelState', () => {
  it('turns everything off when nothing is selected', () => {
    expect(Object.values(panelState(null)).some(Boolean)).toBe(false);
  });

  it('turns everything off for a locked layer', () => {
    expect(Object.values(panelState(layer({ locked: true }))).some(Boolean)).toBe(false);
  });

  it('turns everything on for a free unlocked layer', () => {
    expect(Object.values(panelState(layer({ style: 'free' }))).every(Boolean)).toBe(true);
  });

  it('enables style, align and opacity but not rotation on a fitted layer', () => {
    /*
     * ⚠️ The mixed case, which is the only one that proves the fields are
     * independent — an all-on or all-off fixture passes with every field
     * wired to the same predicate.
     */
    expect(panelState(layer({ style: 'fit' }))).toEqual({
      editable: true,
      align: true,
      rotate: false,
      opacity: true,
      style: true,
    });
  });

  it('enables style and opacity but neither align nor rotation on a cover layer', () => {
    expect(panelState(layer({ style: 'cover' }))).toEqual({
      editable: true,
      align: false,
      rotate: false,
      opacity: true,
      style: true,
    });
  });
});
