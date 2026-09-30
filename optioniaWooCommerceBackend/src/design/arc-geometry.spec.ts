import {
  arcTextAnchor,
  curveBoxPlace,
  curveBoxTop,
  curveRotOrigin,
  radiusForBox,
  textArcPath,
} from './arc-geometry';

const countArcs = (d: string): number => d.split('A').length - 1;

describe('radiusForBox', () => {
  it('inscribes a full circle in the box\'s shorter side, glyph overhang included', () => {
    // curve = 100 -> theta = 2pi -> R = min(w,h)/2 - gOut, gOut = 0.8 * fontSize.
    expect(radiusForBox(100, 400, 600, 10)).toBeCloseTo(400 / 2 - 8, 6);
    expect(radiusForBox(100, 600, 400, 10)).toBeCloseTo(400 / 2 - 8, 6);
  });

  it('grows without bound as the curve flattens', () => {
    // curve -> 0 means R -> infinity: a barely-bent line spanning the box.
    const gentle = radiusForBox(0.01, 400, 400, 24);
    const bent = radiusForBox(50, 400, 400, 24);
    expect(gentle).toBeGreaterThan(bent * 100);
  });

  it('is continuous where the two branches meet (theta = pi)', () => {
    // A discontinuity here makes the curve slider jump under the merchant's cursor.
    const below = radiusForBox(49.9999, 400, 400, 24);
    const above = radiusForBox(50.0001, 400, 400, 24);
    expect(Math.abs(below - above)).toBeLessThan(1e-6);
  });

  it('never returns less than 1, even for a degenerate box', () => {
    expect(radiusForBox(100, 0.0001, 0.0001, 1000)).toBeGreaterThanOrEqual(1);
    expect(radiusForBox(100, -5, -5, 10)).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the font size when no box width was stored (legacy)', () => {
    // boxW <= 0 -> w = fontSize, and boxH <= 0 -> h = w.
    expect(radiusForBox(100, 0, 0, 40)).toBeCloseTo(radiusForBox(100, 40, 40, 40), 10);
  });

  it('is driven by the box and the curve, never by the text', () => {
    // The ring must not move as a customer types — same box, same radius.
    const a = radiusForBox(60, 300, 300, 24);
    const b = radiusForBox(60, 300, 300, 24);
    expect(a).toBe(b);
  });

  it('clamps an out-of-range curve rather than producing a wilder ring', () => {
    expect(radiusForBox(150, 400, 400, 10)).toBeCloseTo(radiusForBox(100, 400, 400, 10), 10);
    expect(radiusForBox(-150, 400, 400, 10)).toBeCloseTo(radiusForBox(-100, 400, 400, 10), 10);
  });
});

describe('textArcPath', () => {
  it('emits two arc commands for a full circle, because one cannot close it', () => {
    expect(countArcs(textArcPath('ab', 20, 0, 100, 200, 200).d)).toBe(2);
    expect(countArcs(textArcPath('ab', 20, 0, -100, 200, 200).d)).toBe(2);
  });

  it('emits one arc command for an open curve', () => {
    expect(countArcs(textArcPath('ab', 20, 0, 50, 200, 200).d)).toBe(1);
  });

  it('switches to the closed form exactly at the threshold', () => {
    // A run authored at 100 can arrive as 99.97 through the slider's floats;
    // below the threshold it must still be an open arc.
    expect(countArcs(textArcPath('ab', 20, 0, 99.89, 200, 200).d)).toBe(1);
    expect(countArcs(textArcPath('ab', 20, 0, 99.9, 200, 200).d)).toBe(2);
  });

  it('keeps the merchant size while the run fits the ring', () => {
    const { fontSize } = textArcPath('ab', 20, 0, 40, 600, 600);
    expect(fontSize).toBe(20);
  });

  it('shrinks only once the run outgrows the ring, and never grows', () => {
    const long = textArcPath('x'.repeat(200), 40, 0, 100, 200, 200);
    expect(long.fontSize).toBeLessThan(40);
    const short = textArcPath('x', 40, 0, 100, 2000, 2000);
    expect(short.fontSize).toBe(40);
  });

  it('shrinks letter spacing proportionally with the font', () => {
    const { fontSize, letterSpacing } = textArcPath('x'.repeat(200), 40, 4, 100, 200, 200);
    expect(letterSpacing / fontSize).toBeCloseTo(4 / 40, 9);
  });

  it('leaves the radius untouched by the shrink — only glyphs get smaller', () => {
    // R is solved at the MERCHANT size, so the ring stays put as text is typed.
    const R = radiusForBox(100, 200, 200, 40);
    expect(textArcPath('x'.repeat(200), 40, 0, 100, 200, 200).arc.R).toBeCloseTo(R, 10);
  });

  it('reserves a seam letter-spacing on a full circle so the ring closes evenly', () => {
    // The seam only applies to the closed form: with spacing, the closed circle
    // must shrink at least as much as the open arc of the same run.
    const closed = textArcPath('x'.repeat(60), 20, 6, 100, 300, 300);
    const closedNoSpacing = textArcPath('x'.repeat(60), 20, 0, 100, 300, 300);
    expect(closed.fontSize).toBeLessThan(closedNoSpacing.fontSize);
  });

  it('places an arch apex at the top of its box and a valley at the bottom', () => {
    // Arch: circle centre below the apex (cy = rOut). Valley: mirrored.
    const arch = textArcPath('ab', 20, 0, 60, 300, 300);
    const valley = textArcPath('ab', 20, 0, -60, 300, 300);
    expect(arch.arc.cy).toBeGreaterThan(0);
    expect(valley.arc.cy).toBeLessThan(valley.height);
  });

  it('runs an arch clockwise and a valley anticlockwise', () => {
    expect(textArcPath('ab', 20, 0, 60, 300, 300).arc.dir).toBe(1);
    expect(textArcPath('ab', 20, 0, -60, 300, 300).arc.dir).toBe(-1);
  });

  it('reports a swept angle of 2pi for a full circle', () => {
    expect(textArcPath('ab', 20, 0, 100, 200, 200).arc.theta).toBeCloseTo(2 * Math.PI, 10);
  });

  it('gives a full circle a bbox of the outer diameter on both axes', () => {
    const { width, height, arc } = textArcPath('ab', 20, 0, 100, 400, 400);
    const outer = 2 * (arc.R + 0.8 * 20);
    expect(width).toBeCloseTo(outer, 6);
    expect(height).toBeCloseTo(outer, 6);
  });
});

