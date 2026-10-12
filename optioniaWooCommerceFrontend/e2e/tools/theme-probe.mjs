/**
 * One theme, measured: does the runtime arrive configured, and does the overlay
 * land on the product image?
 *
 * 🔴 **This found F207.** Run against Storefront, Twenty Twenty-Four and Twenty
 * Twenty-Five it showed the options rendering and `frontend.js` loading on all
 * three, while `optioniaSettings` reached only the classic theme — so the
 * runtime is silently unconfigured on block themes, with no JavaScript error.
 *
 * ⚠️ **Not part of the Playwright suite, deliberately.** It switches no theme
 * and asserts nothing: it reports what one theme does, and the comparison is
 * the finding. A suite that activated themes would mutate a shared WordPress
 * install mid-run, which `playwright.config.ts` already refuses to do for the
 * services it checks.
 *
 * Usage, one theme at a time:
 *
 *   studio-cli.sh wp theme activate twentytwentyfour
 *   node e2e/tools/theme-probe.mjs twentytwentyfour
 *   studio-cli.sh wp theme activate storefront
 *
 * 📌 **`SCRIPT_DEBUG` must be true**, or `testSurface` reports false and the
 * image checks are meaningless. Studio reverts it on restart — see the
 * precondition in `e2e/product-image.spec.ts`.
 */
import { chromium } from 'playwright';

const THEME = process.argv[2] || 'unknown';
const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
await ctx.route('**/wp-content/plugins/**/*.js*', async r => {
  const s = await r.fetch();
  await r.fulfill({ response: s, body: await s.text(), headers: { ...s.headers(), 'cache-control': 'no-store' } });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 60)));

await page.goto('https://optionia.local/product/spider-man/', { waitUntil: 'networkidle' });

const before = await page.evaluate(() => {
  const root = document.querySelector('[data-optionia="options"]');
  const api = window.optioniaTest;
  const img = root && api ? api.productImage(root) : null;
  return {
    optionsBlock: !!root,
    testSurface: !!api,
    imageFound: !!img,
    imageSrc: img ? (img.getAttribute('src') || '').split('/').pop().slice(0, 30) : null,
    gallerySelector: img ? !!img.closest('.woocommerce-product-gallery') : null,
    objectFit: img ? getComputedStyle(img).objectFit : null,
    framePosition: img?.parentElement ? getComputedStyle(img.parentElement).position : null,
    totalImages: document.querySelectorAll('img').length,
  };
});

// Click a swatch and let the preview draw.
await page.locator('[data-optionia="options"] input[type=radio]').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(4500);

const after = await page.evaluate(() => {
  const root = document.querySelector('[data-optionia="options"]');
  const img = root && window.optioniaTest ? window.optioniaTest.productImage(root) : null;
  const host = document.querySelector('[data-optionia-preview]');
  if (!host || !img) return { host: !!host, svg: false, aligned: null };
  const h = host.getBoundingClientRect(), i = img.getBoundingClientRect();
  return {
    host: true,
    svg: !!host.querySelector('svg'),
    sameParent: host.parentElement === img.parentElement,
    aligned: Math.abs(h.left - i.left) < 3 && Math.abs(h.top - i.top) < 3
          && Math.abs(h.width - i.width) < 3 && Math.abs(h.height - i.height) < 3,
    box: { w: Math.round(i.width), h: Math.round(i.height) },
  };
});

console.log(JSON.stringify({ theme: THEME, before, after, errors: errors.filter(e => !/rdt|snaptr/.test(e)) }, null, 2));
await b.close();
