import { letterboxFor, willLetterbox } from './letterbox';

/**
 * Fitting a design onto a differently-shaped product (M26c.3, Decision 5).
 *
 * 🔴 **The failure this prevents is discovered on a printed object.** Every
 * stored coordinate is a fraction of the canvas, so a design composed on a
 * square mug photo and assigned to a tall bottle photo reflows — and the
 * merchant finds out after printing. `optionia-app` has exactly that behaviour.
 */
describe('letterboxFor', () => {
  const square = { width: 1000, height: 1000 };

  /** 📌 Same shape: the design fills the product, with no band at all. */
  it('fills a target of the same aspect', () => {
    expect(letterboxFor(square, 2000, 2000)).toEqual({
      x: 0,
      y: 0,
      width: 2000,
      height: 2000,
    });
  });

  /**
   * 🔴 **The case the whole decision is for.** A square design on a tall
   * product renders in a centred square, not stretched down it.
   */
  it('centres a square design on a tall product', () => {
    const box = letterboxFor(square, 600, 900);

    expect(box).toEqual({ x: 0, y: 150, width: 600, height: 600 });
  });

  /** 📌 And the mirror: a square design on a wide product. */
  it('centres a square design on a wide product', () => {
    const box = letterboxFor(square, 900, 600);

    expect(box).toEqual({ x: 150, y: 0, width: 600, height: 600 });
  });

  /** ⚠️ A non-square authoring aspect is honoured, not assumed square. */
  it('honours a wide authoring canvas', () => {
    const box = letterboxFor({ width: 2000, height: 1000 }, 1000, 1000);

    expect(box).toEqual({ x: 0, y: 250, width: 1000, height: 500 });
  });

  /**
   * 🔴 **An exact-ratio match returns the FULL target, never a computed box.**
   * Dividing equal ratios can differ in the last bit, and a one-pixel inset on
   * every square-on-square design would be a visible seam nobody could explain.
   */
  it('returns the exact target when the aspects match at any scale', () => {
    for (const size of [100, 999, 4321]) {
      const box = letterboxFor({ width: 3, height: 3 }, size, size);

      expect(box.width).toBe(size);
      expect(box.height).toBe(size);
      expect(box.x).toBe(0);
      expect(box.y).toBe(0);
    }
  });

  /**
   * 🔴 **A design with no recorded aspect fills the target**, which is what it
   * already did. Every design predating M26c.3 has no authoring canvas, and
   * refusing to render it would take away artwork a merchant already has to
   * protect them from a reflow they have already accepted.
   */
  it('falls back to the full target when no aspect was recorded', () => {
    expect(letterboxFor(null, 800, 400)).toEqual({ x: 0, y: 0, width: 800, height: 400 });
    expect(letterboxFor(undefined, 800, 400)).toEqual({ x: 0, y: 0, width: 800, height: 400 });
  });

  /** ⚠️ And a corrupt authoring canvas is treated the same, never divided by. */
  it('falls back rather than dividing by zero', () => {
    expect(letterboxFor({ width: 0, height: 100 }, 800, 400).width).toBe(800);
    expect(letterboxFor({ width: 100, height: 0 }, 800, 400).width).toBe(800);
    expect(letterboxFor({ width: Number.NaN, height: 100 }, 800, 400).width).toBe(800);
    expect(
      letterboxFor({ width: Number.POSITIVE_INFINITY, height: 100 }, 800, 400).width,
    ).toBe(800);
  });

  /** ⚠️ A target with no area cannot be letterboxed into. */
  it('returns the target unchanged when it has no area', () => {
    expect(letterboxFor(square, 0, 400)).toEqual({ x: 0, y: 0, width: 0, height: 400 });
  });

  /** 📌 The box always sits inside the target, whichever way it is shaped. */
  it('never places the design outside the product', () => {
    for (const [w, h] of [
      [600, 900],
      [900, 600],
      [1000, 1000],
      [1920, 1080],
    ]) {
      const box = letterboxFor(square, w, h);

      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(w + 1e-9);
      expect(box.y + box.height).toBeLessThanOrEqual(h + 1e-9);
    }
  });
});

describe('willLetterbox', () => {
  /**
   * 📌 **The editor asks this before a merchant saves.** Telling them their
   * artwork will sit inside a band is a supported limitation; letting them find
   * out from a customer's order is a defect wearing the same clothes.
   */
  it('reports whether a band will appear', () => {
    expect(willLetterbox({ width: 1000, height: 1000 }, 600, 900)).toBe(true);
    expect(willLetterbox({ width: 1000, height: 1000 }, 800, 800)).toBe(false);
    expect(willLetterbox(null, 600, 900)).toBe(false);
  });
});
