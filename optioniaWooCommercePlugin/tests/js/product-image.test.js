import { describe, expect, it } from 'vitest';

import { loadStorefront } from './harness.js';

/**
 * Finding the product's own image (M26e.2), branch by branch.
 *
 * ## Why these exist alongside the browser tests
 *
 * 🔴 **The browser tests prove this against ONE real theme.** They are the only
 * honest proof that the rule holds on markup nobody here wrote — and they are
 * also slow, need WordPress, the API and the dashboard running, and cannot run
 * in CI. What they cannot do is exercise the rejection branches: a stock
 * Storefront page happens to contain a related tile and a pagination thumbnail,
 * so two of the four paths are covered and two are not.
 *
 * 📌 **These load the REAL `frontend.js`** through the same harness every other
 * suite uses, so they test the shipped code rather than a description of it.
 */

/** A product page: a gallery image, inside the wrapper that holds the options. */
function page(inner) {
  return `
    <div class="product post-14">
      ${inner}
      <div data-optionia="options" data-optionia-product="14"></div>
    </div>
  `;
}

/** Give an element a measurable box; jsdom reports zero for everything. */
function size(element, width, height) {
  element.getBoundingClientRect = () => ({
    width,
    height,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
  });
}

async function finder(html) {
  const loaded = await loadStorefront(page(html), { debug: true });

  return {
    ...loaded,
    find: () => loaded.window.optioniaTest.productImage(loaded.root),
  };
}

describe('productImage', () => {
  it('finds the gallery image', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <div class="woocommerce-product-gallery__image"><img src="shirt.png"></div>
       </div>`,
    );

    size(document.querySelector('img'), 400, 400);

    expect(find()?.getAttribute('src')).toBe('shirt.png');
  });

  /**
   * 🔴 **The founding case.** A related tile sits INSIDE the viewed product's
   * own `post-14` wrapper on a real page, so the wrapper is not a filter.
   */
  it('refuses a related product’s tile, even when it is larger', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <div class="woocommerce-product-gallery__image"><img src="ours.png"></div>
       </div>
       <section class="related">
         <ul class="products"><li class="post-27"><img src="theirs.png"></li></ul>
       </section>`,
    );

    size(document.querySelector('img[src="ours.png"]'), 300, 300);
    /* Deliberately bigger, so a largest-image rule would choose wrong. */
    size(document.querySelector('img[src="theirs.png"]'), 900, 900);

    expect(find()?.getAttribute('src')).toBe('ours.png');
  });

  it('refuses an upsell tile', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <div class="woocommerce-product-gallery__image"><img src="ours.png"></div>
       </div>
       <section class="up-sells"><img src="upsell.png"></section>`,
    );

    size(document.querySelector('img[src="ours.png"]'), 300, 300);
    size(document.querySelector('img[src="upsell.png"]'), 900, 900);

    expect(find()?.getAttribute('src')).toBe('ours.png');
  });

  it('refuses a prev/next pagination thumbnail', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <div class="woocommerce-product-gallery__image"><img src="ours.png"></div>
       </div>
       <nav class="storefront-product-pagination"><a href="/product/other/"><img src="next.png"></a></nav>`,
    );

    size(document.querySelector('img[src="ours.png"]'), 300, 300);
    size(document.querySelector('img[src="next.png"]'), 900, 900);

    expect(find()?.getAttribute('src')).toBe('ours.png');
  });

  /**
   * ⚠️ **A nested `post-<id>` that is not ours.** This branch has never been
   * exercised by a browser test: the project's own page nests its loop items
   * inside `.related`, so the container check catches them first and this one
   * never runs.
   */
  it('refuses an image owned by a different product id', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <div class="woocommerce-product-gallery__image"><img src="ours.png"></div>
       </div>
       <div class="post-99"><img src="other-product.png"></div>`,
    );

    size(document.querySelector('img[src="ours.png"]'), 300, 300);
    size(document.querySelector('img[src="other-product.png"]'), 900, 900);

    expect(find()?.getAttribute('src')).toBe('ours.png');
  });

  /**
   * ⚠️ **A lightbox link is OURS.** It points at the full-size image file, not
   * at another page — the one case where a link around the image must not
   * disqualify it. Also untouched by the browser tests.
   */
  it('accepts an image wrapped in its own lightbox link', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <div class="woocommerce-product-gallery__image">
           <a href="/uploads/shirt-full.jpg"><img src="shirt.png"></a>
         </div>
       </div>`,
    );

    size(document.querySelector('img'), 400, 400);

    expect(find()?.getAttribute('src')).toBe('shirt.png');
  });

  it('refuses an image linking to another page', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <a href="/product/something-else/"><img src="elsewhere.png"></a>
       </div>`,
    );

    size(document.querySelector('img'), 400, 400);

    expect(find()).toBeNull();
  });

  /**
   * 🔴 **Null is a correct answer**, and the one that keeps a design off the
   * wrong product.
   */
  it('finds nothing when the block names no product', async () => {
    const loaded = await loadStorefront(
      `<div class="product post-14">
         <div class="woocommerce-product-gallery"><img src="shirt.png"></div>
         <div data-optionia="options"></div>
       </div>`,
      { debug: true },
    );

    size(loaded.document.querySelector('img'), 400, 400);

    expect(loaded.window.optioniaTest.productImage(loaded.root)).toBeNull();
  });

  it('finds nothing when no wrapper matches the product id', async () => {
    const loaded = await loadStorefront(
      `<div class="product post-77">
         <div class="woocommerce-product-gallery"><img src="shirt.png"></div>
         <div data-optionia="options" data-optionia-product="14"></div>
       </div>`,
      { debug: true },
    );

    size(loaded.document.querySelector('img'), 400, 400);

    expect(loaded.window.optioniaTest.productImage(loaded.root)).toBeNull();
  });

  /**
   * ⚠️ **A zero-area image is not drawable.** A gallery's hidden slides and a
   * lazy placeholder both report no box, and overlaying one puts the design
   * where nobody can see it.
   */
  it('finds nothing when every candidate has no area', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery"><img src="hidden.png"></div>`,
    );

    /*
     * 🔴 **Given an explicit ZERO box, not left to jsdom's default.** Every
     * element in jsdom reports no size, so a test that simply omits the box
     * passes whether the guard exists or not: `best` is never assigned and the
     * function returns null either way. Measured — removing
     * `bestArea > 0 ? best : null` left this green until the box was stated.
     */
    size(document.querySelector('img'), 0, 0);

    expect(find()).toBeNull();
  });

  /**
   * ⚠️ **A sized image beside a zero-sized one.** This is what the guard is
   * really for: the hidden slide must lose to the visible one rather than being
   * picked because it came first.
   */
  it('skips a zero-area slide in favour of the visible one', async () => {
    const { document, find } = await finder(
      `<div class="woocommerce-product-gallery">
         <div class="woocommerce-product-gallery__image"><img src="hidden.png"></div>
         <div class="woocommerce-product-gallery__image"><img src="shown.png"></div>
       </div>`,
    );

    size(document.querySelector('img[src="hidden.png"]'), 0, 0);
    size(document.querySelector('img[src="shown.png"]'), 400, 400);

    expect(find()?.getAttribute('src')).toBe('shown.png');
  });
});

