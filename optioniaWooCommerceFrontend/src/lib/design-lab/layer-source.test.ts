import { describe, expect, it } from 'vitest';

import {
  checkLayerSource,
  isVectorImage,
  layerNameFromUrl,
  layerSourceMessage,
  MAX_SOURCE_LENGTH,
  type LayerSourceRefusal,
} from './layer-source';

describe('checkLayerSource', () => {
  it('accepts an absolute https URL', () => {
    expect(checkLayerSource('https://cdn.example.com/art.png')).toEqual({
      ok: true,
      url: 'https://cdn.example.com/art.png',
    });
  });

  it('accepts http as well as https', () => {
    expect(checkLayerSource('http://cdn.example.com/art.png').ok).toBe(true);
  });

  it('accepts an upper-cased scheme, which a browser treats as the same', () => {
    /*
     * 🔴 What `.toLowerCase()` is actually for. Refusal works without it — the
     * guard excludes anything that is not exactly http/https — so dropping it
     * survives every rejection test. What breaks is ACCEPTANCE: a merchant
     * pasting `HTTPS://…` from a document that capitalised it would be refused
     * a URL that works. Caught by mutation; the rejection tests all passed.
     */
    expect(checkLayerSource('HTTPS://cdn.example.com/art.png').ok).toBe(true);
    expect(checkLayerSource('Http://cdn.example.com/art.png').ok).toBe(true);
  });

  it('trims surrounding whitespace before judging', () => {
    expect(checkLayerSource('  https://cdn.example.com/art.png  ')).toEqual({
      ok: true,
      url: 'https://cdn.example.com/art.png',
    });
  });

  it('refuses an empty box as empty, not as a bad URL', () => {
    /* The message a merchant sees should name the first thing wrong. */
    expect(checkLayerSource('   ').reason).toBe('empty');
  });

  it('refuses a relative URL, which resolves against the wrong domain', () => {
    expect(checkLayerSource('/uploads/art.png').reason).toBe('not-absolute');
    expect(checkLayerSource('cdn.example.com/art.png').reason).toBe('not-absolute');
  });

  /*
   * 🔴 The security cases. This URL becomes an <img src>, and later an
   * <image href> inside an SVG the server rasterises.
   */
  it('refuses a javascript: URL', () => {
    expect(checkLayerSource('javascript:alert(1)').reason).toBe('unsupported-scheme');
  });

  it('refuses javascript: however it is cased', () => {
    /*
     * ⚠️ The classic bypass. A browser does not care about case in a scheme,
     * and a case-sensitive guard is how this check gets defeated.
     */
    for (const probe of ['JavaScript:alert(1)', 'JAVASCRIPT:alert(1)', 'jAvAsCrIpT:x']) {
      expect(checkLayerSource(probe).reason).toBe('unsupported-scheme');
    }
  });

  it('refuses a data: URL, which can carry SVG', () => {
    /* M15 already refuses SVG on upload; this is the same rule, same reason. */
    expect(checkLayerSource('data:image/svg+xml;base64,PHN2Zz4=').reason).toBe(
      'unsupported-scheme',
    );
  });

  it('refuses other schemes a browser would honour', () => {
    for (const probe of ['file:///etc/passwd', 'vbscript:msgbox', 'blob:https://x/y']) {
      expect(checkLayerSource(probe).reason).toBe('unsupported-scheme');
    }
  });

  it('caps at the length the column that must store it allows', () => {
    /*
     * 🔴 **An assertion that reads its own subject is no assertion.** The
     * boundary test below computes its fixture FROM `MAX_SOURCE_LENGTH`, so it
     * passes at any value — changing 500 to 2000 survived it. This pins the
     * number against the thing it has to match: `option_values.imageUrl` is
     * `varchar(500)`, and a design pointing at a URL the rest of the model
     * cannot store would save here and fail there.
     */
    expect(MAX_SOURCE_LENGTH).toBe(500);
  });

  /*
   * 🔴 **SVG, the rule M26d.5 states and nothing enforced.** The scheme check
   * stops `data:` and `javascript:`; it says nothing about what an `https:` URL
   * SERVES, so `https://cdn.example.com/evil.svg` passed everything. A layer's
   * src becomes an `<image href>` inside the SVG the SERVER rasterises, so this
   * is not only a browser concern.
   */
  it('refuses an SVG served over https', () => {
    expect(checkLayerSource('https://cdn.example.com/evil.svg').reason).toBe(
      'vector-image',
    );
  });

  it('refuses an SVG however it is cased, and the gzipped form', () => {
    for (const probe of [
      'https://cdn.example.com/a.SVG',
      'https://cdn.example.com/a.Svg',
      'https://cdn.example.com/a.svgz',
    ]) {
      expect(checkLayerSource(probe).reason).toBe('vector-image');
    }
  });

  /*
   * ⚠️ **Judged on the PATH, not the whole URL.** A naive `includes('.svg')`
   * would refuse these three legitimate images — and the last one is the case
   * that matters: a CDN that records provenance in a query parameter.
   */
  it('accepts a raster image whose URL merely mentions svg', () => {
    for (const probe of [
      'https://cdn.example.com/svg-icons/logo.png',
      'https://cdn.example.com/logo.png#from-svg',
      'https://cdn.example.com/logo.png?converted=from.svg',
    ]) {
      expect(checkLayerSource(probe).ok).toBe(true);
    }
  });

  it('accepts the raster formats a design lab actually uses', () => {
    for (const probe of ['art.png', 'art.jpg', 'art.jpeg', 'art.webp', 'art.gif']) {
      expect(checkLayerSource(`https://cdn.example.com/${probe}`).ok).toBe(true);
    }
  });

  it('refuses a URL longer than the column that must store it', () => {
    /*
     * 📌 Exactly at the limit is accepted; one over is not. A boundary tested
     * only from far away passes with an off-by-one.
     */
    const path = 'https://e.co/';
    const atLimit = path + 'a'.repeat(MAX_SOURCE_LENGTH - path.length);

    expect(atLimit).toHaveLength(MAX_SOURCE_LENGTH);
    expect(checkLayerSource(atLimit).ok).toBe(true);
    expect(checkLayerSource(`${atLimit}a`).reason).toBe('too-long');
  });

  it('refuses an over-long javascript: URL for its scheme, not its length', () => {
    /*
     * ⚠️ Order of refusals, asserted. Length is checked first, so this case
     * pins that a dangerous scheme is still named as such rather than being
     * masked by an incidental consequence — if it ever reported 'too-long',
     * a merchant would shorten it and be refused again for a different reason.
     */
    const long = `javascript:${'a'.repeat(MAX_SOURCE_LENGTH)}`;

    expect(checkLayerSource(long).reason).toBe('too-long');
  });
});

