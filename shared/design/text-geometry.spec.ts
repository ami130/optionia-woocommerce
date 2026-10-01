import {
  CHAR_ADVANCE,
  LINE_HEIGHT,
  MIN_FONT_RATIO,
  estimateTextLength,
  fitTextToBox,
  flatBlockFirstY,
  resolveSceneText,
  textAnchorFor,
  wrapTextLines,
} from './text-geometry';
import type { TextDesign } from './design-geometry.types';

const design = (over: Partial<TextDesign> = {}): TextDesign => ({
  text: 'Sarah',
  font: 'Roboto',
  sizePct: 0.1,
  bold: false,
  italic: false,
  align: 'center',
  color: '#000000',
  pos: { xPct: 0.5, yPct: 0.5, wPct: 0.5 },
  rot: 0,
  curve: 0,
  ...over,
});

describe('resolveSceneText', () => {
  it('converts canvas fractions into viewBox pixels', () => {
    const t = resolveSceneText(design(), 1000, 500);
    expect(t.fontSize).toBe(50); // sizePct is a fraction of HEIGHT
    expect(t.cx).toBe(500);
    expect(t.cy).toBe(250);
    expect(t.w).toBe(500);
  });

  it('prefers the customer value over the merchant sample', () => {
    expect(resolveSceneText(design(), 100, 100, 'James').text).toBe('James');
  });

  it('falls back to the merchant sample when no value is supplied', () => {
    expect(resolveSceneText(design(), 100, 100).text).toBe('Sarah');
  });

  it('keeps an empty customer value rather than falling back', () => {
    // A cleared input must render nothing, not silently reinstate the sample.
    expect(resolveSceneText(design(), 100, 100, '').text).toBe('');
  });

  /* The `||` vs `??` distinction the port documents. */
  it('treats wPct 0 as "unrecorded" and defaults to half the canvas', () => {
    const t = resolveSceneText(design({ pos: { xPct: 0.5, yPct: 0.5, wPct: 0 } }), 800, 400);
    expect(t.w).toBe(400);
  });

  it('treats xPct 0 as a real left edge and keeps it', () => {
    const t = resolveSceneText(design({ pos: { xPct: 0, yPct: 0.5, wPct: 0.5 } }), 800, 400);
    expect(t.cx).toBe(0);
  });

  it('clamps curve into [-100, 100]', () => {
    expect(resolveSceneText(design({ curve: 999 }), 100, 100).curve).toBe(100);
    expect(resolveSceneText(design({ curve: -999 }), 100, 100).curve).toBe(-100);
  });

  it('defaults valign to middle for legacy designs that never stored one', () => {
    expect(resolveSceneText(design(), 100, 100).valign).toBe('middle');
  });

  it('normalises a non-positive advanceRatio to 0 so the estimate is used', () => {
    expect(resolveSceneText(design({ advanceRatio: 0 }), 100, 100).advanceRatio).toBe(0);
    expect(resolveSceneText(design({ advanceRatio: -1 }), 100, 100).advanceRatio).toBe(0);
  });

  it('scales letterSpacing by canvas HEIGHT, not width', () => {
    const t = resolveSceneText(design({ letterSpacing: 0.01 }), 1000, 500);
    expect(t.letterSpacing).toBe(5);
  });
});

describe('estimateTextLength', () => {
  it('uses CHAR_ADVANCE when no measured ratio is supplied', () => {
    expect(estimateTextLength('abcd', 10, 0)).toBeCloseTo(4 * 10 * CHAR_ADVANCE, 10);
  });

  it('prefers a measured advanceRatio over the estimate', () => {
    expect(estimateTextLength('abcd', 10, 0, 0.5)).toBeCloseTo(20, 10);
  });

  it('adds letter spacing between glyphs only, not after the last', () => {
    expect(estimateTextLength('abc', 10, 2, 0.5)).toBeCloseTo(3 * 5 + 2 * 2, 10);
  });

  it('is scale-invariant in the measured ratio', () => {
    // n cancels, so a ratio measured at any size gives the same proportion.
    const a = estimateTextLength('name', 20, 0, 0.5);
    const b = estimateTextLength('name', 40, 0, 0.5);
    expect(b / a).toBeCloseTo(2, 10);
  });

  it('counts an empty string as one glyph rather than zero', () => {
    expect(estimateTextLength('', 10, 0, 0.5)).toBeCloseTo(5, 10);
  });

  /* Code points, not UTF-16 units. */
  it('counts an astral character once, not twice', () => {
    const emoji = '😀'; // one code point, two UTF-16 units
    expect(emoji.length).toBe(2);
    expect(estimateTextLength(emoji, 10, 0, 0.5)).toBeCloseTo(5, 10);
  });
});

