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

/**
 * How the overlay sits on the image (M26e.2, M26e.4).
 *
 * 🔴 **Written because mutation testing found every one of these unguarded.**
 * A 195-test green run survived deleting the positioned-ancestor promotion,
 * the click-through rule, the stale-host removal and the missing-frame guard.
 * Each was defensive code nothing exercised — and an audit nearly recorded
 * three of them as "cannot be tested here" before jsdom was asked.
 */
describe('positioning the overlay', () => {
  const PAGE = `
    <div class="product post-14">
      <div class="woocommerce-product-gallery">
        <div class="woocommerce-product-gallery__image"><img src="shirt.png"></div>
      </div>
      <div data-optionia="options" data-optionia-product="14"></div>
    </div>
  `;

  async function mounted(html = PAGE) {
    const loaded = await loadStorefront(html, { debug: true });

    loaded.document.querySelectorAll('img').forEach((image) => size(image, 400, 400));

    return loaded;
  }

  /**
   * 🔴 **An absolutely positioned child needs a positioned ancestor.** Without
   * this the overlay escapes the gallery and lands relative to the page, which
   * on a long product page puts the design somewhere near the header.
   *
   * 📌 **Unreachable on the project's own test theme**, which is why no browser
   * test covers it: Storefront's `woocommerce-product-gallery__image` is
   * already `relative` — measured. A theme that is not is exactly who this is
   * for.
   */
  it('promotes a static frame so the overlay can anchor to it', async () => {
    const { window, document, root } = await mounted();
    const frame = document.querySelector('.woocommerce-product-gallery__image');

    expect(
      window.getComputedStyle(frame).position,
      'the fixture must start static, or this proves nothing'
    ).toBe('static');

    window.optioniaTest.previewHost(root);

    expect(window.getComputedStyle(frame).position).toBe('relative');
  });

  /**
   * ⚠️ **A frame the theme already positioned is left alone.** Overwriting an
   * `absolute` or `sticky` gallery would move the theme's own layout.
   */
  it('leaves a frame the theme already positioned', async () => {
    const { window, document, root } = await mounted();
    const frame = document.querySelector('.woocommerce-product-gallery__image');

    frame.style.position = 'absolute';

    window.optioniaTest.previewHost(root);

    expect(window.getComputedStyle(frame).position).toBe('absolute');
  });

  /**
   * 🔴 **Clicks belong to the theme.** The gallery's lightbox and zoom are
   * features the merchant already had, and an overlay that swallowed their
   * clicks would break them while looking like it worked.
   */
  it('lets clicks through to the gallery beneath', async () => {
    const { window, root } = await mounted();
    const host = window.optioniaTest.previewHost(root);

    expect(window.getComputedStyle(host).pointerEvents).toBe('none');
  });

  /**
   * ⚠️ **A host left behind when the image moves is a second overlay.** The
   * stale one is removed rather than orphaned.
   */
  it('removes the old host when the image is replaced', async () => {
    const { window, document, root } = await mounted();

    window.optioniaTest.previewHost(root);

    expect(document.querySelectorAll('[data-optionia-preview]').length).toBe(1);

    /*
     * 🔴 **The image moves to a NEW frame; the old frame survives.** This is
     * the case the guard is for, and an earlier version of this test missed it:
     * replacing the whole frame takes the host away with it, so the removal
     * never ran and deleting it left the suite green. A gallery that reorders
     * its slides, or moves the active image into a zoom container, leaves the
     * old frame — and the old host — exactly where they were.
     */
    const gallery = document.querySelector('.woocommerce-product-gallery');
    const newFrame = document.createElement('div');

    newFrame.className = 'woocommerce-product-gallery__image';
    newFrame.innerHTML = '<img src="other.png">';
    gallery.appendChild(newFrame);

    /* The new image is larger, so the finder prefers it. */
    size(document.querySelector('img[src="shirt.png"]'), 100, 100);
    size(newFrame.querySelector('img'), 400, 400);

    window.optioniaTest.previewHost(root);

    expect(
      document.querySelectorAll('[data-optionia-preview]').length,
      'one overlay, not two — the stale host must be removed, not orphaned'
    ).toBe(1);
  });
});

