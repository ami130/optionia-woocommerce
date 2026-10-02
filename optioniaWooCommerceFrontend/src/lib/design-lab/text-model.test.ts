import { describe, expect, it } from 'vitest';

import { TEXT_FONTS } from '@shared/design/design-geometry.types';
import { resolveSceneText } from '@shared/design/text-geometry';
import {
  DEFAULT_SAMPLE_TEXT,
  MAX_TEXT_CURVE,
  MIN_TEXT_SIZE,
  clampText,
  defaultText,
  designTextToEditor,
  editorTextToDesign,
  type EditorText,
} from './text-model';

/*
 * 🔴 **A canvas that is NOT square.** Every fraction here divides by width or by
 * height, and on a square canvas the two are the same number — so a fixture at
 * 400×400 would let `sizePct: size / width` pass. 400×460 is the store's own
 * aspect and makes each division distinguishable.
 */
const CW = 400;
const CH = 460;

function text(over: Partial<EditorText> = {}): EditorText {
  return { ...defaultText(CW, CH), ...over };
}

describe('defaultText', () => {
  it('centres a new text on the canvas', () => {
    const t = defaultText(CW, CH);

    expect(t.cx).toBe(CW / 2);
    expect(t.cy).toBe(CH / 2);
  });

  it('starts with sample wording the merchant will replace', () => {
    expect(defaultText(CW, CH).text).toBe(DEFAULT_SAMPLE_TEXT);
  });

  it('starts auto-growing, so a new text is never clipped before it is placed', () => {
    expect(defaultText(CW, CH).h).toBe(0);
  });

  it('uses a font from the licensed list', () => {
    expect(TEXT_FONTS).toContain(defaultText(CW, CH).font);
  });

  it('scales with the canvas rather than using fixed pixels', () => {
    /* ⚠️ A text made on a tall canvas and one on a short canvas look alike. */
    const small = defaultText(200, 230);
    const large = defaultText(400, 460);

    expect(large.size).toBeCloseTo(small.size * 2, 0);
    expect(large.w).toBeCloseTo(small.w * 2, 0);
  });
});

describe('editorTextToDesign', () => {
  /*
   * 🔴 **Size divides by HEIGHT, position by the matching axis.** The stored
   * contract says so, and dividing by the wrong dimension produces text that is
   * the right size only on a square canvas — which is exactly the fixture a
   * careless test would use.
   */
  it('stores the size as a fraction of the canvas HEIGHT', () => {
    expect(editorTextToDesign(text({ size: 46 }), CW, CH).sizePct).toBeCloseTo(0.1);
  });

  it('stores letter spacing as a fraction of the HEIGHT too', () => {
    expect(
      editorTextToDesign(text({ letterSpacing: 23 }), CW, CH).letterSpacing,
    ).toBeCloseTo(0.05);
  });

  it('stores the position against its matching axis', () => {
    const stored = editorTextToDesign(text({ cx: 100, cy: 115, w: 200 }), CW, CH);

    /* 100/400, 115/460, 200/400 — three fractions, two denominators. */
    expect(stored.pos.xPct).toBeCloseTo(0.25);
    expect(stored.pos.yPct).toBeCloseTo(0.25);
    expect(stored.pos.wPct).toBeCloseTo(0.5);
  });

  /*
   * 📌 **Auto-grow OMITS `hPct` rather than storing zero.** The reader treats
   * an absent height as auto-grow; writing `0` would be a second spelling of
   * the same state that every consumer must then handle.
   */
  it('omits the box height when the text auto-grows', () => {
    expect(editorTextToDesign(text({ h: 0 }), CW, CH).pos.hPct).toBeUndefined();
  });

  it('stores the box height when it is fixed', () => {
    expect(editorTextToDesign(text({ h: 92 }), CW, CH).pos.hPct).toBeCloseTo(0.2);
  });

  it('omits letter spacing when it is zero', () => {
    expect(editorTextToDesign(text({ letterSpacing: 0 }), CW, CH).letterSpacing).toBeUndefined();
  });

  it('omits the advance ratio when nothing has measured it', () => {
    expect(editorTextToDesign(text(), CW, CH).advanceRatio).toBeUndefined();
  });

  it('carries a measured advance ratio unchanged, since it is scale-invariant', () => {
    expect(editorTextToDesign(text({ advanceRatio: 0.54 }), CW, CH).advanceRatio).toBe(0.54);
  });

  it('survives a zero canvas rather than dividing by it', () => {
    /* ⚠️ A browser reports zeroes for a canvas not yet laid out. */
    const stored = editorTextToDesign(text(), 0, 0);

    expect(Number.isFinite(stored.sizePct)).toBe(true);
    expect(Number.isFinite(stored.pos.xPct)).toBe(true);
  });
});

describe('designTextToEditor', () => {
  it('defaults an absent valign to middle, the legacy behaviour', () => {
    const stored = editorTextToDesign(text(), CW, CH);

    /* A design composed before `valign` existed carries no such field. */
    delete stored.valign;

    expect(designTextToEditor(stored, CW, CH).valign).toBe('middle');
  });

  it('treats an absent box height as auto-grow', () => {
    const stored = editorTextToDesign(text({ h: 0 }), CW, CH);

    expect(designTextToEditor(stored, CW, CH).h).toBe(0);
  });

  it('treats absent letter spacing as zero', () => {
    const stored = editorTextToDesign(text({ letterSpacing: 0 }), CW, CH);

    expect(designTextToEditor(stored, CW, CH).letterSpacing).toBe(0);
  });
});

