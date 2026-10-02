import { describe, expect, it } from 'vitest';

import { curveBoxPlace, curveRotOrigin } from '@shared/design/arc-geometry';
import {
  LINE_HEIGHT,
  fitTextToBox,
  flatBlockFirstY,
  resolveSceneText,
  wrapTextLines,
} from '@shared/design/text-geometry';

import { defaultText, editorTextToDesign, type EditorText } from './text-model';
import { placeText } from './text-render';

/* 🔴 Non-square, so a height/width transposition cannot pass. */
const CW = 400;
const CH = 460;

function text(over: Partial<EditorText> = {}): EditorText {
  return { ...defaultText(CW, CH), ...over };
}

describe('flat text', () => {
  it('wraps into the lines the renderer will draw', () => {
    const t = text({ text: 'one two three four five six seven', w: 120, size: 20 });
    const p = placeText(t, CW, CH);

    expect(p.kind).toBe('flat');
    expect(p.kind === 'flat' && p.lines.length).toBeGreaterThan(1);
  });

  /*
   * 🔴 **An auto-growing box keeps the merchant's size and grows downward.**
   * Shrinking it would make the size control stop doing anything once the text
   * got long — and the same text in a FIXED box of the height it grew to does
   * shrink, which is what tells the two branches apart.
   */
  it('keeps the merchant size when the box auto-grows', () => {
    const long = 'a very long run of words that will wrap many times over';
    const auto = placeText(text({ text: long, h: 0, size: 40, w: 100 }), CW, CH);

    if (auto.kind !== 'flat') throw new Error('expected flat');

    expect(auto.fontSize).toBe(40);

    /* The same text in a fixed box of that height is shrunk — so `h` is what decides. */
    const grown = auto.lines.length * auto.lineHeight;
    const fixed = placeText(text({ text: long, h: grown / 2, size: 40, w: 100 }), CW, CH);

    expect(fixed.kind === 'flat' && fixed.fontSize).toBeLessThan(40);
  });

  /*
   * ⚠️ **Shrink-to-fit runs only for a FIXED box**, and shrink-only: the size
   * control must keep meaning something once the text gets long.
   */
  it('shrinks to fit a fixed box', () => {
    const t = text({ text: 'a very long run of words that will wrap', h: 40, size: 40, w: 100 });
    const p = placeText(t, CW, CH);

    expect(p.kind === 'flat' && p.fontSize).toBeLessThan(40);
  });

  /*
   * 🔴 **Wrapped at the FITTED size, not the merchant's.** `fitTextToBox`
   * shrinks the font so the block fits; wrapping at the original size would
   * measure one layout and draw another — more lines than the fit allowed for,
   * overflowing the box it just shrank to fit.
   */
  it('wraps at the shrunken size, not the size the merchant set', () => {
    const t = text({ text: 'one two three four five six seven', h: 36, size: 40, w: 120 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'flat') throw new Error('expected flat');

    expect(p.fontSize).toBeLessThan(40);
    /* At 40px these words wrap into many more lines than at the fitted size. */
    expect(p.lines).toEqual(
      wrapTextLines(t.text, p.fontSize, p.letterSpacing, t.w, t.advanceRatio),
    );
    expect(p.lines).not.toEqual(
      wrapTextLines(t.text, 40, t.letterSpacing, t.w, t.advanceRatio),
    );
  });

  it('never grows past the merchant size in a roomy box', () => {
    const t = text({ text: 'hi', h: 400, size: 20, w: 300 });
    const p = placeText(t, CW, CH);

    expect(p.kind === 'flat' && p.fontSize).toBe(20);
  });

  it.each([
    ['left', 'left', CW / 2 - 100],
    ['centre', 'center', CW / 2],
    ['right', 'right', CW / 2 + 100],
  ] as const)('anchors %s text at the box edge', (_n, align, expected) => {
    const t = text({ align, w: 200, cx: CW / 2 });

    expect(placeText(t, CW, CH).kind === 'flat' && (placeText(t, CW, CH) as { anchorX: number }).anchorX)
      .toBe(expected);
  });
});

describe('flat placement matches the renderer', () => {
  /*
   * 🔴 **The parity that matters most.** `flatFirstY` re-expresses
   * `flatBlockFirstY` over the editor's own text rather than the renderer's
   * resolved scene — two spellings of one rule, which is exactly the shape that
   * silently diverges. Asserted against the shared function, never against a
   * number I chose.
   */
  it.each([
    ['top', 'top'],
    ['middle', 'middle'],
    ['bottom', 'bottom'],
  ] as const)('places a %s-aligned fixed box where the renderer does', (_n, valign) => {
    const t = text({ text: 'one two three four five', valign, h: 200, w: 150, size: 24 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'flat') throw new Error('expected flat');

    const scene = resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH);

    expect(p.firstY).toBeCloseTo(
      flatBlockFirstY(valign, scene.cy, scene.h, p.lines.length, p.lineHeight),
      6,
    );
  });

  it('places an auto-growing box where the renderer does', () => {
    const t = text({ text: 'one two three four five', h: 0, w: 150, size: 24 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'flat') throw new Error('expected flat');

    const scene = resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH);

    expect(p.firstY).toBeCloseTo(
      flatBlockFirstY('middle', scene.cy, scene.h, p.lines.length, p.lineHeight),
      6,
    );
  });

  /*
   * ⚠️ **Compared against the renderer's OWN fit**, not against the editor's
   * number rearranged. An assertion that divides by the thing it is checking
   * proves only that division works.
   */
  it('shrinks by the same amount the renderer would', () => {
    const t = text({ text: 'a very long run of words that will wrap', h: 40, size: 40, w: 100 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'flat') throw new Error('expected flat');

    const scene = resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH);
    const theirs = fitTextToBox(
      scene.text,
      scene.fontSize,
      scene.letterSpacing,
      scene.w,
      scene.h,
      scene.advanceRatio,
    );

    expect(p.fontSize).toBeCloseTo(theirs.fontSize, 6);
    expect(p.letterSpacing).toBeCloseTo(theirs.letterSpacing, 6);
    /* The fixture must actually shrink, or this compares two unshrunk sizes. */
    expect(p.fontSize).toBeLessThan(40);
  });

  /*
   * 🔴 **The wrap must match too, not only the size.** The renderer emits one
   * `<tspan>` per line from exactly this call; a canvas that wrapped
   * differently would fit in the editor and overflow in the print file.
   */
  it('wraps into the same lines the renderer would', () => {
    const t = text({ text: 'one two three four five six seven eight', h: 0, w: 120, size: 20 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'flat') throw new Error('expected flat');

    const scene = resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH);

    expect(p.lines).toEqual(
      wrapTextLines(scene.text, scene.fontSize, scene.letterSpacing, scene.w, scene.advanceRatio),
    );
    expect(p.lines.length).toBeGreaterThan(1);
  });
});

describe('line height', () => {
  /*
   * 🔴 **`LINE_HEIGHT`, not a number that looks right.** `fitTextToBox` uses
   * the same constant to decide how many lines fit; if the two diverged, text
   * would be MEASURED at one line height and DRAWN at another — fitting in the
   * editor and overflowing the print file.
   */
  it('spaces lines by the shared constant', () => {
    const p = placeText(text({ text: 'one two three four five six', h: 0, w: 120, size: 20 }), CW, CH);

    if (p.kind !== 'flat') throw new Error('expected flat');

    expect(p.lineHeight).toBeCloseTo(p.fontSize * LINE_HEIGHT, 6);
  });
});

describe('curved text', () => {
  it('becomes an arc once the curve is non-zero', () => {
    expect(placeText(text({ curve: 40 }), CW, CH).kind).toBe('curved');
  });

  it('stays flat at exactly zero', () => {
    expect(placeText(text({ curve: 0 }), CW, CH).kind).toBe('flat');
  });

  /*
   * 🔴 **Zero is the boundary, and it is EXACT** — the renderer branches on
   * `curve !== 0` too. A threshold like `> 1` would draw the faintest arcs flat
   * in the editor and curved on the object.
   */
  it.each([0.5, -0.5])('curves at %s, however slight', (curve) => {
    expect(placeText(text({ curve }), CW, CH).kind).toBe('curved');
  });

  it('arcs in both directions', () => {
    const up = placeText(text({ curve: 40 }), CW, CH);
    const down = placeText(text({ curve: -40 }), CW, CH);

    expect(up.kind === 'curved' && down.kind === 'curved' && up.d).not.toBe(
      down.kind === 'curved' ? down.d : '',
    );
  });

  /*
   * 🔴 **Alignment does not move the arc.** The ring already spans the box, so
   * horizontal alignment picks where the run starts along it. Moving the box
   * here would double-apply it.
   */
  it.each(['left', 'center', 'right'] as const)(
    'centres the arc horizontally whatever the %s alignment',
    (align) => {
      const p = placeText(text({ curve: 40, align, h: 200 }), CW, CH);

      if (p.kind !== 'curved') throw new Error('expected curved');

      expect(p.left + p.width / 2).toBeCloseTo(CW / 2, 6);
    },
  );

  /*
   * ⚠️ **The box width must DIFFER from the arc width**, or shifting the arc by
   * the box has nothing to shift it by. Below ~curve 70 the ring SPANS the box
   * and the two are equal — a `curve: 40` fixture passed with the alignment
   * double-applied. At 70 the ring inscribes instead: 320 box, ~252 arc.
   */
  it('places a left-aligned arc exactly where a centred one lands', () => {
    const centred = placeText(text({ text: 'abc', curve: 70, align: 'center', h: 200, w: 320 }), CW, CH);
    const left = placeText(text({ text: 'abc', curve: 70, align: 'left', h: 200, w: 320 }), CW, CH);

    if (centred.kind !== 'curved' || left.kind !== 'curved') throw new Error('expected curved');

    expect(left.width).not.toBeCloseTo(320, 0);
    expect(left.left).toBeCloseTo(centred.left, 6);
  });
});

describe('curved placement matches the renderer', () => {
  /*
   * 🔴 **The fixed/legacy clamp split, pinned against the shared function.**
   * `curveBoxPlace` records what was measured when the editor and renderer
   * disagreed here: ~221px of arc shift, and an arc wider than the canvas
   * pinned to `left = 0` — left-aligning text the editor had centred.
   */
  /*
   * ⚠️ **`cx: 10` pushes the arc off the left edge, and that is the point.** An
   * arc resting comfortably inside the canvas is placed identically whether the
   * clamp runs or not — the first version of this test used one, and removing
   * the clamp entirely still passed it.
   */
  it.each([
    ['a fixed box', 200],
    ['a legacy auto-height box', 0],
  ])('places the arc of %s where the renderer does', (_n, h) => {
    const t = text({ text: 'curved words here', curve: 60, h, w: 200, cx: 10 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'curved') throw new Error('expected curved');

    const scene = resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH);
    const expected = curveBoxPlace(scene, p.width, p.height, CW, CH);

    expect({ left: p.left, top: p.top }).toEqual({
      left: expect.closeTo(expected.left, 6),
      top: expect.closeTo(expected.top, 6),
    });
  });

  /*
   * ⚠️ **An arc WIDER than the canvas is the case the clamp split was found
   * by.** A fixed box must not be pinned to the edge.
   */
  it('clamps a legacy arc back inside the canvas', () => {
    const t = text({ text: 'curved words here', curve: 60, h: 0, w: 200, cx: 10 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'curved') throw new Error('expected curved');

    /* Unclamped this would be ~-86: the clamp is doing work here. */
    expect(text({ cx: 10 }).cx - p.width / 2).toBeLessThan(0);
    expect(p.left).toBe(0);
  });

  it('does not clamp a fixed box whose arc overflows the canvas', () => {
    const t = text({ text: 'a long curved run of words', curve: 20, h: 200, w: 900, cx: 40 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'curved') throw new Error('expected curved');

    const scene = resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH);

    expect(p.left).toBeCloseTo(curveBoxPlace(scene, p.width, p.height, CW, CH).left, 6);
    expect(p.left).toBeLessThan(0);
  });

  it.each([
    ['a fixed box', 200],
    ['a legacy auto-height box', 0],
  /*
   * ⚠️ **`cy: 60` is what separates the two branches.** With the text centred,
   * the legacy arc's bbox centre and the box centre are the SAME point, so a
   * version that always used `(cx, cy)` passed. Offset, they differ by ~2.6px
   * here and by ~123px in the case `curveRotOrigin` was written for.
   */
  ])('rotates %s about the same origin as the renderer', (_n, h) => {
    const t = text({ text: 'curved words here', curve: 60, h, w: 200, valign: 'top', cy: 60 });
    const p = placeText(t, CW, CH);

    if (p.kind !== 'curved') throw new Error('expected curved');

    const scene = resolveSceneText(editorTextToDesign(t, CW, CH), CW, CH);
    const expected = curveRotOrigin(scene, p.left, p.top, p.width, p.height);

    expect({ ox: p.originX, oy: p.originY }).toEqual({
      ox: expect.closeTo(expected.ox, 6),
      oy: expect.closeTo(expected.oy, 6),
    });
  });

  /*
   * 🔴 **The measured ratio is what makes a full circle actually close.**
   * Narrow glyphs fall far below the generic 0.62 estimate, so a ring sized by
   * the estimate leaves a visible gap at the seam. Dropping the field on the
   * way into `textArcPath` would silently undo the browser measurement the
   * editor takes.
   */
  it('sizes the arc by the measured advance ratio when there is one', () => {
    /*
     * ⚠️ **Long enough that the RING is the binding constraint.** A short run
     * fits either way and both branches return the merchant's size unchanged —
     * a 16-character fixture passed with the ratio dropped entirely. At 32 the
     * measured ratio keeps 30px where the estimate shrinks to ~24.
     */
    const base = { text: 'i'.repeat(32), curve: 100, size: 30, w: 300, h: 200 } as const;
    const measured = placeText(text({ ...base, advanceRatio: 0.28 }), CW, CH);
    const estimated = placeText(text({ ...base, advanceRatio: undefined }), CW, CH);

    if (measured.kind !== 'curved' || estimated.kind !== 'curved') {
      throw new Error('expected curved');
    }

    /* Narrow glyphs: the estimate overshoots and shrinks the run further. */
    expect(measured.fontSize).not.toBeCloseTo(estimated.fontSize, 3);
  });

  it('shrinks the font only once the run outgrows the ring', () => {
    const short = placeText(text({ text: 'hi', curve: 30, size: 30, w: 300, h: 200 }), CW, CH);
    const long = placeText(
      text({ text: 'a very long run that cannot fit the ring', curve: 30, size: 30, w: 300, h: 200 }),
      CW,
      CH,
    );

    expect(short.kind === 'curved' && short.fontSize).toBe(30);
    expect(long.kind === 'curved' && long.fontSize).toBeLessThan(30);
  });
});

describe('the closed circle M26d.3 names', () => {
  /*
   * 🔴 **±100 must actually CLOSE the ring, not draw a near-circle.** The
   * milestone names "arc/curve including a closed circle" explicitly, and the
   * geometry switches at `FULL_CIRCLE_THRESHOLD` (99.9) — a slider that stopped
   * at 99 would offer every arc except the one the milestone asks for.
   */
  /*
   * ⚠️ **Asserted on the PATH, not the bounding box.** A closed ring and one
   * that stops a degree short have the SAME bbox — 300×300 either way — so a
   * width-equals-height assertion passed with the closure disabled entirely.
   * A closed ring is two arc segments returning to their start; an open one is
   * a single arc.
   */
  it.each([100, -100])('closes the ring at curve %s', (curve) => {
    const p = placeText(text({ text: 'AROUND THE RING', curve, w: 300, h: 300 }), CW, CH);

    if (p.kind !== 'curved') throw new Error('expected curved');

    expect(p.d.match(/A /g)?.length).toBe(2);
    expect(p.width).toBeCloseTo(p.height, 6);
  });

  it('draws a single arc just below the threshold', () => {
    const p = placeText(text({ text: 'AROUND THE RING', curve: 95, w: 300, h: 300 }), CW, CH);

    if (p.kind !== 'curved') throw new Error('expected curved');

    expect(p.d.match(/A /g)?.length).toBe(1);
  });

  /*
   * ⚠️ **The seam is where a measured advance ratio earns its keep.** A ring
   * sized by the generic estimate leaves a visible gap for narrow glyphs; this
   * pins that the measurement reaches the closed-circle path at all.
   */
  it('sizes a closed circle by the measured advance when there is one', () => {
    /*
     * ⚠️ **A longer run than the arc test uses, because the RING here is
     * bigger.** A 300px-tall box inscribes a wider circle than a 200px one, so
     * 32 glyphs fit either way and the ratio never binds — the first fixture
     * here passed with the measurement dropped entirely.
     */
    const base = { text: 'i'.repeat(128), curve: 100, size: 30, w: 300, h: 300 } as const;
    const measured = placeText(text({ ...base, advanceRatio: 0.28 }), CW, CH);
    const estimated = placeText(text({ ...base, advanceRatio: undefined }), CW, CH);

    if (measured.kind !== 'curved' || estimated.kind !== 'curved') {
      throw new Error('expected curved');
    }

    expect(measured.fontSize).not.toBeCloseTo(estimated.fontSize, 3);
    /*
     * Both must actually have shrunk. At 64 glyphs only the ESTIMATE shrinks —
     * the measured run still fits — so the assertion below would fail there
     * while the one above passed. 128 puts both past the ring.
     */
    expect(measured.fontSize).toBeLessThan(30);
    expect(estimated.fontSize).toBeLessThan(measured.fontSize);
  });
});
