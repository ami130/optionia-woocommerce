import { describe, expect, it } from 'vitest';

import { fire, loadStorefront } from './harness.js';

/**
 * The upload runtime — the first thing in this project that makes a network
 * request (M15.2).
 *
 * 🔴 **The storefront was entirely offline until now.** `frontend.js` had zero
 * `fetch` and zero `XMLHttpRequest`: every control read markup and did
 * arithmetic. A file option cannot, because the file has to reach the server
 * *before* add-to-cart and come back as a token.
 *
 * That introduces states nothing here had before — in flight, failed, dropped
 * connection — and one race worth the whole file: a customer submitting while an
 * upload is still going.
 */
const page = (extra = '') => `
  <form class="cart" method="post">
    <div data-optionia="options">
      <div data-optionia="option" data-optionia-option="opt-f" data-optionia-upload="1" ${extra}>
        <input type="file" data-optionia="file">
        <p data-optionia="upload-status"></p>
        <input type="hidden" data-optionia="value" value="">
      </div>
    </div>
    <button type="submit">Add to cart</button>
  </form>`;

/** A `File` jsdom will accept from a `change` event. */
function chooseFile(window, input, { name = 'artwork.pdf', size = 1000 } = {}) {
  const file = { name, size, type: 'application/pdf' };

  Object.defineProperty(input, 'files', { value: [file], configurable: true });

  return file;
}

const statusOf = (document) =>
  document.querySelector('[data-optionia="upload-status"]').textContent;

const tokenOf = (document) => document.querySelector('[data-optionia="value"]').value;

describe('choosing a file', () => {
  it('sends it to the upload route with the nonce', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');

    expect(uploads.sent).toHaveLength(1);
    expect(uploads.sent[0].url).toContain('/optionia/v1/upload');
    expect(uploads.sent[0].headers['X-WP-Nonce']).toBe('test-nonce');
  });

  /**
   * ⚠️ **The option's id rides along**, because the server needs to know which
   * option the file belongs to — the same request cannot infer it from a token
   * that does not exist yet.
   */
  it('names the option the file belongs to', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');

    expect(uploads.sent[0].payload.get('option_id')).toBe('opt-f');
  });

  it('tells the customer it is uploading', async () => {
    const { window, document } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');

    expect(statusOf(document)).toContain('Uploading');
  });

  it('shows progress as a percentage', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.progress(500, 1000);

    expect(statusOf(document)).toContain('50%');
  });
});

describe('when the upload finishes', () => {
  it('writes the token into the hidden field', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(201, { token: 'abc123', name: 'artwork.pdf' });

    expect(tokenOf(document)).toBe('abc123');
  });

  /**
   * 🔴 **A path or a filename must never reach the hidden field.**
   *
   * AC4's rule applied to a file: the browser sends identifiers only. The token
   * is what the server recognises; a path would be a value the customer could
   * edit into someone else's file.
   */
  it('stores only the token, never the filename', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(201, { token: 'abc123', name: 'artwork.pdf' });

    expect(tokenOf(document)).not.toContain('artwork');
    expect(tokenOf(document)).not.toContain('/');
  });

  it('names the file for the customer', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(201, { token: 'abc123', name: 'artwork.pdf' });

    expect(statusOf(document)).toContain('artwork.pdf');
  });
});

describe('when the upload fails', () => {
  it('leaves no token behind', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(422, { stored: false });

    expect(tokenOf(document)).toBe('');
    expect(statusOf(document)).toContain('could not be uploaded');
  });

  /**
   * ⚠️ **A dropped connection fires `onerror`, never `onload`.**
   *
   * Without a handler the in-flight counter would never come back down and the
   * form would stay blocked forever — turning one flaky upload into a checkout
   * the customer cannot complete.
   */
  it('recovers from a dropped connection', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.fail();

    expect(statusOf(document)).toContain('could not be uploaded');

    // And the form is submittable again, rather than blocked forever.
    const form = document.querySelector('form');
    const blocked = !form.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(blocked).toBe(false);
  });

  /** A malformed body is a failure, not a crash. */
  it('survives a response that is not JSON', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(201, '<html>gateway error</html>');

    expect(tokenOf(document)).toBe('');
  });
});