describe('wrapTextLines', () => {
  it('breaks a run that overflows the width', () => {
    const lines = wrapTextLines('abcdef', 10, 0, 30, 0.5); // 5px/glyph -> 6 fit
    expect(lines).toEqual(['abcdef']);
    expect(wrapTextLines('abcdefg', 10, 0, 30, 0.5)).toEqual(['abcdef', 'g']);
  });

  it('honours explicit newlines', () => {
    expect(wrapTextLines('ab\ncd', 10, 0, 1000, 0.5)).toEqual(['ab', 'cd']);
  });

  it('preserves a blank line between two newlines', () => {
    expect(wrapTextLines('a\n\nb', 10, 0, 1000, 0.5)).toEqual(['a', '', 'b']);
  });

  it('breaks mid-word, which is how a long name wraps', () => {
    expect(wrapTextLines('Bartholomew', 10, 0, 20, 0.5)).toEqual([
      'Bart', 'holo', 'mew',
    ]);
  });

  it('returns a single empty line for empty input', () => {
    expect(wrapTextLines('', 10, 0, 100, 0.5)).toEqual(['']);
  });

  it('never splits a surrogate pair across lines', () => {
    const lines = wrapTextLines('😀😀😀', 10, 0, 10, 0.5); // 5px each -> 2 per line
    expect(lines).toEqual(['😀😀', '😀']);
    // A UTF-16-naive wrap would emit lone surrogates, which render as tofu.
    for (const line of lines) {
      expect(line).toBe([...line].join(''));
    }
  });

  it('always makes progress, even when one glyph exceeds the width', () => {
    // maxWidth is floored at 1, and a line only breaks when non-empty — so a
    // glyph wider than the box occupies its own line instead of looping.
    expect(wrapTextLines('abc', 100, 0, 0, 0.5)).toEqual(['a', 'b', 'c']);
  });
});

describe('fitTextToBox', () => {
  it('returns the merchant size untouched when the text already fits', () => {
    expect(fitTextToBox('ab', 10, 0, 1000, 1000, 0.5)).toEqual({
      fontSize: 10,
      letterSpacing: 0,
    });
  });

  it('never grows text past the merchant size', () => {
    const { fontSize } = fitTextToBox('a', 10, 0, 100000, 100000, 0.5);
    expect(fontSize).toBe(10);
  });

  it('shrinks until the wrapped lines fit the box height', () => {
    const { fontSize } = fitTextToBox('abcdefghij', 100, 0, 100, 100, 0.5);
    const lines = wrapTextLines('abcdefghij', fontSize, 0, 100, 0.5);
    expect(lines.length * fontSize * LINE_HEIGHT).toBeLessThanOrEqual(100);
    expect(fontSize).toBeLessThan(100);
  });

  it('scales letter spacing down with the font so the look stays proportional', () => {
    const { fontSize, letterSpacing } = fitTextToBox('abcdefghij', 100, 10, 100, 100, 0.5);
    expect(letterSpacing).toBeCloseTo(10 * (fontSize / 100), 10);
  });

  it('returns the max size unchanged when there is no fixed height (legacy)', () => {
    expect(fitTextToBox('a'.repeat(500), 40, 3, 100, 0, 0.5)).toEqual({
      fontSize: 40,
      letterSpacing: 3,
    });
  });

  it('stops at the relative floor rather than shrinking to nothing', () => {
    const { fontSize } = fitTextToBox('a'.repeat(5000), 100, 0, 10, 10, 0.5);
    expect(fontSize).toBeCloseTo(100 * MIN_FONT_RATIO, 10);
  });

  /* The floor is relative, which is what makes editor px and natural px agree. */
  it('shrinks to the same PROPORTION at any canvas scale', () => {
    const small = fitTextToBox('abcdefghij', 100, 0, 100, 100, 0.5);
    const large = fitTextToBox('abcdefghij', 1000, 0, 1000, 1000, 0.5);
    expect(large.fontSize / 1000).toBeCloseTo(small.fontSize / 100, 6);
  });

  it('is guarded against a non-positive max size', () => {
    expect(fitTextToBox('a', 0, 0, 100, 100, 0.5)).toEqual({
      fontSize: 0,
      letterSpacing: 0,
    });
  });
});

describe('textAnchorFor', () => {
  it('maps each alignment to its SVG anchor and offset', () => {
    expect(textAnchorFor('left')).toEqual({ anchor: 'start', offset: '0%', dx: -0.5 });
    expect(textAnchorFor('center')).toEqual({ anchor: 'middle', offset: '50%', dx: 0 });
    expect(textAnchorFor('right')).toEqual({ anchor: 'end', offset: '100%', dx: 0.5 });
  });
});

describe('flatBlockFirstY', () => {
  it('centres a single line on cy', () => {
    expect(flatBlockFirstY('middle', 100, 200, 1, 20)).toBe(100);
  });

  it('centres a multi-line block on cy', () => {
    expect(flatBlockFirstY('middle', 100, 200, 3, 20)).toBe(80);
  });

  it('places the first line half a line below the box top when top-aligned', () => {
    expect(flatBlockFirstY('top', 100, 200, 3, 20)).toBe(10);
  });

  it('places the last line against the box bottom when bottom-aligned', () => {
    const firstY = flatBlockFirstY('bottom', 100, 200, 3, 20);
    const lastLineBottom = firstY + 2 * 20 + 20 / 2;
    expect(lastLineBottom).toBe(200); // box bottom = cy + boxH/2
  });

  it('centres on cy for a legacy design with no fixed height', () => {
    expect(flatBlockFirstY('top', 100, 0, 3, 20)).toBe(80);
    expect(flatBlockFirstY('bottom', 100, -1, 3, 20)).toBe(80);
  });
});