describe('the test surface', () => {
  /**
   * 🔴 **It must not exist on a real storefront.** `SCRIPT_DEBUG` is false on
   * every production install, and this asserts the runtime honours that rather
   * than trusting the flag is passed.
   */
  it('is absent unless SCRIPT_DEBUG is on', async () => {
    const loaded = await loadStorefront(page('<img src="shirt.png">'));

    expect(loaded.window.optioniaTest).toBeUndefined();
  });
});

/**
 * One page, several options blocks (M26e.4).
 *
 * 🔴 **The preview host moved into the theme's gallery**, which is shared. Until
 * this was fixed every block found the same host by a document-wide selector,
 * and the debounce timer and staleness token were single module-level
 * variables — so a second block cancelled the first's pending draw, invalidated
 * its in-flight response, and overwrote its artwork. Measured on a real page by
 * cloning the block: two blocks, one host.
 */
describe('several options blocks on one page', () => {
  /** Two products, each with its own wrapper, gallery and options block. */
  const TWO_BLOCKS = `
    <div class="product post-14">
      <div class="woocommerce-product-gallery">
        <div class="woocommerce-product-gallery__image"><img src="first.png"></div>
      </div>
      <div data-optionia="options" data-optionia-product="14"></div>
    </div>
    <div class="product post-20">
      <div class="woocommerce-product-gallery">
        <div class="woocommerce-product-gallery__image"><img src="second.png"></div>
      </div>
      <div data-optionia="options" data-optionia-product="20"></div>
    </div>
  `;

  it('gives each block its own image', async () => {
    const loaded = await loadStorefront(TWO_BLOCKS, { debug: true });
    const blocks = loaded.document.querySelectorAll('[data-optionia="options"]');

    size(loaded.document.querySelector('img[src="first.png"]'), 400, 400);
    size(loaded.document.querySelector('img[src="second.png"]'), 400, 400);

    const found = [...blocks].map((block) =>
      loaded.window.optioniaTest.productImage(block)?.getAttribute('src'),
    );

    /*
     * ⚠️ **Different answers, in order.** A document-wide lookup would hand
     * both blocks whichever image came first.
     */
    expect(found).toEqual(['first.png', 'second.png']);
  });

  it('never lets one block’s image belong to the other', async () => {
    const loaded = await loadStorefront(TWO_BLOCKS, { debug: true });
    const blocks = loaded.document.querySelectorAll('[data-optionia="options"]');

    size(loaded.document.querySelector('img[src="first.png"]'), 400, 400);
    /* The second product's image is far larger, so a page-wide rule picks it. */
    size(loaded.document.querySelector('img[src="second.png"]'), 1200, 1200);

    expect(loaded.window.optioniaTest.productImage(blocks[0])?.getAttribute('src')).toBe(
      'first.png',
    );
  });
});

