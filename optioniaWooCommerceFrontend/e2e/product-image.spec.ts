import { expect, test } from '@playwright/test';

import { freshPluginAssets } from './fixtures';

/**
 * Finding the product's own image, on a real theme (M26e.2).
 *
 * 🔴 **"A design on the wrong product is worse than no preview"** is M26e.2's
 * own rule, and this is what proves it holds.
 *
 * 📌 **Measured before it was written.** A stock Storefront product page
 * carries FIVE product thumbnails — one real, three related tiles and one
 * prev/next pagination thumbnail — and every one of them is nested INSIDE the
 * viewed product's own `post-<id>` wrapper. The first version of this test
 * asserted only that the finder picked a non-placeholder image, which the
 * largest-image-on-the-page rule also satisfies; it passed against a finder
 * that did no filtering at all. These assertions are chosen to fail for that
 * finder.
 */
const STOREFRONT = process.env.E2E_STOREFRONT_URL ?? 'https://optionia.local';
const PRODUCT = STOREFRONT + '/product/spider-man/';

/**
 * This suite drives the plugin's real image finder, which only exists when
 * `SCRIPT_DEBUG` is on.
 *
 * 🔴 **Checked once, with the fix in the message.** The runtime exposes
 * `window.optioniaTest` only under `SCRIPT_DEBUG`, so that it never ships to a
 * merchant's storefront — which means a developer on a fresh machine gets
 * failures from a correctly-working plugin. The dependency lives in
 * `wp-config.php`, outside this repository and outside its gitignore, so
 * nothing else can tell them.
 *
 * ⚠️ **A hard failure, not a skip.** Silently skipping would mean the rule
 * M26e.2 exists to enforce — never draw on the wrong product — stops being
 * checked without anybody noticing.
 */
test.beforeAll( async ( { browser } ) => {
  const page = await browser.newPage();

  try {
    await page.goto( PRODUCT, { waitUntil: 'domcontentloaded' } );

    const exposed = await page.evaluate(
      () => typeof ( window as unknown as { optioniaTest?: unknown } ).optioniaTest
    );

    if ( exposed === 'undefined' ) {
      throw new Error(
        '\nThis suite calls the plugin\u2019s real image finder, which is behind SCRIPT_DEBUG.\n\n' +
          '  Add to your WordPress wp-config.php:\n' +
          "    define( 'SCRIPT_DEBUG', true );\n\n" +
          '  It is a local-only flag: it is false on every production install,\n' +
          '  which is why the plugin does not expose its internals to a shop.\n'
      );
    }
  } finally {
    await page.close();
  }
} );

/**
 * Runs the shipped finder from the plugin's own bundle against the live page.
 *
 * 🔴 **The real `productImage` is called, never a copy.** A transcription of
 * the algorithm into the test would pass while production failed — the trap
 * this project has hit before, where a fixture described the test's idea of
 * the code rather than the code.
 */
async function findImage( page: import( '@playwright/test' ).Page ) {
  return page.evaluate( () => {
    /*
     * The plugin's narrow test window. Declared here rather than globally
     * because only this suite reads it.
     */
    const api = ( window as unknown as {
      optioniaTest?: { productImage?: ( root: Element ) => HTMLImageElement | null };
    } ).optioniaTest;

    const root = document.querySelector( '[data-optionia="options"]' );

    if ( ! api?.productImage ) {
      return { error: 'the plugin exposes no productImage to drive' };
    }

    if ( ! root ) {
      return { error: 'no options root on the page' };
    }

    const found = api.productImage( root );

    return {
      src: found?.getAttribute( 'src' ) ?? null,
      inGallery: !! found?.closest( '.woocommerce-product-gallery' ),
      inRelated: !! found?.closest( '.related, .up-sells, .cross-sells' ),
      inPagination: !! found?.closest( 'nav' ),
    };
  } );
}

/**
 * Makes a related tile the LARGEST image on the page.
 *
 * 🔴 **Without this the test cannot tell the two rules apart.** As the theme
 * ships, the gallery image is already the biggest (≈104,855px² against
 * ≈53,491px²), so a finder with no filtering at all picks the right image by
 * luck and every assertion below passes. Deleting the filter was tried, and
 * the suite stayed green — this helper is what made it fail.
 *
 * ⚠️ **Nothing about the page's STRUCTURE is changed**, only one tile's size.
 * The markup a theme emits is left exactly as WooCommerce wrote it; this
 * merely removes the coincidence that was hiding the bug.
 */
async function enlargeARelatedTile( page: import( '@playwright/test' ).Page ) {
  const enlarged = await page.evaluate( () => {
    const tile = document.querySelector< HTMLImageElement >(
      '.related img, .up-sells img, .cross-sells img'
    );

    if ( ! tile ) {
      return false;
    }

    tile.style.width = '900px';
    tile.style.height = '900px';

    return true;
  } );

  expect( enlarged, 'the page must render a related tile to enlarge' ).toBe( true );
}

