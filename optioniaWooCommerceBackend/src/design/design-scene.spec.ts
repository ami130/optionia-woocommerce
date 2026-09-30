import { buildScene, sceneToSvgString, serializeTextNode } from './design-scene';
import { LINE_HEIGHT } from './text-geometry';
import type { DesignLayer, TextDesign } from './design-geometry.types';

const layer = (over: Partial<DesignLayer> = {}): DesignLayer => ({
  name: 'l1',
  src: 'img.png',
  natW: 100,
  natH: 100,
  pos: { xPct: 0.5, yPct: 0.5, wPct: 0.5, hPct: 0.5 },
  rot: 0,
  style: 'free',
  visible: true,
  ...over,
});

const text = (over: Partial<TextDesign> = {}): TextDesign => ({
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

describe('buildScene', () => {
  it('guards against a zero canvas, which would divide every fraction by nothing', () => {
    const s = buildScene({ width: 0, height: 0, groups: [] });
    expect(s.width).toBe(1);
    expect(s.height).toBe(1);
  });

  it('drops invisible layers but keeps invisible groups', () => {
    // A hidden group still renders (display:none) so the storefront can toggle
    // it on selection without re-rendering; a hidden LAYER never resolves.
    const s = buildScene({
      width: 100,
      height: 100,
      groups: [
        { key: 'g', visible: false, layers: [layer(), layer({ visible: false })] },
      ],
    });
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].visible).toBe(false);
    expect(s.groups[0].images).toHaveLength(1);
  });

  it('appends text options as always-visible groups after the image groups', () => {
    const s = buildScene({
      width: 100,
      height: 100,
      groups: [{ key: 'img', visible: true, layers: [layer()] }],
      textOptions: [{ key: 'opt', design: text() }],
    });
    expect(s.groups.map((g) => g.key)).toEqual(['img', 'opt']);
    expect(s.groups[1].visible).toBe(true);
    expect(s.groups[1].texts).toHaveLength(1);
  });

  it('lets a customer value replace the merchant sample', () => {
    const s = buildScene({
      width: 100,
      height: 100,
      groups: [],
      textOptions: [{ key: 'o', design: text(), value: 'James' }],
    });
    expect(s.groups[0].texts[0].text).toBe('James');
  });

  it('multiplies layer and crop opacity rather than letting one override', () => {
    const s = buildScene({
      width: 100,
      height: 100,
      groups: [
        {
          key: 'g',
          visible: true,
          layers: [
            layer({
              opacity: 50,
              shape: 'circle',
              crop: { style: 'free', xPct: 0.5, yPct: 0.5, wPct: 1, rot: 0, opacity: 50 },
            }),
          ],
        },
      ],
    });
    expect(s.groups[0].images[0].opacity).toBeCloseTo(0.25, 10);
  });

  it('renders inner rotation only for a free inner style', () => {
    const framed = (style: 'free' | 'cover') =>
      buildScene({
        width: 100,
        height: 100,
        groups: [
          {
            key: 'g',
            visible: true,
            layers: [
              layer({
                shape: 'circle',
                crop: { style, xPct: 0.5, yPct: 0.5, wPct: 1, rot: 30, opacity: 100 },
              }),
            ],
          },
        ],
      }).groups[0].images[0].innerRot;
    expect(framed('free')).toBe(30);
    expect(framed('cover')).toBe(0);
  });

  it('carries a frame only for shaped layers', () => {
    const plain = buildScene({
      width: 100, height: 100,
      groups: [{ key: 'g', visible: true, layers: [layer()] }],
    }).groups[0].images[0];
    const shaped = buildScene({
      width: 100, height: 100,
      groups: [{ key: 'g', visible: true, layers: [layer({ shape: 'star' })] }],
    }).groups[0].images[0];
    expect(plain.frame).toBeUndefined();
    expect(shaped.frame).toBeDefined();
  });

  it('carries a mask href only for a custom PNG shape', () => {
    const s = buildScene({
      width: 100, height: 100,
      groups: [{
        key: 'g', visible: true,
        layers: [layer({ shape: 'image', shapeSrc: 'mask.png' })],
      }],
    });
    expect(s.groups[0].images[0].shapeHref).toBe('mask.png');
  });
});

