/**
 * Whether a URL may become a layer.
 *
 * 🔴 **The design lab is where a merchant's URL becomes an `<img src>`, and
 * eventually an `<image href>` inside an SVG the server rasterises.** That makes
 * this a security boundary rather than a form nicety: a `javascript:` URL in an
 * attribute that later reaches a rendered document is an XSS vector, and `data:`
 * can carry SVG — which M15 already refuses on upload for exactly that reason.
 * Refusing both here keeps the design lab from becoming the hole in a rule the
 * rest of the system enforces.
 *
 * ⚠️ **Absolute http(s) only, matching the swatch rule the dashboard already
 * applies** (`imageUrl` in the option-set schema, which mirrors the API's
 * `require_protocol`). A relative URL resolves against the merchant's own
 * storefront, which is not where these images live — and the print pipeline
 * fetches them from a server with no such base.
 */

/**
 * Whether a URL points at a vector image.
 *
 * 🔴 **The one place this is decided**, used by the layer path and by the
 * product backdrop. Two copies of the test would be two rules that agree until
 * one is edited.
 *
 * 📌 **Judged on the PATH.** A query string may contain anything —
 * `?from=logo.svg` is not an SVG — and matching the whole URL would refuse
 * legitimate images. `.svgz` is the gzipped form of the same format.
 */
export function isVectorImage(url: string): boolean {
  return /\.svgz?$/i.test(url.split(/[?#]/)[0]);
}

/** Why a source was refused, for a message a merchant can act on. */
export type LayerSourceRefusal =
  | 'empty'
  | 'not-absolute'
  | 'unsupported-scheme'
  | 'vector-image'
  | 'too-long';

/**
 * The longest URL accepted.
 *
 * 📌 **500 matches `option_values.imageUrl`'s column.** A design pointing at a
 * URL the rest of the model could not store would save here and fail there.
 */
export const MAX_SOURCE_LENGTH = 500;

export interface LayerSourceCheck {
  ok: boolean;
  /** The trimmed URL, when accepted. */
  url: string;
  reason?: LayerSourceRefusal;
}

/**
 * Check a merchant-entered image URL.
 *
 * 📌 **Order matters in the refusals**, because the message a merchant sees
 * should name the first thing wrong rather than an incidental consequence: an
 * empty box is not "not a URL", and a `javascript:` URL is refused for its
 * scheme rather than for failing an http test.
 */
export function checkLayerSource(raw: string): LayerSourceCheck {
  const url = raw.trim();

  if (url === '') {
    return { ok: false, url, reason: 'empty' };
  }

  if (url.length > MAX_SOURCE_LENGTH) {
    return { ok: false, url, reason: 'too-long' };
  }

  /*
   * ⚠️ **Scheme first, and tested on the LOWERCASED string.** `JavaScript:` and
   * `jAvAsCrIpT:` are the same scheme to a browser; a case-sensitive check is
   * the classic way this guard is bypassed.
   */
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();

  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    return { ok: false, url, reason: 'unsupported-scheme' };
  }

  if (!/^https?:\/\/\S+$/i.test(url)) {
    return { ok: false, url, reason: 'not-absolute' };
  }

  /*
   * 🔴 **SVG is refused, and M26d.5 states the rule: "a design lab is not a
   * reason to accept an XSS vector."** The scheme check above stops `data:` and
   * `javascript:`; it says nothing about what an `https:` URL serves, so
   * `https://cdn.example.com/evil.svg` passed every check.
   *
   * ⚠️ **This is not only a browser concern.** A layer's `src` becomes an
   * `<image href>` inside the SVG the SERVER rasterises (`design-scene.ts`), so
   * a nested SVG reaches a renderer rather than merely an `<img>` tag. M15
   * already refuses SVG on upload for the same reason.
   *
   * 📌 **Judged on the PATH, not the whole URL.** A query string may contain
   * anything — `?from=logo.svg` is not an SVG — and matching the raw URL would
   * refuse legitimate images. The fragment is dropped for the same reason.
   */
  if (isVectorImage(url)) {
    return { ok: false, url, reason: 'vector-image' };
  }

  return { ok: true, url };
}

/** A merchant-facing message for each refusal. */
export function layerSourceMessage(reason: LayerSourceRefusal): string {
  switch (reason) {
    case 'empty':
      return 'Enter an image URL.';
    case 'too-long':
      return `Keep the URL under ${MAX_SOURCE_LENGTH} characters.`;
    case 'unsupported-scheme':
      return 'Only http:// and https:// images can be used.';
    case 'vector-image':
      return 'SVG images cannot be used. Try a PNG, JPEG or WebP.';
    case 'not-absolute':
      return 'Enter a full URL starting http:// or https://.';
  }
}

/**
 * A readable layer name from a URL.
 *
 * 📌 **The filename, or a fallback.** A layer list showing three rows of
 * `https://cdn.example.com/a/b/c/...` is unreadable; the last path segment is
 * what a merchant recognises.
 */
export function layerNameFromUrl(url: string, fallback = 'Layer'): string {
  /*
   * ⚠️ Parsed by hand rather than with `new URL()`: this runs on a string that
   * has already passed `checkLayerSource`, and `URL` throws on input it does
   * not like — a name is not worth a crash.
   */
  const withoutQuery = url.split(/[?#]/)[0];
  /*
   * ⚠️ **The scheme is stripped first, and a test is why.** `'https://'` splits
   * to `['https:', '', '']`, and dropping the empties leaves `'https:'` — so a
   * URL with no path at all was named after its own protocol.
   */
  const withoutScheme = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const segment = withoutScheme.split('/').filter(Boolean).pop() ?? '';
  const decoded = safeDecode(segment);

  return decoded === '' ? fallback : decoded;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    /* A malformed escape is not a reason to fail; the raw segment will do. */
    return segment;
  }
}