/**
 * Where the picture is actually painted (M26e.2, the `object-fit` defect).
 *
 * 🔴 **M26c.1 lists this among four measured defects and says to fix it**
 * because it is visible rather than sub-pixel: an overlay sized to the `<img>`
 * element box sits partly on the letterbox bars that `object-fit: contain`
 * leaves, or extends past what `cover` clips.
 *
 * 📌 **Invisible on this project's own theme**, which is how it survived: the
 * test storefront paints `object-fit: fill` on a square image, so the element
 * box and the painted box coincide exactly. These cases are the ones a
 * different theme produces.
 */
describe('the painted box', () => {
  /** An element box of 400×200 holding a square 100×100 picture. */
  async function image(fit) {
    const loaded = await loadStorefront(
      `<div class="product post-14">
         <div class="woocommerce-product-gallery">
           <div class="woocommerce-product-gallery__image"><img src="square.png"></div>
         </div>
         <div data-optionia="options" data-optionia-product="14"></div>
       </div>`,
      { debug: true },
    );

    const element = loaded.document.querySelector('img');

    size(element, 400, 200);

    /*
     * ⚠️ **`offsetWidth` is what `paintBox` reads, and jsdom reports 0 for it
     * always.** `size()` above stubs `getBoundingClientRect`, which the image
     * FINDER uses — a different measurement on the same element. Stating only
     * one of them made every case here return a 0×0 box, which looked like a
     * defect in the code and was a gap in the fixture.
     */
    Object.defineProperty(element, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(element, 'offsetHeight', { value: 200, configurable: true });

    element.style.objectFit = fit;

    /* jsdom does not decode images; the intrinsic size is stated. */
    Object.defineProperty(element, 'naturalWidth', { value: 100, configurable: true });
    Object.defineProperty(element, 'naturalHeight', { value: 100, configurable: true });

    return { ...loaded, element };
  }

  it('fills the element box when object-fit is fill', async () => {
    const { window, element } = await image('fill');

    expect(window.optioniaTest.paintBox(element, window)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 200,
    });
  });

  /**
   * 🔴 **The case that makes the defect visible.** A square picture inside a
   * 400×200 box paints 200×200 centred, leaving 100px of empty space either
   * side. An overlay sized to the element box covers that emptiness too.
   */
  it('centres and letterboxes when object-fit is contain', async () => {
    const { window, element } = await image('contain');

    expect(window.optioniaTest.paintBox(element, window)).toEqual({
      left: 100,
      top: 0,
      width: 200,
      height: 200,
    });
  });

  /** ⚠️ **`cover` paints LARGER than the box and clips**, so the offsets are negative. */
  it('overflows and clips when object-fit is cover', async () => {
    const { window, element } = await image('cover');

    expect(window.optioniaTest.paintBox(element, window)).toEqual({
      left: 0,
      top: -100,
      width: 400,
      height: 400,
    });
  });

  it('paints at intrinsic size when object-fit is none', async () => {
    const { window, element } = await image('none');

    expect(window.optioniaTest.paintBox(element, window)).toEqual({
      left: 150,
      top: 50,
      width: 100,
      height: 100,
    });
  });

  /**
   * ⚠️ **An image that has not loaded reports 0×0**, and dividing by it would
   * give NaN and an overlay with no size. The element box stands in until the
   * picture arrives, at which point `trackSize` re-runs this.
   */
  it('falls back to the element box before the image has loaded', async () => {
    const { window, element } = await image('contain');

    Object.defineProperty(element, 'naturalWidth', { value: 0, configurable: true });
    Object.defineProperty(element, 'naturalHeight', { value: 0, configurable: true });

    expect(window.optioniaTest.paintBox(element, window)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 200,
    });
  });
});
