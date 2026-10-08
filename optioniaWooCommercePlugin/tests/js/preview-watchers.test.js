import { describe, expect, it } from 'vitest';

import { loadStorefront } from './harness.js';

/**
 * The observers that keep the preview on the product image (M26e.3, M26e.4).
 *
 * ## Why these are unit tests and not only browser tests
 *
 * 🔴 **Observer LIFECYCLE is invisible from outside.** A browser test can show
 * that the preview comes back after a swap; it cannot show that one observer
 * was replaced rather than a second one added. The difference does not change
 * what a customer sees until a theme re-renders the gallery repeatedly, and
 * then it degrades a page nobody can reproduce on demand.
 *
 * 📌 **jsdom has a real `MutationObserver`**, so these drive the shipped
 * `watchGallery` rather than a description of it.
 */

/** A product page whose gallery holds one image. */
const PAGE = `
  <div class="product post-14">
    <div class="woocommerce-product-gallery">
      <div class="woocommerce-product-gallery__image"><img src="shirt.png"></div>
    </div>
    <div data-optionia="options" data-optionia-product="14"></div>
  </div>
`;

/** jsdom reports no box for anything; the finder skips zero-area images. */
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

async function storefront(html = PAGE) {
  const loaded = await loadStorefront(html, { debug: true });

  loaded.document.querySelectorAll('img').forEach((image) => size(image, 400, 400));

  return loaded;
}

describe('watchGallery', () => {
  /**
   * 🔴 **One observer per block, replaced rather than stacked.** `watchForGallery`
   * calls back into `watchGallery` once a gallery appears, so a gallery that comes
   * and goes would otherwise bind a second, third, fourth — each running the whole
   * image scan on every mutation.
   */
  it('replaces its observer instead of adding another', async () => {
    const { window, root } = await storefront();
    const state = window.optioniaTest.stateFor(root);

    window.optioniaTest.watchGallery(root);

    const first = state.observer;

    expect(first, 'an observer should be bound').toBeTruthy();

    /*
     * 🔴 **The OLD observer must be disconnected, not merely replaced.** An
     * earlier version of this test compared references, which changes whether
     * or not `disconnect()` was called — so deleting the disconnect left it
     * green. Counting deliveries is what actually distinguishes them.
     */
    let delivered = 0;
    const realDisconnect = first.disconnect.bind(first);

    first.disconnect = () => {
      delivered += 1;

      return realDisconnect();
    };

    window.optioniaTest.watchGallery(root);

    const second = state.observer;

    expect(second, 'a second call should still leave one observer').toBeTruthy();
    expect(second, 'and it should not be the one already running').not.toBe(first);
    expect(delivered, 'the observer it replaced must have been disconnected').toBe(1);
  });

  /**
   * ⚠️ **Each block keeps its own.** The state is a `WeakMap` keyed by the
   * options root, so two blocks must not share one observer — the shape that
   * made two blocks fight over a single preview host before M26e.4.
   */
  it('keeps one observer per block', async () => {
    const { window, document } = await storefront(`
      <div class="product post-14">
        <div class="woocommerce-product-gallery">
          <div class="woocommerce-product-gallery__image"><img src="a.png"></div>
        </div>
        <div data-optionia="options" data-optionia-product="14"></div>
      </div>
      <div class="product post-20">
        <div class="woocommerce-product-gallery">
          <div class="woocommerce-product-gallery__image"><img src="b.png"></div>
        </div>
        <div data-optionia="options" data-optionia-product="20"></div>
      </div>
    `);

    const blocks = document.querySelectorAll('[data-optionia="options"]');

    window.optioniaTest.watchGallery(blocks[0]);
    window.optioniaTest.watchGallery(blocks[1]);

    const first = window.optioniaTest.stateFor(blocks[0]).observer;
    const second = window.optioniaTest.stateFor(blocks[1]).observer;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  /**
   * ⚠️ **No image means no gallery observer**, and the late-gallery watcher
   * takes over instead — the path that fixed a preview never being drawn at all
   * when the gallery arrived after first paint.
   */
  it('waits for a gallery that is not there yet', async () => {
    const loaded = await loadStorefront(
      `<div class="product post-14">
         <div data-optionia="options" data-optionia-product="14"></div>
       </div>`,
      { debug: true },
    );

    loaded.window.optioniaTest.watchGallery(loaded.root);

    const state = loaded.window.optioniaTest.stateFor(loaded.root);

    expect(state.observer, 'nothing to observe yet').toBeFalsy();
    expect(state.waiting, 'but it must be waiting for one').toBeTruthy();
  });

  /**
   * 🔴 **The waiting observer stops once it has done its job.** It watches the
   * whole document, so leaving it running would mean every DOM change on the
   * page re-running the image scan for the life of the visit.
   */
  it('stops waiting once a gallery appears', async () => {
    const loaded = await loadStorefront(
      `<div class="product post-14">
         <div data-optionia="options" data-optionia-product="14"></div>
       </div>`,
      { debug: true },
    );

    loaded.window.optioniaTest.watchGallery(loaded.root);

    const state = loaded.window.optioniaTest.stateFor(loaded.root);

    expect(state.waiting).toBeTruthy();

    const gallery = loaded.document.createElement('div');

    gallery.className = 'woocommerce-product-gallery';
    gallery.innerHTML = '<div class="woocommerce-product-gallery__image"><img src="late.png"></div>';
    loaded.document.querySelector('.post-14').appendChild(gallery);
    size(gallery.querySelector('img'), 400, 400);

    /* `MutationObserver` callbacks are delivered as microtasks. */
    await new Promise((done) => setTimeout(done, 0));

    expect(state.waiting, 'it should have disconnected itself').toBeNull();
    expect(state.observer, 'and handed over to the gallery watcher').toBeTruthy();
  });
});
