import { describe, expect, it } from 'vitest';

import { backgroundFor, canBeBackground } from './background';

const NATURAL = { width: 1200, height: 1600 };

describe('canBeBackground', () => {
  it('accepts a product with a photo', () => {
    expect(canBeBackground({ name: 'Mug', imageUrl: 'https://cdn/x.png' })).toBe(true);
  });

  it('refuses a product with no photo, which is an ordinary case', () => {
    /* A synced catalogue carries plenty; the lab falls back to a blank canvas. */
    expect(canBeBackground({ name: 'Mug', imageUrl: null })).toBe(false);
  });

  it('refuses an empty string, which is not the same as a URL', () => {
    expect(canBeBackground({ name: 'Mug', imageUrl: '' })).toBe(false);
  });

  it('refuses no product at all', () => {
    expect(canBeBackground(null)).toBe(false);
  });

  /*
   * 🔴 **A product photo that is an SVG is refused too.** M26d.5's rule is
   * about what reaches a renderer, not about who supplied it — and a backdrop is
   * drawn by the same canvas and rasterised by the same server. A synced
   * catalogue can carry one: WooCommerce accepts SVG uploads with a plugin.
   */
  it('refuses a product whose photo is an SVG', () => {
    expect(canBeBackground({ name: 'Mug', imageUrl: 'https://cdn/x.svg' })).toBe(false);
    expect(canBeBackground({ name: 'Mug', imageUrl: 'https://cdn/x.SVGZ' })).toBe(false);
  });

  it('accepts a photo whose URL merely mentions svg', () => {
    expect(
      canBeBackground({ name: 'Mug', imageUrl: 'https://cdn/svg/x.png?from=y.svg' }),
    ).toBe(true);
  });
});

describe('backgroundFor', () => {
  it('carries the photo and the measured dimensions', () => {
    expect(backgroundFor({ name: 'Mug', imageUrl: 'https://cdn/x.png' }, NATURAL)).toEqual({
      src: 'https://cdn/x.png',
      name: 'Mug',
      natW: 1200,
      natH: 1600,
    });
  });

  it('keeps the two dimensions distinct', () => {
    /*
     * ⚠️ A portrait fixture, deliberately: width and height swapped would pass
     * against a square one, and the canvas adopts this aspect.
     */
    const bg = backgroundFor({ name: 'Mug', imageUrl: 'https://cdn/x.png' }, NATURAL);

    expect(bg?.natW).toBe(1200);
    expect(bg?.natH).toBe(1600);
    expect(bg?.natW).not.toBe(bg?.natH);
  });

  it('returns nothing when the product has no photo', () => {
    expect(backgroundFor({ name: 'Mug', imageUrl: null }, NATURAL)).toBeNull();
    expect(backgroundFor(null, NATURAL)).toBeNull();
  });

  /*
   * 🔴 **Its own guard, not `canBeBackground`'s.** Caught by mutation: removing
   * the empty-string check here passed every test, because each one reached
   * this function through a caller that had already been refused. A separately
   * exported function must stand alone — an empty `src` renders a broken image
   * and sets the canvas aspect from nothing.
   */
  it('refuses an empty URL when called directly', () => {
    expect(backgroundFor({ name: 'Mug', imageUrl: '' }, NATURAL)).toBeNull();
  });

  it('refuses an SVG when called directly', () => {
    /* Same reasoning: a separately exported function must stand alone. */
    expect(backgroundFor({ name: 'Mug', imageUrl: 'https://cdn/x.svg' }, NATURAL)).toBeNull();
  });

  it('names an unnamed product rather than leaving the label blank', () => {
    expect(backgroundFor({ name: '', imageUrl: 'https://cdn/x.png' }, NATURAL)?.name).toBe(
      'Product photo',
    );
  });

  /*
   * 🔴 **The guard that matters most.** `setCanvasSize` computes `natW / natH`,
   * so a zero height is a division producing Infinity and a canvas width of
   * NaN — which renders as nothing at all, with no error anywhere. A browser
   * reports zeroes for an image that failed to decode.
   */
  it('never yields a zero dimension', () => {
    const bg = backgroundFor(
      { name: 'Mug', imageUrl: 'https://cdn/x.png' },
      { width: 0, height: 0 },
    );

    expect(bg?.natW).toBe(1);
    expect(bg?.natH).toBe(1);
  });

  it('floors each dimension independently', () => {
    /* ⚠️ One zero and one real: a shared fallback would overwrite the good one. */
    const bg = backgroundFor(
      { name: 'Mug', imageUrl: 'https://cdn/x.png' },
      { width: 0, height: 900 },
    );

    expect(bg?.natW).toBe(1);
    expect(bg?.natH).toBe(900);
  });

  it('refuses a negative dimension the same way', () => {
    const bg = backgroundFor(
      { name: 'Mug', imageUrl: 'https://cdn/x.png' },
      { width: -5, height: -5 },
    );

    expect(bg?.natW).toBe(1);
    expect(bg?.natH).toBe(1);
  });
});
