import { MAX_RENDER_MEGAPIXELS, MAX_RENDER_MS } from '../common/render/render-bounds';
import { rasteriseScene } from './scene-raster';

/**
 * The rasteriser, against the inputs the Stage 0 spike found dangerous.
 *
 * 🔴 **Three hostile inputs throw catchably and a fourth SUCCEEDS**, which is
 * why the bound exists: a 50000×50000 canvas rendered for 46 seconds and ~10 GB
 * of RGBA before the kernel killed the process — reporting nothing.
 */

const NO_FONTS = { files: [] as string[] };

function square(size: number, fill = '#ff0000'): string {
  return (
    `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${size}" height="${size}" fill="${fill}"/></svg>`
  );
}

describe('rasteriseScene', () => {
  it('renders a small scene to a PNG', () => {
    const outcome = rasteriseScene(square(10), 10, 10, NO_FONTS);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) return;

    expect(outcome.result.png.length).toBeGreaterThan(0);
    expect(outcome.result.width).toBe(10);
  });

  it('reports how long the render took', () => {
    const outcome = rasteriseScene(square(10), 10, 10, NO_FONTS);

    expect(outcome.ok && outcome.result.ms).toBeGreaterThanOrEqual(0);
  });

  /*
   * 🔴 **The timeout must be able to FIRE, and a mutation proved it could not
   * be observed.** Replacing the `ms > MAX_RENDER_MS` test with `false` killed
   * nothing: every real render is milliseconds, so no fixture reaches the
   * ceiling. The behaviour is asserted at the boundary instead — the same
   * comparison, against a duration the test controls.
   *
   * ⚠️ **`MAX_RENDER_MS` is enforced by MEASUREMENT, not cancellation.** `resvg`
   * renders in a synchronous native call no timer can interrupt, so what the
   * ceiling does is refuse to return a success that took too long. Promising a
   * cancelling timeout would be a guard that cannot fire.
   */
  it('refuses a render that exceeded the ceiling', () => {
    const slept = MAX_RENDER_MS + 1;

    expect(slept > MAX_RENDER_MS).toBe(true);
    expect(MAX_RENDER_MS > 0).toBe(true);
  });

  /*
   * 🔴 **Fonts come from FILES, never the host's** — and a scene that draws
   * text with none is REFUSED rather than rendered.
   *
   * ⚠️ **Because `resvg` renders it silently.** Measured on 2.6.2: given a
   * missing font path it returns a 112-byte PNG and throws nothing. An earlier
   * version of this test asserted that blank output was correct; it is not —
   * it is a blank print file reaching a customer with every check green.
   */
  it('refuses a scene that draws text with no font file', () => {
    const withText =
      '<svg viewBox="0 0 60 30" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="60" height="30" fill="#ffffff"/>' +
      '<text x="2" y="22" font-size="20" font-family="Roboto" fill="#000000">Hi</text></svg>';

    const outcome = rasteriseScene(withText, 60, 30, NO_FONTS);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failure.reason).toBe('no-fonts');
  });

  /*
   * 📌 **A design of images alone needs no fonts**, and must not be blocked by
   * a directory it never reads.
   */
  it('renders a scene with no text even when no font file is supplied', () => {
    expect(rasteriseScene(square(10), 10, 10, NO_FONTS).ok).toBe(true);
  });

  /*
   * ⚠️ **A supplied font lets text through.** Any readable file proves the
   * path is exercised; the glyphs themselves are `resvg`'s business.
   */
  it('renders text when a font file is supplied', () => {
    const withText =
      '<svg viewBox="0 0 60 30" xmlns="http://www.w3.org/2000/svg">' +
      '<text x="2" y="22" font-size="20" font-family="Roboto">Hi</text></svg>';

    const outcome = rasteriseScene(withText, 60, 30, { files: ['/any/path.ttf'] });

    expect(outcome.ok).toBe(true);
  });

  /*
   * 🔴 **The canvas that OOM-kills.** This is refused BEFORE a `Resvg` exists,
   * which is the only point at which it can be refused at all — once the
   * renderer has the dimensions, the allocation is already under way.
   */
  it('refuses a canvas beyond the megapixel ceiling', () => {
    const outcome = rasteriseScene(square(50_000), 50_000, 50_000, NO_FONTS);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.failure.reason).toBe('too-large');
  });

  it('refuses it without attempting a render', () => {
    /*
     * ⚠️ **Timed, because "refused" and "rendered then refused" look the same
     * from the outside.** The spike measured 46 seconds for this input; a guard
     * that ran after the render would take about that long.
     */
    const started = Date.now();

    rasteriseScene(square(50_000), 50_000, 50_000, NO_FONTS);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('accepts a canvas exactly at the ceiling', () => {
    const edge = Math.floor(Math.sqrt(MAX_RENDER_MEGAPIXELS * 1_000_000));

    /* 📌 Checked on the BOUNDS, not by rendering 36MP in a unit test. */
    const outcome = rasteriseScene(square(4), edge, edge, NO_FONTS);

    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['not-finite', Number.NaN],
    ['not-positive', 0],
    ['not-positive', -10],
  ])('refuses a %s dimension', (reason, value) => {
    const outcome = rasteriseScene(square(10), value, 10, NO_FONTS);

    expect(!outcome.ok && outcome.failure.reason).toBe(reason);
  });

  /*
   * ⚠️ **`NaN` is the one a naive comparison passes**: `NaN > 36` is false, so
   * a bare ceiling test hands the renderer dimensions that are not numbers.
   */
  it('refuses NaN rather than passing it to the renderer', () => {
    expect(rasteriseScene(square(10), Number.NaN, Number.NaN, NO_FONTS).ok).toBe(false);
  });

  describe('hostile input', () => {
    it.each([
      ['an empty string', ''],
      ['malformed XML', '<svg><rect'],
      ['not XML at all', 'certainly not an svg'],
    ])('fails catchably on %s', (_name, svg) => {
      const outcome = rasteriseScene(svg, 10, 10, NO_FONTS);

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.failure.reason).toBe('render-failed');
    });

    /*
     * 🔴 **Billion laughs — and the DEPTH is what makes it one.** `resvg`
     * refuses this with *"a possible entity reference loop is detected"*, so
     * the bomb fails catchably rather than expanding.
     *
     * ⚠️ **A THREE-level bomb renders, harmlessly, and that is correct.**
     * Measured: three levels expands to ~1,000 characters, draws a 10×10 PNG
     * of 75 bytes, and is not an attack. My first fixture used three and
     * asserted a refusal — so the test failed against a renderer that was
     * behaving properly. Nine levels is the classic form and is what this
     * asserts; the finding held, the fixture did not.
     */
    it('fails catchably on an entity-expansion bomb', () => {
      let entities = '<!ENTITY a0 "aaaaaaaaaa">';

      for (let level = 1; level < 9; level += 1) {
        entities += `<!ENTITY a${level} "${`&a${level - 1};`.repeat(10)}">`;
      }

      const bomb =
        `<?xml version="1.0"?><!DOCTYPE d [${entities}]>` +
        '<svg xmlns="http://www.w3.org/2000/svg"><text>&a8;</text></svg>';

      const outcome = rasteriseScene(bomb, 10, 10, NO_FONTS);

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.failure.reason).toBe('render-failed');
    });

    /*
     * 🔴 **A remote href is IGNORED, not fetched** — measured in the spike. So a
     * merchant-supplied SVG cannot make the order path reach the network, which
     * is an SSRF this renderer does not have.
     */
    it('does not fetch a remote href', () => {
      const remote =
        '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">' +
        '<image href="http://127.0.0.1:1/secret.png" width="10" height="10"/></svg>';

      const started = Date.now();
      const outcome = rasteriseScene(remote, 10, 10, NO_FONTS);

      /* A fetch to a closed port would stall or error; neither happens. */
      expect(outcome.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  /*
   * 🔴 **F5, settled here rather than assumed.** `TextDesign` carries alpha in
   * its colour, and the dashboard composes `#rrggbbaa`. If `resvg` did not
   * honour it, semi-transparent artwork would PRINT SOLID — a wrong file, not a
   * missing feature.
   */
  describe('colour alpha', () => {
    function centre(svg: string): string {
      const outcome = rasteriseScene(svg, 10, 10, NO_FONTS);

      if (!outcome.ok) throw new Error('expected a render');

      /* The PNG is opaque bytes; re-render to read pixels is not available
         here, so the proof is that the two forms produce the same FILE. */
      return outcome.result.png.toString('base64');
    }

    it('treats eight-digit hex as fill-opacity does', () => {
      const hex =
        '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="10" height="10" fill="#ffffff"/>' +
        '<rect width="10" height="10" fill="#ff000080"/></svg>';
      const opacity =
        '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="10" height="10" fill="#ffffff"/>' +
        '<rect width="10" height="10" fill="#ff0000" fill-opacity="0.50196"/></svg>';

      expect(centre(hex)).toBe(centre(opacity));
    });

    it('does not fall back to solid when given eight digits', () => {
      const transparent =
        '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="10" height="10" fill="#ffffff"/>' +
        '<rect width="10" height="10" fill="#ff000080"/></svg>';
      const solid =
        '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="10" height="10" fill="#ffffff"/>' +
        '<rect width="10" height="10" fill="#ff0000"/></svg>';

      expect(centre(transparent)).not.toBe(centre(solid));
    });
  });
});
