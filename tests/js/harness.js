import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The real storefront runtime, read once. */
const SOURCE = readFileSync(resolve(HERE, '../../assets/js/frontend.js'), 'utf8');

/**
 * Default currency, matching what `Assets.php` localises.
 *
 * Overridable per test so a store with different conventions — a comma decimal
 * separator, a symbol that follows the amount — can be driven without rewriting
 * the fixture.
 */
const DEFAULT_CURRENCY = {
  symbol: '£',
  decimals: 2,
  decimal: '.',
  thousand: ',',
  format: '%1$s%2$s',
};

/**
 * Load the storefront runtime against a fragment of markup.
 *
 * 🔴 **The real file, evaluated unmodified.**
 *
 * `frontend.js` is an IIFE under `'use strict'` that exports nothing —
 * measured: loading it exposes **zero** functions to the outside. Earlier
 * throwaway harnesses worked around that by slicing functions out of the source
 * with string indexes, which tests a *copy* of the code and breaks whenever a
 * line moves.
 *
 * So these tests are black-box: markup in, events dispatched, DOM asserted. The
 * only thing they know about the implementation is the `data-optionia` contract
 * the templates also use — which `frontend-contract.test.js` pins separately.
 *
 * ⚠️ **The document must be `complete` before the file is evaluated.**
 *
 * `init()` runs on load, and the file guards it with
 * `if ( 'loading' === document.readyState )` → `DOMContentLoaded`. jsdom reports
 * `loading` for a fragment it has already parsed and never fires that event, so
 * evaluating too early leaves **nothing bound** — the estimate stays empty and
 * the failure looks exactly like a product bug. Measured, and the cause of a
 * false failure while this harness was being written.
 *
 * @param {string} html Markup placed inside `<body>`.
 * @param {object} [options]
 * @param {object} [options.currency] Overrides for `optioniaSettings.currency`.
 * @param {boolean} [options.settings] Set false to omit `optioniaSettings` entirely.
 * @param {boolean} [options.segmenter] Set false to simulate a browser without `Intl.Segmenter`.
 * @param {object|false} [options.upload] Overrides for `optioniaSettings.upload`; false omits it.
 * @return {Promise<{window: Window, document: Document, root: Element|null, uploads: object}>}
 */
export async function loadStorefront(html, options = {}) {
  const { JSDOM } = await import('jsdom');

  const dom = new JSDOM(`<body>${html}</body>`, {
    runScripts: 'outside-only',
    url: 'https://store.test/product/1',
  });

  await new Promise((done) => {
    if (dom.window.document.readyState === 'complete') {
      done();

      return;
    }

    dom.window.addEventListener('load', done);
  });

  /*
   * ⚠️ **Removed *before* the file is evaluated**, because `measure()` reads
   * `Intl.Segmenter` at call time but a test that deletes it afterwards would
   * still be testing whatever the first call captured. Deleting it here is what
   * an older Safari actually presents to the script.
   */
  if (options.segmenter === false) {
    delete dom.window.Intl.Segmenter;
  }

  if (options.settings !== false) {
    dom.window.optioniaSettings = {
      currency: { ...DEFAULT_CURRENCY, ...(options.currency ?? {}) },
    };

    if (options.upload !== false) {
      dom.window.optioniaSettings.upload = {
        url: 'https://store.test/wp-json/optionia/v1/upload',
        nonce: 'test-nonce',
        maxBytes: 2097152,
        ...(options.upload ?? {}),
      };
    }
  }

  /*
   * A controllable `XMLHttpRequest`.
   *
   * 🔴 **jsdom has a real one, and a real one would try to reach the network.**
   * The upload runtime is the first thing in this project that makes a request
   * at all, so nothing here could stub it before.
   *
   * Deliberately *manual*: `uploads.respond()` is called by the test when it
   * chooses, so a test can assert what the page looks like **while an upload is
   * in flight** — which is where the add-to-cart race lives, and the one state
   * an auto-responding stub can never show.
   */
  const uploads = {
    sent: [],

    /** Finish the most recent request. */
    respond(status, body) {
      const request = uploads.sent[uploads.sent.length - 1];

      request.status = status;
      request.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      request.onload?.();
    },

    /** Fail the most recent request the way a dropped connection does. */
    fail() {
      uploads.sent[uploads.sent.length - 1].onerror?.();
    },

    /** Report progress on the most recent request. */
    progress(loaded, total) {
      uploads.sent[uploads.sent.length - 1].upload.onprogress?.({
        lengthComputable: true,
        loaded,
        total,
      });
    },
  };

  dom.window.XMLHttpRequest = function FakeXhr() {
    this.upload = {};
    this.status = 0;
    this.responseText = '';
    this.headers = {};

    this.open = (method, url) => {
      this.method = method;
      this.url = url;
    };

    this.setRequestHeader = (name, value) => {
      this.headers[name] = value;
    };

    this.send = (payload) => {
      this.payload = payload;
      uploads.sent.push(this);
    };

    this.abort = () => this.onabort?.();
  };

  /*
   * jsdom implements `FormData`, but `append`ing a `File` and reading it back is
   * awkward; the tests only need to know *what* was appended.
   */
  dom.window.FormData = function FakeFormData() {
    this.entries = [];
    this.append = (name, value) => this.entries.push([name, value]);
    this.get = (name) => (this.entries.find((e) => e[0] === name) ?? [])[1];
  };

  dom.window.eval(SOURCE);

  return {
    window: dom.window,
    document: dom.window.document,
    uploads,
    root: dom.window.document.querySelector('[data-optionia="options"]'),
  };
}