test.describe( 'finding the product image', () => {
  test( 'the page really does carry other products’ images', async ( { page } ) => {
    await freshPluginAssets( page );
    await page.goto( PRODUCT, { waitUntil: 'domcontentloaded' } );

    /*
     * 🔴 **This guards the fixture, not the code.** If the theme stops
     * rendering related products, every assertion below passes vacuously and
     * the suite silently stops testing anything.
     */
    const shape = await page.evaluate( () => {
      const root = document.querySelector( '[data-optionia="options"]' );
      const id = root?.getAttribute( 'data-optionia-product' ) ?? '';
      const wrapper = root?.closest( '.post-' + id ) ?? null;
      const impostors = [ ...document.querySelectorAll( 'img' ) ].filter(
        ( i ) => i.closest( '.related, .up-sells, .cross-sells, nav' )
      );

      return {
        impostors: impostors.length,
        impostorsInsideWrapper: impostors.filter( ( i ) => wrapper?.contains( i ) ).length,
      };
    } );

    expect( shape.impostors, 'the page must show other products' ).toBeGreaterThan( 0 );

    /*
     * ⚠️ **The impostors are INSIDE our wrapper**, which is precisely why the
     * wrapper alone cannot be the filter.
     */
    expect(
      shape.impostorsInsideWrapper,
      'the wrapper must contain the impostors, or this page no longer poses the problem'
    ).toBe( shape.impostors );
  } );

  test( 'picks the gallery image, never a related or pagination tile', async ( { page } ) => {
    await freshPluginAssets( page );
    await page.goto( PRODUCT, { waitUntil: 'domcontentloaded' } );
    await enlargeARelatedTile( page );

    const found = await findImage( page );

    expect( found.error, 'the finder must be reachable' ).toBeUndefined();

    /*
     * 🔴 **Positive attribution.** Not merely "not a placeholder" — the chosen
     * image must be the gallery's, which is the only claim that stays true on
     * a theme where a related tile renders larger than the product image.
     */
    expect( found.inGallery, 'the chosen image must be the product gallery’s' ).toBe( true );
    expect( found.inRelated, 'a related tile is another product' ).toBe( false );
    expect( found.inPagination, 'a pagination thumbnail is another product' ).toBe( false );
  } );

  test( 'draws nothing where no options block anchors it', async ( { page } ) => {
    await freshPluginAssets( page );
    await page.goto( STOREFRONT + '/?post_type=product', { waitUntil: 'domcontentloaded' } );

    /*
     * ⚠️ **The fail-closed half.** An archive shows many products and none is
     * "the" product, so there is nothing to anchor on and nothing is drawn.
     */
    expect( await page.locator( '[data-optionia="options"]' ).count() ).toBe( 0 );
  } );
} );

/**
 * Replaces the gallery image the way a variation change does.
 *
 * 🔴 **Measured, not imagined.** WooCommerce does not mutate the `src` of the
 * existing image — it replaces the image element AND its
 * `woocommerce-product-gallery__image` wrapper. That destroys the node the
 * preview is mounted in, which is why the preview vanished entirely until a
 * watcher was added. A test that only changed `src` would miss this.
 */
async function swapGalleryImage( page: import( '@playwright/test' ).Page ) {
  const swapped = await page.evaluate( () => {
    const root = document.querySelector( '[data-optionia="options"]' );

    if ( ! root ) {
      return 'no options root on the page';
    }

    const api = ( window as unknown as {
      optioniaTest?: { productImage?: ( root: Element ) => HTMLImageElement | null };
    } ).optioniaTest;

    if ( ! api?.productImage ) {
      return 'the plugin exposes no productImage — is SCRIPT_DEBUG on?';
    }

    const image = api.productImage( root );
    const wrapper = image?.parentElement;

    if ( ! image || ! wrapper?.parentNode ) {
      return 'no product image to swap';
    }

    const replacement = document.createElement( 'div' );
    replacement.className = 'woocommerce-product-gallery__image';

    const swapped = document.createElement( 'img' );
    swapped.className = 'wp-post-image';
    swapped.src = image.src;
    /* A different size, so "the preview followed" cannot pass by coincidence. */
    swapped.style.width = '600px';
    swapped.style.height = '600px';

    replacement.appendChild( swapped );
    wrapper.parentNode.replaceChild( replacement, wrapper );

    return null;
  } );

  /*
   * 🔴 **A swap that did not happen must fail HERE, naming why.** This used to
   * return silently: the image was never replaced, the preview was never
   * destroyed, and the "the design must come back" assertion below passed
   * against a page nothing had been done to. Measured by turning `SCRIPT_DEBUG`
   * off — the test failed, but on a later assertion that explained nothing.
   */
  expect( swapped, 'the gallery image must actually be swapped' ).toBeNull();
}

