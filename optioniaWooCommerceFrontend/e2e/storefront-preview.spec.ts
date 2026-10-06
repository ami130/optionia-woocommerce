import { expect, test } from '@playwright/test';

/**
 * The storefront preview, in a real browser (M26e.1, stage B).
 *
 * 🔴 **Every other check of this runtime has been indirect.** Its logic was
 * exercised in Node against real bytes, its endpoint has twelve PHP tests, and
 * the page was fetched with curl — none of which runs `composeScene` against
 * real DOM, clicks a real swatch, or proves anything appears.
 *
 * ⚠️ **Two defects in this feature were found by running it rather than
 * testing it**: a custom nonce in `X-WP-Nonce`, which WordPress refuses before
 * any permission callback, and an SVG arriving JSON-encoded whatever the
 * Content-Type said. Both passed every unit test. This is the layer underneath
 * those.
 *
 * 📌 **Against the live store**, not a fixture: the product, the option set and
 * the design are the merchant's own.
 */
const STOREFRONT = process.env.E2E_STOREFRONT_URL ?? 'https://optionia.local';
const PRODUCT = process.env.E2E_DESIGNED_PRODUCT ?? '/product/spider-man/';

test.describe('the storefront design preview', () => {
  test('draws the artwork a customer chooses', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      if (request.url().includes('/optionia/v1/preview')) {
        requests.push(request.method());
      }
    });

    await page.goto(STOREFRONT + PRODUCT, { waitUntil: 'domcontentloaded' });

    /*
     * 🔴 **The design must be ON the page**, which is stage A. Asserted first
     * so a failure says "the artwork never arrived" rather than "the preview
     * did not draw" — two different bugs with one symptom.
     */
    const designed = page.locator('[data-optionia-design]');

    await expect(designed).toHaveCount(1);

    const raw = await designed.first().getAttribute('data-optionia-design');

    expect(raw, 'the design attribute carries JSON').toBeTruthy();
    expect(() => JSON.parse(String(raw))).not.toThrow();

    /*
     * ⚠️ **Click the swatch's own input.** `composeScene` reads `checked` on
     * the element carrying the design, so a test clicking a wrapping label
     * could pass while the runtime looked at the wrong node.
     */
    await designed.first().check({ force: true });

    /*
     * The preview is debounced by 250ms and then makes a round trip through
     * WordPress to the cloud, so this waits on the ELEMENT rather than a
     * timer.
     */
    const svg = page.locator('[data-optionia-preview] svg');

    await expect(svg).toHaveCount(1, { timeout: 15_000 });

    /*
     * 📌 **A `<svg>` with no geometry is a blank preview**, which is exactly
     * what shipped once when `buildScene` was never called. The image node
     * and a resolved width are what distinguish a drawing from an empty
     * document.
     */
    const markup = await page.locator('[data-optionia-preview]').innerHTML();

    expect(markup).toContain('<image');
    expect(markup).not.toContain('NaN');

    expect(requests, 'the runtime asked WordPress, not the cloud').toContain('POST');
  });

  /**
   * ⚠️ **A product with no designed option must make no request.** Asking the
   * cloud to draw nothing spends a merchant's bounded preview allowance.
   */
  test('asks for nothing when no option carries a design', async ({ page }) => {
    const requests: string[] = [];

    page.on('request', (request) => {
      if (request.url().includes('/optionia/v1/preview')) {
        requests.push(request.url());
      }
    });

    /*
     * 🔴 **A product with no Optionia options at all.** `custom-hoodie` was
     * the obvious choice and the wrong one: it shares its option set with
     * `spider-man`, so the same designed swatch appears on both — the test
     * failed on a fixture mistake rather than a defect, which is worth
     * recording because "a different product" is not the same as "a product
     * without this option".
     */
    await page.goto(STOREFRONT + '/product/test-variable-tee/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);

    expect(await page.locator('[data-optionia-design]').count()).toBe(0);
    expect(requests).toHaveLength(0);
  });
});
