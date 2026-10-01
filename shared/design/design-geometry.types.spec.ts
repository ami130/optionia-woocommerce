import { TEXT_FONTS, authoringCanvasOf } from './design-geometry.types';
import { letterboxFor } from './letterbox';

/**
 * The geometry contract (M26c.1).
 *
 * 🔴 **These types are a PORT, and the point of porting is fidelity.** Two
 * things drifted on the way in and are pinned here: the font list, which was
 * widened to `string` and lost the only compile-time guard against a misspelt
 * family, and the background image, which was omitted entirely.
 */
describe('authoringCanvasOf', () => {
  /**
   * 🔴 **The NATURAL size, not anything displayed.** An editor canvas has a
   * fixed height and a storefront `<img>` is whatever the theme makes it;
   * neither describes what the merchant composed against, and Decision 5 turns
   * on recording the right one.
   */
  it('takes the aspect from the image’s natural dimensions', () => {
    const canvas = authoringCanvasOf({
      src: 'mug.jpg',
      name: 'Mug',
      natW: 1200,
      natH: 1200,
    });

    expect(canvas).toEqual({ width: 1200, height: 1200 });
  });

  /**
   * 🔴 **The whole point, end to end.** A square product photo produces a square
   * authoring canvas, which letterboxes into a centred square on a tall product
   * — rather than stretching the merchant's artwork down it.
   */
  it('feeds the letterbox that stops a design reflowing', () => {
    const canvas = authoringCanvasOf({ src: 'mug.jpg', name: 'Mug', natW: 800, natH: 800 });

    expect(letterboxFor(canvas, 600, 900)).toEqual({
      x: 0,
      y: 150,
      width: 600,
      height: 600,
    });
  });

  /** 📌 A non-square photo keeps its own shape, not an assumed one. */
  it('preserves a non-square aspect', () => {
    const canvas = authoringCanvasOf({ src: 'banner.jpg', name: 'Banner', natW: 2000, natH: 500 });

    expect(letterboxFor(canvas, 1000, 1000)).toEqual({
      x: 0,
      y: 375,
      width: 1000,
      height: 250,
    });
  });
});

describe('TEXT_FONTS', () => {
  /**
   * 🔴 **The list is the type's source, so it cannot be empty or duplicated.**
   * `TextFont` is derived with `typeof […][number]`; an empty array would make
   * every font name a type error, and a duplicate would silently narrow nothing.
   */
  it('is a non-empty list of distinct families', () => {
    expect(TEXT_FONTS.length).toBeGreaterThan(0);
    expect(new Set(TEXT_FONTS).size).toBe(TEXT_FONTS.length);
  });

  /**
   * ⚠️ **Latin-plus at launch** (Decision 4). These families carry Greek,
   * Cyrillic, Hebrew and Arabic; CJK is a separate pack. The assertion is that
   * the list stays curated rather than growing by accident — each addition costs
   * a font file in the image and a glyph-coverage question.
   */
  it('stays the curated set', () => {
    expect([...TEXT_FONTS]).toEqual([
      'Roboto',
      'Open Sans',
      'Montserrat',
      'Lato',
      'Oswald',
      'Playfair Display',
      'Dancing Script',
      'Pacifico',
    ]);
  });
});