describe('curveBoxTop', () => {
  it('centres the arc on cy when the design has no fixed height (legacy)', () => {
    expect(curveBoxTop('top', 100, 0, 40)).toBe(80);
    expect(curveBoxTop('bottom', 100, -1, 40)).toBe(80);
  });

  it('centres on cy for middle alignment regardless of the box', () => {
    expect(curveBoxTop('middle', 100, 200, 40)).toBe(80);
  });

  it('puts the arc against the box top and bottom respectively', () => {
    expect(curveBoxTop('top', 100, 200, 40)).toBe(0); // cy - boxH/2
    expect(curveBoxTop('bottom', 100, 200, 40)).toBe(160); // top + boxH - arcH
  });
});

describe('curveBoxPlace', () => {
  const tx = (h: number) => ({ cx: 10, cy: 10, h, valign: 'middle' as const });

  it('does NOT clamp a fixed box, so it matches what the editor draws', () => {
    // Clamping here moved the arc by up to ~221px relative to the Design Lab,
    // and left-aligned text the editor had centred.
    expect(curveBoxPlace(tx(50), 500, 500, 100, 100)).toEqual({ left: -240, top: -240 });
  });

  it('DOES clamp a legacy box, because the editor\'s legacy branch clamps too', () => {
    expect(curveBoxPlace(tx(0), 500, 500, 100, 100)).toEqual({ left: 0, top: 0 });
  });

  it('centres the arc horizontally on cx, independent of alignment', () => {
    const { left } = curveBoxPlace({ cx: 400, cy: 200, h: 100, valign: 'middle' }, 200, 50, 800, 400);
    expect(left).toBe(300);
  });
});

describe('curveRotOrigin', () => {
  it('rotates a fixed box about (cx, cy), as the editor does', () => {
    // The arc bbox centre sits (boxH - arcH)/2 away — ~123px in practice.
    expect(curveRotOrigin({ cx: 100, cy: 200, h: 300 }, 0, 0, 40, 40)).toEqual({ ox: 100, oy: 200 });
  });

  it('rotates a legacy box about its bbox centre, so saved designs do not move', () => {
    expect(curveRotOrigin({ cx: 100, cy: 200, h: 0 }, 10, 20, 40, 60)).toEqual({ ox: 30, oy: 50 });
  });
});

describe('arcTextAnchor', () => {
  it('slides the run along the ring rather than moving the arc', () => {
    expect(arcTextAnchor('left')).toEqual({ startOffset: '0%', anchor: 'start' });
    expect(arcTextAnchor('center')).toEqual({ startOffset: '50%', anchor: 'middle' });
    expect(arcTextAnchor('right')).toEqual({ startOffset: '100%', anchor: 'end' });
  });
});
