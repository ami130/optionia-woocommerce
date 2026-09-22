import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The two search screens must keep the promises the API can actually keep.
 *
 * ## Why this reads source rather than rendering
 *
 * `@testing-library/react` is not a dependency, so no test in this repo can
 * mount a component. These are the two defects that shipped in Stage 5 anyway,
 * and both are **statically visible**: a term wired straight into a `queryKey`,
 * and a placeholder promising a match the `LIKE 'term%'` query will not make.
 *
 * A source-reading guard is weaker than a render test and stronger than the
 * nothing that let these through. When a renderer is added, these move.
 */
const FILES = {
  '/products': join(process.cwd(), 'src/app/(app)/products/page.tsx'),
  picker: join(process.cwd(), 'src/components/products/product-picker.tsx'),
};

/** Where the shared row and empty state live, once both screens stopped copying them. */
const DISPLAY = join(process.cwd(), 'src/components/products/product-display.tsx');

const read = (path: string) => readFileSync(path, 'utf8');

describe.each(Object.entries(FILES))('%s search', (_name, path) => {
  /**
   * 🔴 K2. Every keystroke was a request against a 20-per-second throttle, so
   * typing a product name answered `429` and replaced the results with
   * "Too many attempts".
   */
  it('fetches on the debounced term, never the raw input', () => {
    const source = read(path);

    /*
     * ⚠️ **`searchTerm` must be the hook's output, not a rename of the state.**
     * Checking only that the key mentions `searchTerm` let a mutant through that
     * deleted the import and wrote `const searchTerm = search`. The binding is
     * asserted, so the name cannot be satisfied by an alias.
     */
    expect(source).toContain("from '@/lib/hooks/use-debounced'");
    expect(source).toMatch(/const\s+searchTerm\s*=\s*useDebounced\(\s*search\s*[,)]/);

    const queryKeys = source.match(/queryKey: \[[^\]]*\]/g) ?? [];
    const productKeys = queryKeys.filter((key) => key.includes("'products'"));

    expect(productKeys.length).toBeGreaterThan(0);

    for (const key of productKeys) {
      // The raw `search` state must not be what varies the cache key.
      expect(key).toContain('searchTerm');
      expect(key).not.toMatch(/[^a-zA-Z]search[^A-Za-z]/);
    }

    /*
     * …nor what is sent to the API.
     *
     * ⚠️ Matched as shorthand-with-any-terminator. An earlier version required a
     * trailing comma (`search,`) and so **missed `listProducts({ storeId, search })`**
     * — the picker's exact call shape. The mutant survived, which is the only
     * reason this comment exists.
     */
    for (const call of source.match(/listProducts\(\{[^}]*\}/g) ?? []) {
      expect(call).not.toMatch(/\bsearch\s*[,}]/);
    }
  });

  /**
   * 🔴 L1. Debouncing bought a quiet failure: `isLoading` is true only for the
   * *first* fetch of a key, so every later search left the previous rows on
   * screen with nothing to say a new one was in flight — for the debounce pause
   * plus the round trip. The list then answers a term the merchant has already
   * replaced, and reads as a search box that ignores input.
   */
  it('reports an in-flight search over stale rows', () => {
    const source = read(path);

    expect(source).toMatch(/isRefreshing=\{[^}]*isFetching/);
  });

  /**
   * 🔴 K1. The API matches `LIKE 'term%'`. Measured on seeded data: "Board"
   * returns nothing while three products contain it. A placeholder that implies
   * substring search is a promise the query cannot keep.
   */
  it('tells the merchant the match is a prefix', () => {
    const source = read(path);
    const placeholders = [...source.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);

    const searchPlaceholders = placeholders.filter((text) => /search/i.test(text));
    expect(searchPlaceholders.length).toBeGreaterThan(0);

    for (const text of searchPlaceholders) {
      expect(text.toLowerCase()).toContain('starts with');
    }
  });

});

/**
 * The shared display module owns what both screens render.
 *
 * ⚠️ These assertions were per-screen until the rows and empty state were
 * extracted. The extraction **silently weakened them**: each screen still
 * contained "starts with" in its placeholder, so a mutant that gutted the empty
 * state's wording passed. Asserting against the file that actually holds the
 * text is what makes the check real again — a guard follows the code it guards.
 */
describe('shared product display', () => {
  /** An empty result must say *why*, or it reads as a broken catalogue. */
  it('explains an empty search result in prefix terms', () => {
    const source = read(DISPLAY);

    expect(source).toMatch(/starts with<\/em>/);
  });

  /**
   * 🔴 **The empty state must describe a push, not an import.** It said
   * *"Optionia imports your products"* until M19.1 — a design ADR-067 had
   * already withdrawn, since the cloud holds no WooCommerce credentials and AC8
   * forbids it. A merchant met that sentence as the **first** thing they read
   * when something was wrong, and it told them the opposite of how the system
   * works.
   */
  it('describes the catalogue arriving from the store, not being imported', () => {
    const source = read(DISPLAY);

    expect(source).not.toMatch(/Optionia imports your products/);
    expect(source).toMatch(/sends its products/);
  });

  /**
   * ⚠️ **And it must name an action.** "Once that has run" leaves a merchant
   * waiting on a process they cannot see or diagnose. The plugin's System
   * Status has a row that answers exactly this question.
   */
  it('points the merchant at where the sync is visible', () => {
    const source = read(DISPLAY);

    expect(source).toMatch(/System Status/);
    expect(source).toMatch(/Catalogue sync/);
  });

  /**
   * 🔴 L2. The two screens' rows had already drifted before they were shared:
   * `#1042` against `1042`, and `—` against nothing for a product with no single
   * price. Neither shows up in development, because the seeded catalogue has no
   * null price and no null SKU.
   */
  it('renders one identity and one price rule', () => {
    const source = read(DISPLAY);

    expect(source).toMatch(/product\.sku \?\? `#\$\{product\.externalId\}`/);
    expect(source).toMatch(/product\.priceMinor === null \? '—'/);
  });

  it('is the only definition of either', () => {
    for (const path of Object.values(FILES)) {
      const source = read(path);

      expect(source).not.toMatch(/function (ProductRow|CatalogueRow|EmptyCatalogue)\b/);
      expect(source).toContain("from '@/components/products/product-display'");
    }
  });
});

/**
 * 🔴 K4. `/products` is an infinite query (`{pages: [...]}`) and the picker is a
 * plain one (`ProductPage`). TanStack v5 keys one cache entry per key whatever
 * hook wrote it, so an identical key would hand whichever mounted second the
 * other's shape and leave `data.items` undefined.
 */
describe('product query keys', () => {
  it('never lets the two screens share a cache entry', () => {
    const page = read(FILES['/products']);
    const picker = read(FILES.picker);

    expect(picker).toContain("'products', 'picker'");
    expect(page).not.toContain("'products', 'picker'");

    const keyOf = (source: string) =>
      (source.match(/queryKey: \[[^\]]*'products'[^\]]*\]/g) ?? []).map((k) =>
        k.replace(/\s+/g, ''),
      );

    const shared = keyOf(page).filter((key) => keyOf(picker).includes(key));

    expect(shared).toEqual([]);
  });
});
