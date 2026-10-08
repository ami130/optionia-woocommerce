import { expect, test } from '@playwright/test';

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
    await page.goto( STOREFRONT + '/?post_type=product', { waitUntil: 'domcontentloaded' } );

    /*
     * ⚠️ **The fail-closed half.** An archive shows many products and none is
     * "the" product, so there is nothing to anchor on and nothing is drawn.
     */
    expect( await page.locator( '[data-optionia="options"]' ).count() ).toBe( 0 );
  } );
} );