describe('sceneToSvgString', () => {
  const sceneWith = (l: Partial<DesignLayer>) =>
    buildScene({
      width: 800, height: 600, backgroundHref: 'bg.png',
      groups: [{ key: 'g', visible: true, layers: [layer(l)] }],
    });

  it('emits a clipPath for a path shape and a mask for a PNG shape', () => {
    expect(sceneToSvgString(sceneWith({ shape: 'circle' }))).toContain('<clipPath');
    const png = sceneToSvgString(sceneWith({ shape: 'image', shapeSrc: 'm.png' }));
    expect(png).toContain('<mask');
    expect(png).toContain('mask-type:alpha');
  });

  it('sets mask-type as both attribute and style, for renderers that read one', () => {
    const svg = sceneToSvgString(sceneWith({ shape: 'image', shapeSrc: 'm.png' }));
    expect(svg).toContain('mask-type="alpha"');
    expect(svg).toContain('style="mask-type:alpha"');
  });

  it('omits the mask entirely when a PNG shape has no source', () => {
    // ⚠️ `shapeSrc` is `string | undefined`, matching the source's own
    // `types.ts`. The source's `effectiveShape` widens it to `string | null` in
    // an inline parameter type, but the stored shape is the declaration — and an
    // absent mask falls back to `none` rather than rendering an empty clip.
    const svg = sceneToSvgString(sceneWith({ shape: 'image', shapeSrc: undefined }));
    expect(svg).not.toContain('<mask');
  });

  it('marks the background so the storefront can drop it in overlay mode', () => {
    expect(sceneToSvgString(sceneWith({}))).toContain('data-design-bg="1"');
  });

  it('marks each group with its key so selection can toggle visibility', () => {
    expect(sceneToSvgString(sceneWith({}))).toContain('data-design-group="g"');
  });

  it('hides an invisible group with display:none rather than omitting it', () => {
    const s = buildScene({
      width: 100, height: 100,
      groups: [{ key: 'g', visible: false, layers: [layer()] }],
    });
    expect(sceneToSvgString(s)).toContain('display:none');
  });

  it('escapes XML in every attribute it interpolates', () => {
    const s = buildScene({
      width: 100, height: 100, backgroundHref: 'a&b.png',
      groups: [{ key: 'g&1', visible: true, layers: [layer({ src: '<x>.png' })] }],
    });
    const svg = sceneToSvgString(s);
    expect(svg).toContain('a&amp;b.png');
    expect(svg).toContain('g&amp;1');
    expect(svg).toContain('&lt;x&gt;.png');
  });

  it('qualifies ids by prefix so two scenes on a page never collide', () => {
    const s = sceneWith({ shape: 'circle' });
    expect(sceneToSvgString(s, 'one')).toContain('id="one-');
    expect(sceneToSvgString(s, 'two')).toContain('id="two-');
  });

  it('routes every text node through the pluggable renderer', () => {
    const s = buildScene({
      width: 100, height: 100, groups: [],
      textOptions: [{ key: 'o', design: text() }],
    });
    const svg = sceneToSvgString(s, 'dl', () => '<!--STUB-->');
    expect(svg).toContain('<!--STUB-->');
    expect(svg).not.toContain('<tspan');
  });
});

describe('serializeTextNode', () => {
  const node = (d: Partial<TextDesign>) =>
    buildScene({
      width: 800, height: 600, groups: [],
      textOptions: [{ key: 'o', design: text(d) }],
    }).groups[0].texts[0];

  it('emits a textPath on an arc for curved text', () => {
    const svg = serializeTextNode(node({ curve: 50 }), 'dl', 0, 0, 800, 600);
    expect(svg).toContain('<textPath');
    expect(svg).toContain('<path id="dl-txp-0-0"');
  });

  it('emits both href and xlink:href, for renderers that read only one', () => {
    const svg = serializeTextNode(node({ curve: 50 }), 'dl', 0, 0, 800, 600);
    expect(svg).toContain('href="#dl-txp-0-0"');
    expect(svg).toContain('xlink:href="#dl-txp-0-0"');
  });

  it('emits one tspan per wrapped line for flat text', () => {
    const svg = serializeTextNode(
      node({ text: 'a\nb\nc', pos: { xPct: 0.5, yPct: 0.5, wPct: 0.9 } }),
      'dl', 0, 0, 800, 600,
    );
    expect(svg.split('<tspan').length - 1).toBe(3);
  });

  it('spaces wrapped lines by LINE_HEIGHT, the same constant the fit uses', () => {
    // 🔴 If this ever diverges from fitTextToBox, text is measured at one line
    // height and drawn at another — it fits in the editor and overflows print.
    const tx = node({ text: 'a\nb', sizePct: 0.05 });
    const svg = serializeTextNode(tx, 'dl', 0, 0, 800, 600);
    const dy = Number(/dy="([\d.]+)"/.exec(svg)?.[1]);
    expect(dy).toBeCloseTo(tx.fontSize * LINE_HEIGHT, 9);
  });

  it('substitutes a space for an empty line so the tspan still advances', () => {
    // An empty <tspan> collapses and the following line rides up, so the blank
    // line carries a space. It still takes its `dy`, being a non-first line.
    const svg = serializeTextNode(node({ text: 'a\n\nb' }), 'dl', 0, 0, 800, 600);
    expect(svg).toContain('<tspan x="400" dy="75"> </tspan>');
    expect(svg.split('<tspan').length - 1).toBe(3);
  });

  it('escapes the customer\'s own text, which is untrusted input', () => {
    const svg = serializeTextNode(
      node({ text: '<script>&"' }), 'dl', 0, 0, 800, 600,
    );
    expect(svg).toContain('&lt;script&gt;&amp;&quot;');
    expect(svg).not.toContain('<script>');
  });

  it('omits letter-spacing entirely when it is zero', () => {
    expect(serializeTextNode(node({}), 'dl', 0, 0, 800, 600)).not.toContain('letter-spacing');
  });

  it('omits the rotate transform when the design is unrotated', () => {
    expect(serializeTextNode(node({}), 'dl', 0, 0, 800, 600)).not.toContain('rotate(');
    expect(serializeTextNode(node({ rot: 20 }), 'dl', 0, 0, 800, 600)).toContain('rotate(20');
  });

  it('marks every text node so the storefront can live-swap its content', () => {
    expect(serializeTextNode(node({}), 'dl', 0, 0, 800, 600)).toContain('data-design-text="1"');
    expect(serializeTextNode(node({ curve: 50 }), 'dl', 0, 0, 800, 600)).toContain('data-design-text="1"');
  });
});