test.describe( 'the preview survives the theme changing the image (M26e.3)', () => {
  test( 'redraws onto the new image after a variation swap', async ( { page } ) => {
    await freshPluginAssets( page );
    await page.goto( PRODUCT, { waitUntil: 'networkidle' } );

    await page.locator( '[data-optionia="options"] input[type=radio]' )
      .first().click( { force: true } ).catch( () => {} );

    /*
     * The preview must exist BEFORE the swap, or the assertion after it would
     * pass against a page that never drew anything.
     */
    await expect(
      page.locator( '[data-optionia-preview] svg' ),
      'a design must be on screen before the swap'
    ).toBeVisible( { timeout: 15000 } );

    await swapGalleryImage( page );

    /*
     * 🔴 **This is the whole point.** Without the gallery watcher the host is
     * destroyed with its wrapper and nothing redraws it: measured on a real
     * page, the design disappeared and never returned, because a variation
     * change fires no event inside the options block.
     */
    await expect(
      page.locator( '[data-optionia-preview] svg' ),
      'the design must come back after the theme replaces the image'
    ).toBeVisible( { timeout: 15000 } );

    const landed = await page.evaluate( () => {
      const host = document.querySelector( '[data-optionia-preview]' );
      const root = document.querySelector( '[data-optionia="options"]' );
      const api = ( window as unknown as {
        optioniaTest?: { productImage?: ( root: Element ) => HTMLImageElement | null };
      } ).optioniaTest;
      const image = root ? api?.productImage?.( root ) : null;

      if ( ! host || ! image ) {
        return null;
      }

      const h = host.getBoundingClientRect();
      const i = image.getBoundingClientRect();

      return {
        sameParent: host.parentElement === image.parentElement,
        aligned: Math.abs( h.left - i.left ) < 3 && Math.abs( h.width - i.width ) < 3,
        width: Math.round( i.width ),
      };
    } );

    expect( landed, 'both the host and the image must be findable' ).not.toBeNull();

    /* ⚠️ On the NEW element, not merely still on screen somewhere. */
    expect( landed?.sameParent, 'the preview must move to the new image' ).toBe( true );
    expect( landed?.aligned, 'the preview must track the new image’s box' ).toBe( true );
  } );

  test( 'draws once a gallery that was absent at first paint arrives', async ( { page } ) => {
    await freshPluginAssets( page );
    /*
     * 🔴 **Hidden before the plugin binds**, so `productImage()` finds nothing
     * at first paint and the gallery watcher has no element to observe. A
     * lazy-loaded or slider-built gallery is exactly this shape.
     */
    await page.addInitScript( () => {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          const gallery = document.querySelector< HTMLElement >( '.woocommerce-product-gallery' );

          if ( gallery ) {
            gallery.setAttribute( 'data-hidden-by-test', '1' );
            gallery.style.display = 'none';
          }
        },
        { capture: true }
      );
    } );

    await page.goto( PRODUCT, { waitUntil: 'networkidle' } );

    /*
     * ⚠️ **The design is chosen while the gallery is still hidden.** Without
     * this the test proves nothing: the default selection carries no design,
     * so there would be no preview to draw and the assertion below would be
     * measuring an empty page rather than the watcher.
     */
    await page.locator( '[data-optionia="options"] input[type=radio]' )
      .first().click( { force: true } ).catch( () => {} );

    /*
     * 🔴 **The click's own draw must finish BEFORE the gallery is revealed.**
     * `drawPreview` is debounced and then waits on the network, so revealing
     * immediately leaves that draw in flight — it lands after the reveal and
     * paints the preview, which looks exactly like the watcher working.
     * Measured: with no settle here the test passed with the watcher deleted.
     *
     * A fixed wait is used deliberately. The condition to wait for is "nothing
     * happened", and there is no event for that; the value is several times the
     * debounce plus a slow local round trip.
     */
    await page.waitForTimeout( 4000 );

    await expect(
      page.locator( '[data-optionia-preview]' ),
      'no identifiable image means no overlay, which is the fail-closed half'
    ).toHaveCount( 0 );

    await page.evaluate( () => {
      const gallery = document.querySelector< HTMLElement >( '[data-hidden-by-test]' );

      if ( gallery ) {
        gallery.style.display = '';
      }
    } );

    /*
     * 🔴 **Nothing further is clicked.** The redraw must come from watching the
     * document, because a customer who has already chosen their options has no
     * reason to touch them again.
     */
    await expect(
      page.locator( '[data-optionia-preview] svg' ),
      'the design must appear once the gallery exists'
    ).toBeVisible( { timeout: 15000 } );
  } );
} );