describe('each block owns its own preview host', () => {
  const TWO = `
    <div class="product post-14">
      <div class="woocommerce-product-gallery">
        <div class="woocommerce-product-gallery__image"><img src="first.png"></div>
      </div>
      <div data-optionia="options" data-optionia-product="14"></div>
    </div>
    <div class="product post-20">
      <div class="woocommerce-product-gallery">
        <div class="woocommerce-product-gallery__image"><img src="second.png"></div>
      </div>
      <div data-optionia="options" data-optionia-product="20"></div>
    </div>
  `;

  /**
   * 🔴 **Two hosts, each in its own gallery.** Before M26e.4 both blocks found
   * the same element through `document.querySelector('[data-optionia-preview]')`
   * and painted over one another.
   */
  it('creates a separate host per block', async () => {
    const loaded = await loadStorefront(TWO, { debug: true });
    const blocks = loaded.document.querySelectorAll('[data-optionia="options"]');

    size(loaded.document.querySelector('img[src="first.png"]'), 400, 400);
    size(loaded.document.querySelector('img[src="second.png"]'), 400, 400);

    const first = loaded.window.optioniaTest.previewHost(blocks[0]);
    const second = loaded.window.optioniaTest.previewHost(blocks[1]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);

    /* Each host sits beside the image it belongs to. */
    expect(first.parentElement.querySelector('img').getAttribute('src')).toBe('first.png');
    expect(second.parentElement.querySelector('img').getAttribute('src')).toBe('second.png');
  });

  /** ⚠️ **Asking twice returns the same host**, rather than stacking a second. */
  it('reuses a block’s host instead of creating another', async () => {
    const loaded = await loadStorefront(TWO, { debug: true });
    const block = loaded.document.querySelector('[data-optionia="options"]');

    size(loaded.document.querySelector('img[src="first.png"]'), 400, 400);

    const once = loaded.window.optioniaTest.previewHost(block);
    const twice = loaded.window.optioniaTest.previewHost(block);

    expect(twice).toBe(once);
    expect(loaded.document.querySelectorAll('[data-optionia-preview]').length).toBe(1);
  });
});

/**
 * Why the host key is the product id and not the block's position.
 *
 * 🔴 **The index fallback is not equivalent to the id.** Removing the id branch
 * leaves `block-0`, `block-1`, … which also separates two blocks — so every
 * test above passes either way. What it cannot survive is the gallery being
 * SHARED: two blocks for the same product then get two hosts fighting over one
 * image, where the id correctly gives them one.
 */
describe('the host key', () => {
  it('is shared by two blocks describing the same product', async () => {
    const loaded = await loadStorefront(
      `<div class="product post-14">
         <div class="woocommerce-product-gallery">
           <div class="woocommerce-product-gallery__image"><img src="shirt.png"></div>
         </div>
         <div data-optionia="options" data-optionia-product="14"></div>
         <div data-optionia="options" data-optionia-product="14"></div>
       </div>`,
      { debug: true },
    );

    size(loaded.document.querySelector('img'), 400, 400);

    const blocks = loaded.document.querySelectorAll('[data-optionia="options"]');
    const first = loaded.window.optioniaTest.previewHost(blocks[0]);
    const second = loaded.window.optioniaTest.previewHost(blocks[1]);

    /*
     * ⚠️ **One picture, one overlay.** Both blocks describe the same product,
     * so they must agree on the host rather than each building their own on
     * top of the other.
     */
    expect(second).toBe(first);
    expect(loaded.document.querySelectorAll('[data-optionia-preview]').length).toBe(1);
  });
});