describe('the round trip', () => {
  /*
   * 🔴 **The property that makes a design re-place correctly.** Every field
   * must survive editor → stored → editor, or a merchant's text moves or
   * resizes itself on reload.
   */
  it('returns the same text after a round trip', () => {
    const original = text({
      text: 'Hello',
      /*
       * ⚠️ **NOT the default font.** Every other field here differs from the
       * default too, but `font` is the one a conversion could hardcode without
       * arithmetic — so with `Roboto` this assertion could not tell a copied
       * field from a constant one.
       */
      font: 'Pacifico',
      size: 46,
      bold: true,
      italic: true,
      align: 'right',
      valign: 'bottom',
      color: '#ff0000',
      cx: 120,
      cy: 300,
      w: 240,
      h: 92,
      rot: 15,
      curve: 40,
      letterSpacing: 23,
      advanceRatio: 0.58,
    });

    expect(designTextToEditor(editorTextToDesign(original, CW, CH), CW, CH)).toEqual(
      original,
    );
  });

  it('re-places on a DIFFERENT canvas by the same fractions', () => {
    /*
     * ⚠️ The whole point of storing fractions: a text composed on one canvas
     * lands proportionally on another, rather than at the same pixels.
     */
    const original = text({ cx: 100, cy: 115, w: 200, size: 46 });
    const stored = editorTextToDesign(original, CW, CH);
    const onDouble = designTextToEditor(stored, CW * 2, CH * 2);

    expect(onDouble.cx).toBeCloseTo(200);
    expect(onDouble.cy).toBeCloseTo(230);
    expect(onDouble.w).toBeCloseTo(400);
    expect(onDouble.size).toBeCloseTo(92);
  });
});

describe('bounds', () => {
  /*
   * 🔴 **The editor is the ONLY gatekeeper in this chain.** The renderer clamps
   * `curve` to ±100 before drawing but the API stores a design body
   * unvalidated, so an unclamped editor means the lab draws one arc and the
   * printed object carries another — the exact what-you-see-is-not-what-you-get
   * failure this milestone exists to prevent.
   */
  it.each([
    ['above the maximum', 500, MAX_TEXT_CURVE],
    ['below the minimum', -500, -MAX_TEXT_CURVE],
    ['at the maximum', 100, 100],
    ['within range', 40, 40],
  ])('clamps a curve %s', (_name, given, expected) => {
    const t = text({ curve: given });

    clampText(t);

    expect(t.curve).toBe(expected);
  });

  it('clamps the curve to what the renderer would draw', () => {
    /*
     * ⚠️ **Compared against the RENDERER, not against a constant.** A test
     * asserting `100 === 100` would pass with both sides wrong together; this
     * fails if the two surfaces ever disagree.
     */
    const t = text({ curve: 500 });

    clampText(t);

    expect(t.curve).toBe(resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH).curve);
  });

  it.each([
    ['negative', -50],
    ['zero', 0],
  ])('floors a %s font size', (_name, given) => {
    const t = text({ size: given });

    clampText(t);

    expect(t.size).toBe(MIN_TEXT_SIZE);
  });

  it('floors a negative box width', () => {
    const t = text({ w: -10 });

    clampText(t);

    expect(t.w).toBe(MIN_TEXT_SIZE);
  });

  it('leaves a size above the floor alone', () => {
    const t = text({ size: 46 });

    clampText(t);

    expect(t.size).toBe(46);
  });

  /*
   * 🔴 **Zero height is auto-grow, a BEHAVIOUR, so it must survive the floor.**
   * Flooring it to 4 would silently turn every auto-growing text into a fixed
   * 4px box that clips everything.
   */
  it('keeps an auto-growing height at zero', () => {
    const t = text({ h: 0 });

    clampText(t);

    expect(t.h).toBe(0);
  });

  it('floors a negative fixed height rather than reading it as auto-grow', () => {
    const t = text({ h: -20 });

    clampText(t);

    expect(t.h).toBe(MIN_TEXT_SIZE);
  });

  /*
   * ⚠️ **Negative letter spacing is LEGITIMATE** — tightening a run is a real
   * typographic choice and the renderer scales it without complaint.
   */
  it('keeps negative letter spacing', () => {
    const t = text({ letterSpacing: -3 });

    clampText(t);

    expect(t.letterSpacing).toBe(-3);
  });

  it.each([
    ['size', 'size'],
    ['curve', 'curve'],
    ['rot', 'rot'],
    ['letterSpacing', 'letterSpacing'],
  ] as const)('replaces a non-finite %s', (_name, field) => {
    const t = text({ [field]: Number.NaN });

    clampText(t);

    expect(Number.isFinite(t[field])).toBe(true);
  });

  /*
   * 📌 **An unusable advance ratio is DROPPED, not floored.**
   * `resolveSceneText` treats a non-positive ratio as absent and falls back to
   * `CHAR_ADVANCE`; a clamped-to-tiny ratio would instead size every arc to a
   * glyph width no font has.
   */
  it.each([
    ['zero', 0],
    ['negative', -0.5],
    ['non-finite', Number.NaN],
  ])('drops a %s advance ratio', (_name, given) => {
    const t = text({ advanceRatio: given });

    clampText(t);

    expect(t.advanceRatio).toBeUndefined();
  });

  it('keeps a usable advance ratio', () => {
    const t = text({ advanceRatio: 0.54 });

    clampText(t);

    expect(t.advanceRatio).toBe(0.54);
  });

  /*
   * ⚠️ **A canvas can be smaller than the floor.** A store whose size is not
   * set yet reports 0×0, and a percentage of nothing is nothing.
   */
  it('keeps a default on a zero canvas inside the bounds', () => {
    const t = defaultText(0, 0);

    expect(t.size).toBe(MIN_TEXT_SIZE);
    expect(t.w).toBe(MIN_TEXT_SIZE);
  });
});
