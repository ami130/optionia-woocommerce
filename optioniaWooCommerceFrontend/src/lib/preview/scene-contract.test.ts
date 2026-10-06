import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildScene, sceneToSvgString } from '@shared/design/design-scene';

/**
 * The dashboard preview draws the same bytes the merchant's order prints.
 *
 * 🔴 **One renderer, which is M26d.6's wording — "never a second renderer".**
 * The storefront, the print file and this preview all resolve through
 * `buildScene` and draw through `sceneToSvgString`. A preview that agreed with
 * the print file only by accident is how a merchant approves one picture and
 * ships another.
 *
 * ⚠️ **`scene-contract.json` is captured from the PLUGIN's own composer** and
 * held byte-identical in three repositories. The plugin asserts it still
 * produces these bytes; the backend and this assert they still draw. That
 * contract previously lived in two languages with no mechanical link, and it
 * broke: every real designed order threw and dead-lettered while 1,333 backend
 * tests passed, because every fixture described the serializer's input rather
 * than the composer's output.
 */
describe('the scene contract', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '../../../test/fixtures/shared/scene-contract.json'), 'utf8'),
  ) as { scene: Record<string, unknown> };

  const render = (): string => sceneToSvgString(buildScene(fixture.scene as never), 'fx');

  it('draws the plugin’s own composed scene', () => {
    const svg = render();

    expect(svg.split('<image').length - 1).toBe(1);
    expect(svg.split('<text').length - 1).toBe(1);
  });

  it('shows the customer’s text, not the merchant’s sample', () => {
    const svg = render();

    expect(svg).toContain('Omi Hasan');
    expect(svg).not.toContain('Your text');
  });

  /*
   * ⚠️ **`NaN` is how a blank preview returns.** Every coordinate comes from
   * resolving a fraction; a key the resolver cannot find yields `NaN`, which
   * serialises happily into an SVG that renders as nothing.
   */
  it('resolves every coordinate to a real number', () => {
    const svg = render();

    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('undefined');
  });
});
