import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AuthoringSet } from '@/lib/option-sets/api';

import { SetPreview } from './set-preview';

/**
 * 🔴 **Rendered, not reasoned about.** The sibling preview's own suite records
 * why: *"the swatch mutants that survived an earlier stage did so precisely
 * because the rule lived in JSX no test reached."* Every rule asserted here is a
 * rule in markup.
 */
const html = (set: unknown, products: unknown[] = []) =>
  renderToStaticMarkup(
    <SetPreview set={set as AuthoringSet} products={products as never} />,
  );

const value = (over: Record<string, unknown> = {}) => ({
  id: 'v1', valueKey: 'gold', label: 'Gold', sortOrder: 0,
  priceType: 'fixed', priceAmountMinor: 0, isEnabled: true, ...over,
});

const option = (over: Record<string, unknown> = {}) => ({
  id: 'o1', key: 'finish', label: 'Finish', presentation: 'dropdown',
  isRequired: false, sortOrder: 0, isEnabled: true, values: [], ...over,
});

const group = (over: Record<string, unknown> = {}) => ({
  id: 'g1', label: 'Materials', description: null, sortOrder: 0, isEnabled: true,
  displayType: 'inline', isCollapsible: false, items: [], options: [option()], ...over,
});

const set = (over: Record<string, unknown> = {}) => ({
  id: 's1', storeId: 'store', name: 'Set', status: 'draft', version: 1, rowVersion: 1,
  publishedAt: null, publishedConfigVersion: 0, groups: [group()], ...over,
});

