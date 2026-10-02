import { describe, expect, it } from 'vitest';

import {
  designGroups,
  designTexts,
  hasAnythingToDraw,
  previewBackdrop,
  previewableLayer,
  previewableLayers,
  previewableSource,
  type DesignBearingOption,
} from './preview-scene';

const SRC = 'https://cdn.example.com/art.png';

function layer(over: Record<string, unknown> = {}) {
  return { src: SRC, shape: 'none', ...over };
}

describe('previewableSource', () => {
  /*
   * 🔴 **The preview is the FIRST surface to read a stored design back and
   * inject it into markup.** The editor guards what it accepts; the API stores
   * the design body unvalidated by design, so a row written by any other path
   * can carry anything at all.
   */
  it('accepts an https image', () => {
    expect(previewableSource(SRC)).toBe(true);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['uppercased javascript', 'JavaScript:alert(1)'],
    ['mixed-case javascript', 'jAvAsCrIpT:alert(1)'],
    ['data', 'data:image/png;base64,iVBORw0KGgo='],
    ['relative', '/art.png'],
    ['empty', ''],
  ])('refuses a %s URL', (_name, url) => {
    expect(previewableSource(url)).toBe(false);
  });

  /* ⚠️ **SVG stays refused** — M26d.5's rule, reused rather than restated. */
  it('refuses an SVG, which can carry script', () => {
    expect(previewableSource('https://cdn.example.com/evil.svg')).toBe(false);
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('refuses %s rather than coercing it', (_name, value) => {
    expect(previewableSource(value)).toBe(false);
  });
});

describe('previewableLayer', () => {
  it('keeps a layer whose source is safe', () => {
    expect(previewableLayer(layer())).not.toBeNull();
  });

  it('drops a layer whose source is not', () => {
    expect(previewableLayer(layer({ src: 'javascript:alert(1)' }))).toBeNull();
  });

  /*
   * 🔴 **A custom PNG mask is a SECOND url**, and an unchecked one would reach
   * the DOM through the `<mask>` the serializer emits.
   */
  it('drops a masked layer whose mask source is not safe', () => {
    expect(
      previewableLayer(layer({ shape: 'image', shapeSrc: 'javascript:alert(1)' })),
    ).toBeNull();
  });

  it('keeps a masked layer when both sources are safe', () => {
    expect(
      previewableLayer(layer({ shape: 'image', shapeSrc: 'https://cdn/mask.png' })),
    ).not.toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'not a layer'],
    ['a number', 7],
  ])('refuses %s rather than trusting the shape', (_name, raw) => {
    expect(previewableLayer(raw)).toBeNull();
  });
});

describe('previewableLayers', () => {
  /*
   * ⚠️ **One bad layer drops ITSELF, not the design.** A blank preview with no
   * explanation is a worse failure than a missing image.
   */
  it('keeps the good layers and drops the bad', () => {
    const design = { layers: [layer(), layer({ src: 'javascript:alert(1)' }), layer()] };

    expect(previewableLayers(design)).toHaveLength(2);
  });

  it.each([
    ['a null design', null],
    ['a design with no layers', {}],
    ['layers that are not an array', { layers: 'nope' }],
  ])('returns nothing for %s', (_name, design) => {
    expect(previewableLayers(design)).toEqual([]);
  });
});

describe('designGroups', () => {
  const options: DesignBearingOption[] = [
    {
      id: 'opt-1',
      values: [
        { id: 'val-red', valueKey: 'red', design: { layers: [layer()] } },
        { id: 'val-blue', valueKey: 'blue', design: { layers: [layer()] } },
      ],
    },
  ];

  /*
   * 🔴 **Visibility follows the ANSWER**, which is what makes this a preview
   * rather than a gallery: a swatch's artwork appears when that swatch is
   * chosen, as the storefront shows it.
   */
  it('shows only the chosen value’s design', () => {
    const groups = designGroups(options, { 'opt-1': 'red' });

    expect(groups.find((g) => g.key === 'val-red')?.visible).toBe(true);
    expect(groups.find((g) => g.key === 'val-blue')?.visible).toBe(false);
  });

  /*
   * ⚠️ **Every group is carried either way**, visible or not, so changing a
   * choice toggles a flag rather than rebuilding the scene.
   */
  it('carries both designs so toggling does not rebuild the scene', () => {
    expect(designGroups(options, { 'opt-1': 'red' })).toHaveLength(2);
    expect(designGroups(options, {})).toHaveLength(2);
  });

  it('shows nothing when no choice is made', () => {
    expect(designGroups(options, {}).every((g) => !g.visible)).toBe(true);
  });

  /* ⚠️ A multi-select answer is an ARRAY — the checkbox-group case. */
  it('shows every chosen value of a multi-select', () => {
    const groups = designGroups(options, { 'opt-1': ['red', 'blue'] });

    expect(groups.every((g) => g.visible)).toBe(true);
  });

  it('skips a value with no design at all', () => {
    const bare: DesignBearingOption[] = [
      { id: 'o', values: [{ id: 'v', valueKey: 'k' }] },
    ];

    expect(designGroups(bare, {})).toEqual([]);
  });

  it('skips a value whose every layer was refused', () => {
    const unsafe: DesignBearingOption[] = [
      {
        id: 'o',
        values: [
          { id: 'v', valueKey: 'k', design: { layers: [layer({ src: 'javascript:x' })] } },
        ],
      },
    ];

    expect(designGroups(unsafe, { o: 'k' })).toEqual([]);
  });
});

describe('designTexts', () => {
  const design = { text: 'Your text here', font: 'Roboto' };
  const options: DesignBearingOption[] = [
    { id: 'opt-text', textDesign: design, values: [] },
  ];

  it('renders a text option’s design', () => {
    expect(designTexts(options, {})).toHaveLength(1);
  });

  /* 📌 The customer's typing replaces the merchant's sample, live. */
  it('replaces the sample with what the customer typed', () => {
    expect(designTexts(options, { 'opt-text': 'Alice' })[0].value).toBe('Alice');
  });

  /*
   * 🔴 **An EMPTY answer keeps the sample.** `resolveSceneText` renders an empty
   * value as nothing, so the merchant's artwork would vanish the instant the
   * field was focused and cleared.
   */
  it('keeps the sample when the customer has typed nothing', () => {
    expect(designTexts(options, { 'opt-text': '' })[0].value).toBeUndefined();
  });

  it('ignores an answer that is not a string', () => {
    expect(designTexts(options, { 'opt-text': ['a'] })[0].value).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['absent', undefined],
  ])('skips an option whose text design is %s', (_name, textDesign) => {
    const none: DesignBearingOption[] = [
      { id: 'o', textDesign, values: [] },
    ];

    expect(designTexts(none, {})).toEqual([]);
  });
});

describe('previewBackdrop', () => {
  const product = { imageUrl: 'https://cdn/p.jpg', name: 'Mug' };

  /*
   * 🔴 **The authoring canvas comes from the PHOTO.** Decision 5 letterboxes
   * the design into a box of its own aspect; the wrong aspect stretches artwork
   * the Design Lab drew square.
   */
  it('derives the authoring canvas from the photo’s natural size', () => {
    const backdrop = previewBackdrop(product, { width: 1000, height: 500 });

    expect(backdrop?.canvas.width).toBe(1000);
    expect(backdrop?.canvas.height).toBe(500);
  });

  it('carries the photo as the background image', () => {
    expect(previewBackdrop(product, { width: 800, height: 800 })?.image.src).toBe(
      'https://cdn/p.jpg',
    );
  });

  it.each([
    ['no product', null, { width: 10, height: 10 }],
    ['an unmeasured photo', product, null],
    ['a zero-width photo', product, { width: 0, height: 10 }],
    ['a zero-height photo', product, { width: 10, height: 0 }],
  ])('refuses %s', (_name, item, natural) => {
    expect(previewBackdrop(item, natural)).toBeNull();
  });

  /* ⚠️ The backdrop is a URL from storage too, and gets the same check. */
  it('refuses a photo whose URL is not previewable', () => {
    expect(
      previewBackdrop({ imageUrl: 'javascript:alert(1)' }, { width: 10, height: 10 }),
    ).toBeNull();
  });

  it('refuses an SVG photo', () => {
    expect(
      previewBackdrop({ imageUrl: 'https://cdn/p.svg' }, { width: 10, height: 10 }),
    ).toBeNull();
  });
});

describe('hasAnythingToDraw', () => {
  it('is false when a set carries no artwork at all', () => {
    expect(hasAnythingToDraw([], [])).toBe(false);
  });

  it.each([
    ['an image group', [{ key: 'k', layers: [], visible: true }], []],
    ['a text node', [], [{ key: 'k', design: {} as never }]],
  ])('is true for %s', (_name, groups, texts) => {
    expect(hasAnythingToDraw(groups, texts)).toBe(true);
  });
});