describe('the add-to-cart race', () => {
  /**
   * 🔴 **The reason the in-flight counter exists.**
   *
   * A customer clicking *Add to cart* during a 30 MB upload has no token yet, so
   * the option posts empty and the server reports a missing required value — a
   * validation error for a file they *did* choose.
   */
  it('blocks a submit while an upload is in flight', async () => {
    const { window, document } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');

    const form = document.querySelector('form');
    const submitted = form.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(submitted).toBe(false);
    expect(statusOf(document)).toContain('wait');
  });

  it('allows the submit once the upload completes', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(201, { token: 'abc123', name: 'artwork.pdf' });

    const form = document.querySelector('form');
    const submitted = form.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(submitted).toBe(true);
  });

  it('does not block a form with no upload in flight', async () => {
    const { document, window } = await loadStorefront(page());
    const form = document.querySelector('form');

    expect(
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    ).toBe(true);
  });
});

describe('replacing or clearing a file', () => {
  /**
   * 🔴 **The old token must go the moment a new file is chosen.**
   *
   * Otherwise a customer who replaces their artwork can submit while the second
   * upload is in flight and attach the *first* file — the one they deliberately
   * replaced.
   */
  it('clears the previous token when a new file is chosen', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(201, { token: 'first', name: 'a.pdf' });
    expect(tokenOf(document)).toBe('first');

    chooseFile(window, input, { name: 'b.pdf' });
    fire(window, input, 'change');

    expect(tokenOf(document)).toBe('');
  });

  it('clears the token when the picker is emptied', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');
    uploads.respond(201, { token: 'abc123', name: 'a.pdf' });

    Object.defineProperty(input, 'files', { value: [], configurable: true });
    fire(window, input, 'change');

    expect(tokenOf(document)).toBe('');
    expect(statusOf(document)).toBe('');
  });
});

describe('size ceilings', () => {
  /**
   * ⚠️ **A courtesy, never a boundary.** Refusing before the upload saves the
   * customer's bandwidth; the server re-checks regardless, because a client-side
   * limit is one an attacker simply skips.
   */
  it('refuses a file over the host ceiling without sending it', async () => {
    const { window, document, uploads } = await loadStorefront(page());
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input, { size: 3000000 }); // host stub is 2 MB
    fire(window, input, 'change');

    expect(uploads.sent).toHaveLength(0);
    expect(statusOf(document)).toContain('could not be uploaded');
  });

  /**
   * 🔴 **The merchant's limit and the host's — the lower wins.**
   *
   * A document written against a generous host must not authorise an upload a
   * modest one truncates.
   */
  it('refuses a file over the option limit even when the host allows it', async () => {
    const { window, document, uploads } = await loadStorefront(
      page('data-optionia-max-mb="1"'),
    );
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input, { size: 1500000 }); // under 2 MB host, over 1 MB option
    fire(window, input, 'change');

    expect(uploads.sent).toHaveLength(0);
  });

  it('accepts a file within both limits', async () => {
    const { window, document, uploads } = await loadStorefront(
      page('data-optionia-max-mb="1"'),
    );
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input, { size: 500000 });
    fire(window, input, 'change');

    expect(uploads.sent).toHaveLength(1);
  });
});

describe('without upload settings', () => {
  /**
   * An older cached page, or a build with no file options, must leave the input
   * inert rather than posting somewhere invented.
   */
  it('sends nothing when the server provided no upload config', async () => {
    const { window, document, uploads } = await loadStorefront(page(), { upload: false });
    const input = document.querySelector('[data-optionia="file"]');

    chooseFile(window, input);
    fire(window, input, 'change');

    expect(uploads.sent).toHaveLength(0);
  });
});