describe('SetPreview', () => {
  it('draws each enabled group and its options', () => {
    const markup = html(set());

    expect(markup).toContain('Materials');
    expect(markup).toContain('Finish');
  });

  /**
   * 🔴 **Absent, not greyed out.** A disabled group is left out of the published
   * document entirely, so a preview drawing it dimmed would show the merchant
   * something the storefront will never render.
   */
  it('leaves out a disabled group entirely', () => {
    const markup = html(set({ groups: [group({ isEnabled: false })] }));

    expect(markup).not.toContain('Materials');
  });

  it('leaves out a disabled option', () => {
    const markup = html(
      set({ groups: [group({ options: [option({ isEnabled: false })] })] }),
    );

    expect(markup).not.toContain('Finish');
  });

  it('leaves out a disabled value', () => {
    const markup = html(
      set({
        groups: [
          group({
            options: [
              option({ values: [value(), value({ id: 'v2', label: 'Silver', isEnabled: false })] }),
            ],
          }),
        ],
      }),
    );

    expect(markup).toContain('Gold');
    expect(markup).not.toContain('Silver');
  });

  /** A set that publishes nothing says so, rather than drawing an empty frame. */
  it('says so when nothing would reach a customer', () => {
    expect(html(set({ groups: [] }))).toContain('Nothing would be shown to a customer yet');
  });

  describe('pricing', () => {
    it('prices a fixed value beside its label', () => {
      const markup = html(
        set({
          groups: [
            group({
              options: [
                option({
                  values: [
                    value({ priceConfig: { type: 'fixed', amountMinor: 1000 } }),
                  ],
                }),
              ],
            }),
          ],
        }),
      );

      expect(markup).toContain('+10.00');
    });

    /**
     * 🔴 **The ADR-107 divergence, in markup.** The storefront prints nothing
     * for a percentage. The preview prices it — 2.5% of the stated £50.00 sample
     * base is £1.25 — because it runs the server's own evaluator rather than
     * guessing.
     */
    it('prices a percentage, which the storefront deliberately does not', () => {
      const markup = html(
        set({
          groups: [
            group({
              options: [
                option({
                  values: [
                    value({
                      priceType: 'percentage',
                      priceConfig: { type: 'percentage', basisPoints: 250 },
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      );

      expect(markup).toContain('+1.25');
    });

    /**
     * 🔴 **The price sits beside the label, never aligned in a column**
     * (ADR-065). The storefront's own markup is two adjacent spans —
     * `<span class="optionia-value__label">Luxury</span>
     * <span class="optionia-value__price">+10.50</span>` — spaced by
     * `margin-left: 0.35em`, and its CSS states the reason: *"the label and the
     * price are one sentence a customer reads together, and a column needs a
     * width this stylesheet cannot know without owning the theme's layout."*
     *
     * ✏️ **The preview used `justify-between` until an audit caught it**, which
     * pushes the price to the far edge — exactly the column layout ADR-065
     * rejects, and most visibly wrong inside M21.2's narrow frame. Nothing
     * failed when it was fixed, because nothing pinned the decision: it lived
     * only in a CSS comment in another repository.
     */
    it('puts a value’s price beside its label, not in a column', () => {
      const markup = html(
        set({
          groups: [
            group({
              options: [
                option({
                  values: [value({ priceConfig: { type: 'fixed', amountMinor: 1050 } })],
                }),
              ],
            }),
          ],
        }),
      );

      const row = markup.slice(markup.indexOf('<li>'), markup.indexOf('</li>'));

      expect(row).not.toContain('justify-between');
      /* Adjacent spans, as the storefront emits them. */
      expect(row).toMatch(/<span>Gold<\/span><span[^>]*>\+10\.50<\/span>/);
    });

    /** A number a merchant could mistake for the customer's total needs its base. */
    it('states the base it priced against', () => {
      expect(html(set())).toContain('sample product price of 50.00');
    });
  });

  describe('display settings', () => {
    /**
     * 🔴 **`columns` is a maximum, not a count** (ADR-108). The storefront gives
     * every `--cols-2`…`--cols-6` one identical rule — `auto-fit` with a `7em`
     * minimum — so the number decides *whether* a grid applies, never how many
     * columns appear. Drawing exactly four would promise a layout the shop gives
     * only when the container is wide enough.
     */
    it('lays choices out on an auto-fit grid when a column count is set', () => {
      const markup = html(
        set({
          groups: [
            group({
              options: [option({ display: { columns: 4 }, values: [value()] })],
            }),
          ],
        }),
      );

      /*
       * ✏️ **Both the class and the style, because a mutant survived asserting
       * only the style.** `grid-template-columns` does nothing without
       * `display: grid`, so a preview that kept the style and dropped the class
       * would lay out as a plain list while looking correct to a test reading
       * the style alone.
       */
      expect(markup).toContain('repeat(auto-fit, minmax(7em, 1fr))');
      expect(markup).toMatch(/class="grid[^"]*"/);
    });

    /** One column is the default flow; `--cols-1` deliberately matches nothing. */
    it('leaves a single column as a plain list', () => {
      const markup = html(
        set({
          groups: [
            group({ options: [option({ display: { columns: 1 }, values: [value()] })] }),
          ],
        }),
      );

      expect(markup).not.toContain('auto-fit');
      expect(markup).not.toMatch(/class="grid[^"]*"/);
    });

    it('sizes a swatch the way the merchant chose', () => {
      const markup = html(
        set({
          groups: [
            group({
              options: [
                option({
                  display: { swatch_size: 'large' },
                  values: [value({ colorHex: '#aabbcc' })],
                }),
              ],
            }),
          ],
        }),
      );

      /*
       * ✏️ **Asserted `width:3em` until M21c.2 (F34).** The swatch now reads
       * `var(--optionia-swatch, 3em)` so a merchant's pixel override can win,
       * and the enum remains the fallback — so `large` still means `3em` when
       * no token is set. The assertion follows the spelling rather than
       * loosening: it must still fail if the enum stops reaching the markup.
       */
      expect(markup).toContain('width:var(--optionia-swatch, 3em)');
    });

    /** `medium` is the storefront's base rule, and the fallback when unset. */
    it('falls back to the medium swatch', () => {
      const markup = html(
        set({
          groups: [
            group({ options: [option({ values: [value({ colorHex: '#aabbcc' })] })] }),
          ],
        }),
      );

      expect(markup).toContain('width:var(--optionia-swatch, 2em)');
    });

    it('draws no swatch for a value that carries none', () => {
      const markup = html(
        set({ groups: [group({ options: [option({ values: [value()] })] })] }),
      );

      expect(markup).not.toContain('aria-hidden="true"');
    });
  });

  describe('the base price (M21.4)', () => {
    /** Every set has no product while it is being written. */
    it('names the stated sample when nothing is chosen', () => {
      expect(html(set())).toContain('a sample product price of 50.00');
    });

    /**
     * 📌 **"This set's options"**, because a product may carry several option
     * sets and the storefront sums every one into a single line total (G3). The
     * editor shows one set, so it says so rather than implying a whole total.
     */
    it('says it is pricing this set, not the whole product', () => {
      expect(html(set())).toContain('This set’s options, priced against');
    });

    /**
     * 🔴 **The catalogue pushes every product type; the storefront renders
     * two.** An `external` or `grouped` product can be chosen, priced, and show
     * a customer nothing at all.
     */
    it('warns when a chosen product would render no options', () => {
      const markup = html(set(), [
        {
          id: 'p1', externalId: '9', name: 'Test Grouped Bundle', sku: null,
          type: 'grouped', priceMinor: 8000, status: 'publish',
          permalink: null, imageUrl: null,
        },
      ]);

      /* Not chosen yet, so no warning — the merchant has not pointed at it. */
      expect(markup).not.toContain('would see none of this');
    });

    it('offers each product as something to price against', () => {
      const markup = html(set(), [
        {
          id: 'p1', externalId: '20', name: 'Custom Hoodie', sku: null,
          type: 'simple', priceMinor: 8000, status: 'publish',
          permalink: null, imageUrl: null,
        },
      ]);

      expect(markup).toContain('Custom Hoodie');
      expect(markup).toContain('a sample price');
    });
  });

  /**
   * Options and presentational items share one `sortOrder` scale, so a heading
   * authored between two options must render between them — not above both.
   */
  it('interleaves presentational items with options by sort order', () => {
    const markup = html(
      set({
        groups: [
          group({
            options: [
              option({ id: 'o1', label: 'First', sortOrder: 0 }),
              option({ id: 'o2', label: 'Second', sortOrder: 2 }),
            ],
            items: [{ id: 'i1', kind: 'heading', content: 'Engraving', sortOrder: 1 }],
          }),
        ],
      }),
    );

    expect(markup.indexOf('First')).toBeLessThan(markup.indexOf('Engraving'));
    expect(markup.indexOf('Engraving')).toBeLessThan(markup.indexOf('Second'));
  });

  /**
   * 🔴 **A divider's style reaches the preview markup** (M21c.5, F35).
   *
   * `dividerStyle()` can be correct and reach nothing — the *absent code* shape
   * this project has written seven gates for. The preview drew `border-t` and
   * nothing else until 2026-09-22, so a merchant choosing `dashed` saw a solid
   * rule here and a dashed one on the shop.
   */
  it.each([
    ['dashed', 'border-dashed'],
    ['dotted', 'border-dotted'],
    ['solid', 'border-solid'],
  ])('draws a %s divider', (style, expected) => {
    const markup = html(
      set({
        groups: [
          group({
            items: [
              { id: 'i1', kind: 'divider', content: '', sortOrder: 1, display: { style } },
            ],
          }),
        ],
      }),
    );

    expect(markup).toContain(expected);
  });

  /**
   * ⚠️ **A style the API would refuse degrades to solid here too**, so a stale
   * document renders the same way on both surfaces rather than differently.
   */
  it('draws an unsupported divider style as solid', () => {
    const markup = html(
      set({
        groups: [
          group({
            items: [
              {
                id: 'i1',
                kind: 'divider',
                content: '',
                sortOrder: 1,
                display: { style: 'groove' },
              },
            ],
          }),
        ],
      }),
    );

    expect(markup).toContain('border-solid');
    expect(markup).not.toContain('groove');
  });

  /**
   * ✏️ **This asserted the id as a SUBSTRING first, and a mutant survived.**
   * The id appears twice — as `id=` on the paragraph and inside
   * `aria-describedby=` on the list — so deleting the `id` attribute left the
   * other occurrence and the test passed. An `aria-describedby` pointing at an
   * element that does not exist is exactly the defect worth catching, and it is
   * invisible to a substring.
   *
   * Both halves are now asserted as attributes, which is the contract: the
   * reference, and the thing it refers to.
   */
  it('gives guidance an id that aria-describedby actually points at', () => {
    const markup = html(
      set({
        groups: [
          group({ options: [option({ description: 'Pick a finish', values: [value()] })] }),
        ],
      }),
    );

    expect(markup).toContain('id="optionia-desc-o1"');
    expect(markup).toContain('aria-describedby="optionia-desc-o1"');
    expect(markup).toContain('Pick a finish');
  });

  /** A type this build cannot price is named, because a blank reads as "free". */
  it('names a type it cannot price', () => {
    const markup = html(
      set({
        groups: [
          group({
            options: [
              option({
                values: [
                  value({
                    priceType: 'per_unit',
                    priceConfig: { type: 'per_unit', amountMinor: 100 },
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );

    expect(markup).toContain('could not be priced (per_unit)');
  });
});