/**
 * The merchant's selector hint (M26e.2).
 *
 * 🔴 **The milestone asks for "a merchant-configurable selector override,
 * filtered through the same exclusion rules"** — and the second half is the
 * part that matters. A theme that renames WooCommerce's gallery markup
 * otherwise gets no overlay and no way to say where its image is; a selector
 * that could also point at a related product would turn "never draw on the
 * wrong product" from a rule into a suggestion.
 */
describe('the merchant selector hint', () => {
  const RENAMED_THEME = `
    <div class="product post-14">
      <div class="my-custom-gallery">
        <div class="slide"><img src="theirs.png"></div>
      </div>
      <section class="related">
        <ul class="products"><li class="post-27"><img src="related.png"></li></ul>
      </section>
      <div data-optionia="options" data-optionia-product="14"></div>
    </div>
  `;

  /**
   * ✏️ **This test was first named "finds nothing on a renamed gallery" and
   * its assertion said the opposite.** Probed rather than guessed: the image
   * IS found. Exclusion rejects what is positively FOREIGN — a related
   * container, another product's `post-<id>`, a link off the page — and a
   * renamed gallery is none of those, merely unrecognised. The name was wrong,
   * not the behaviour.
   *
   * 📌 **So the hint is for a narrower case than it first appears**: a theme
   * that puts its image somewhere this cannot see at all, or outside the
   * product wrapper entirely.
   */
  it('still finds an image in a renamed gallery inside the wrapper', async () => {
    const loaded = await loadStorefront(RENAMED_THEME, { debug: true });

    size(loaded.document.querySelector('img[src="theirs.png"]'), 400, 400);

    expect(loaded.window.optioniaTest.productImage(loaded.root)?.getAttribute('src')).toBe(
      'theirs.png',
    );
  });

  /**
   * 🔴 **The case the hint actually serves: an image OUTSIDE the wrapper.**
   * Some themes render the gallery in a sibling column rather than inside the
   * product container, and `wrapper.querySelectorAll` cannot reach it.
   */
  it('reaches an image the wrapper does not contain', async () => {
    const outside = `
      <div class="site-gallery"><img src="outside.png"></div>
      <div class="product post-14">
        <div data-optionia="options" data-optionia-product="14"></div>
      </div>
    `;

    const without = await loadStorefront(outside, { debug: true });

    size(without.document.querySelector('img[src="outside.png"]'), 400, 400);

    expect(
      without.window.optioniaTest.productImage(without.root),
      'unreachable without a hint'
    ).toBeNull();

    const withHint = await loadStorefront(outside, {
      debug: true,
      imageSelector: '.site-gallery img',
    });

    size(withHint.document.querySelector('img[src="outside.png"]'), 400, 400);

    expect(
      withHint.window.optioniaTest.productImage(withHint.root)?.getAttribute('src')
    ).toBe('outside.png');
  });

  it('accepts an image a merchant points at', async () => {
    const loaded = await loadStorefront(RENAMED_THEME, {
      debug: true,
      imageSelector: '.my-custom-gallery img',
    });

    size(loaded.document.querySelector('img[src="theirs.png"]'), 400, 400);

    expect(loaded.window.optioniaTest.productImage(loaded.root)?.getAttribute('src')).toBe(
      'theirs.png',
    );
  });

  /**
   * 🔴 **The rule a filter may not switch off.** A merchant pointing at a
   * related tile gets no overlay, not somebody else's product.
   */
  it('still refuses a related tile the selector names', async () => {
    const loaded = await loadStorefront(RENAMED_THEME, {
      debug: true,
      imageSelector: '.related img',
    });

    /* Only the related tile has area, so a bypass would select it. */
    size(loaded.document.querySelector('img[src="related.png"]'), 900, 900);

    expect(loaded.window.optioniaTest.productImage(loaded.root)).toBeNull();
  });

  /** ⚠️ **A typo in a merchant's filter must not take the runtime down.** */
  it('ignores a selector that is not valid CSS', async () => {
    const loaded = await loadStorefront(RENAMED_THEME, {
      debug: true,
      imageSelector: ':::not a selector:::',
    });

    size(loaded.document.querySelector('img[src="theirs.png"]'), 400, 400);

    expect(() => loaded.window.optioniaTest.productImage(loaded.root)).not.toThrow();
  });
});