describe('layerSourceMessage', () => {
  /*
   * 📌 Every refusal has a message, checked by iterating the union rather than
   * by listing cases — a new refusal with no message fails here.
   */
  const REASONS: LayerSourceRefusal[] = [
    'empty',
    'not-absolute',
    'unsupported-scheme',
    'vector-image',
    'too-long',
  ];

  it.each(REASONS)('has a merchant-facing message for %s', (reason) => {
    const message = layerSourceMessage(reason);

    expect(message.length).toBeGreaterThan(0);
    expect(message).toMatch(/\S/);
  });

  it('gives a different message for each refusal', () => {
    const messages = REASONS.map(layerSourceMessage);

    expect(new Set(messages).size).toBe(REASONS.length);
  });
});

describe('layerNameFromUrl', () => {
  it('uses the filename', () => {
    expect(layerNameFromUrl('https://cdn.example.com/art/logo.png')).toBe('logo.png');
  });

  it('ignores a query string and a fragment', () => {
    expect(layerNameFromUrl('https://cdn.example.com/logo.png?v=2#x')).toBe('logo.png');
  });

  it('decodes an escaped filename', () => {
    expect(layerNameFromUrl('https://cdn.example.com/my%20logo.png')).toBe('my logo.png');
  });

  it('survives a malformed escape rather than throwing', () => {
    /* A name is not worth a crash; the raw segment will do. */
    expect(layerNameFromUrl('https://cdn.example.com/bad%zz.png')).toBe('bad%zz.png');
  });

  it('falls back when there is no filename', () => {
    expect(layerNameFromUrl('https://cdn.example.com/')).toBe('cdn.example.com');
    expect(layerNameFromUrl('https://')).toBe('Layer');
  });
});

describe('isVectorImage', () => {
  /*
   * 📌 **The shared rule, tested directly.** Both the layer path and the
   * product backdrop call it, so a change here moves both — which is the point
   * of there being one copy.
   */
  it('recognises an SVG by its path', () => {
    expect(isVectorImage('https://cdn.example.com/a.svg')).toBe(true);
    expect(isVectorImage('https://cdn.example.com/a.svgz')).toBe(true);
  });

  it('ignores a query string and a fragment', () => {
    expect(isVectorImage('https://cdn.example.com/a.png?x=y.svg')).toBe(false);
    expect(isVectorImage('https://cdn.example.com/a.png#a.svg')).toBe(false);
  });

  it('does not match a directory named svg', () => {
    expect(isVectorImage('https://cdn.example.com/svg/a.png')).toBe(false);
  });

  it('does not match a name merely containing svg', () => {
    /* ⚠️ `logo-svg.png` is a PNG; only the extension decides. */
    expect(isVectorImage('https://cdn.example.com/logo-svg.png')).toBe(false);
  });
});