/**
 * Re-run the runtime against a window it has already bound.
 *
 * 🔴 **The only way to exercise the double-bind guard.**
 *
 * `init()` is not reachable from outside, and nothing in the product re-runs it
 * *yet* — `found_variation` and a page builder injecting a block after load both
 * will. Evaluating the source a second time is what those callers will do to the
 * page, so it is what a test has to do to see the guard work.
 *
 * Counts listener registrations on the options block, because that is the
 * damage: `bind()`'s own comment says a doubled `change` listener *"does not
 * look broken -- it just totals wrong"*.
 *
 * @param {Window} window A window already returned by `loadStorefront`.
 * @return {number} Listeners added to the options block by the second run.
 */
export function rebind(window) {
  const root = window.document.querySelector('[data-optionia="options"]');

  if (!root) {
    return 0;
  }

  let added = 0;
  const original = root.addEventListener.bind(root);

  root.addEventListener = (...args) => {
    added += 1;

    return original(...args);
  };

  window.eval(SOURCE);

  return added;
}

/**
 * Fire a real event, the way a browser would.
 *
 * `bubbles: true` because every listener is delegated from the options block —
 * an event that does not bubble reaches nothing, and a test using one would
 * pass only because it never exercised the handler.
 *
 * @param {Window} window The jsdom window.
 * @param {Element} target Element to dispatch on.
 * @param {string} type Event type, e.g. 'change' or 'input'.
 */
export function fire(window, target, type) {
  target.dispatchEvent(new window.Event(type, { bubbles: true }));
}

/**
 * A priced `<option>` for a dropdown fixture.
 *
 * @param {string} key Value key.
 * @param {string} label Visible label.
 * @param {?number} minor Price in minor units, or null for an unpriced value.
 * @param {string} [type] Price type.
 */
export function pricedOption(key, label, minor, type = 'fixed') {
  const price = minor === null ? '' : ` data-optionia-price="${minor}"`;

  return `<option value="${key}" data-optionia-price-type="${type}"${price}>${label}</option>`;
}

/**
 * The estimate element's state, as a customer would perceive it.
 *
 * @param {Document} document The jsdom document.
 * @return {{visible: boolean, text: string}}
 */
export function estimate(document) {
  const node = document.querySelector('[data-optionia="estimate"]');

  return { visible: node ? !node.hidden : false, text: node ? node.textContent : '' };
}
