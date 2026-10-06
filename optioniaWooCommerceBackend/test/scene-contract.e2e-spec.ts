import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildScene, sceneToSvgString } from '@shared/design/design-scene';

/**
 * The renderer still consumes what the PLUGIN composes (M26e.4).
 *
 * 🔴 **This contract lived in two languages with no mechanical link, and it
 * broke in the worst possible way: silently.** `Engine\SceneComposer` emits
 * `groups` of `layers` in FRACTIONS plus `textOptions`; `sceneToSvgString`
 * consumes `images` and `texts` already resolved to viewBox pixels.
 * `buildScene` is the function between them, and neither the render worker nor
 * `POST /store/preview` called it — so every real designed order threw
 * `Cannot read properties of undefined (reading 'forEach')` and dead-lettered.
 *
 * ⚠️ **1,333 e2e tests passed throughout**, because every fixture had been
 * written in the RESOLVED shape — describing the serializer's input rather
 * than the composer's output. A fixture that cannot represent what production
 * sends cannot test production. It was found by rendering one job on a live
 * worker, which returned a valid 600×600 PNG with nothing drawn on it.
 *
 * 📌 **So this renders the PLUGIN'S OWN BYTES.** `scene-contract.json` is
 * captured from `SceneComposer::compose()` by running it, held byte-identical
 * in three repositories and gated by `check-fixture-parity.sh`. The plugin
 * asserts it still produces these bytes; this asserts they still draw.
 */
describe('the scene contract (e2e)', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures/shared/scene-contract.json'), 'utf8'),
  ) as { scene: Record<string, unknown> };

  /** What the worker and the preview route both do, in two calls. */
  const render = (): string => sceneToSvgString(buildScene(fixture.scene as never), 'fx');

  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it('draws the chosen value’s artwork', () => {
    const svg = render();

    expect(occurrences(svg, '<image')).toBe(1);
    expect(svg).toContain('https://cdn.example/crest.png');
  });

  /*
   * 🔴 **The customer's typed value, not the merchant's sample.** A text
   * option carries one design whose `text` is the merchant's placeholder;
   * what the customer typed replaces it. Rendering the sample would print the
   * wrong words on every engraved product.
   */
  it('draws what the customer typed, not the sample text', () => {
    const svg = render();

    expect(occurrences(svg, '<text')).toBe(1);
    expect(svg).toContain('Omi Hasan');
    expect(svg).not.toContain('Your text');
  });

  /*
   * ⚠️ **`NaN` is how this defect would return.** Every coordinate in the
   * document comes from resolving a fraction against the canvas; a key the
   * resolver cannot find yields `NaN`, which serialises happily into an SVG
   * that renders as nothing. A blank print file is the symptom; this is the
   * cause, asserted directly.
   */
  it('resolves every coordinate to a real number', () => {
    const svg = render();

    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('undefined');
  });

  /*
   * 📌 **Fractions became pixels.** `wPct: 0.6` on a 2000px canvas is 1200,
   * letterboxed by the authoring canvas (Decision 5). Asserting a resolved
   * NUMBER rather than merely "an image exists" is what distinguishes a
   * rendered scene from one that drew an element of size zero.
   */
  it('resolves fractions against the canvas', () => {
    const svg = render();
    const widths = [...svg.matchAll(/width="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));

    expect(widths.some((w) => w > 100)).toBe(true);
  });

  /*
   * 🔴 **The two calls are the contract.** Serialising the fixture WITHOUT
   * `buildScene` is exactly what shipped, and it must not quietly produce a
   * drawable document — this pins that the resolution step is load-bearing
   * rather than decorative.
   */
  it('cannot be drawn without buildScene', () => {
    expect(() => sceneToSvgString(fixture.scene as never, 'fx')).toThrow();
  });
});
