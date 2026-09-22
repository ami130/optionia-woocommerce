import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUTHORABLE_TYPES } from '@/lib/schemas/option-sets';
import { SAMPLE_BASE_MINOR } from '@/lib/option-sets/sample-total';

import { compareType, storefrontValues } from './fidelity';

/**
 * 🔴 **The storefront's own rendered markup is the oracle** (M21.6).
 * `generate-fixtures.php` renders every option type through the **real**
 * `Renderer` under `ob_start()` — *"exactly as a browser receives it"* — and
 * fails loudly if any type renders empty. It is the only corpus of what a
 * storefront actually emits.
 *
 * ⚠️ **Read from the plugin, not copied** (ADR-109). `check-fixture-parity.sh`
 * loops over the plugin's `fixtures/shared` and demands a byte-identical
 * *backend* copy — and the backend has no use for rendered HTML.
 */
const RENDERED: Record<string, string> = JSON.parse(
  readFileSync(
    join(process.cwd(), '..', 'optioniaWooCommercePlugin', 'tests', 'js', 'rendered-fixtures.json'),
    'utf8',
  ),
);

describe('storefrontValues', () => {
  it('reads a priced value out of real storefront markup', () => {
    expect(storefrontValues(RENDERED.dropdown)).toEqual([
      { valueId: 'val-dropdown-lux', priceType: 'fixed', priceMinor: 1050 },
    ]);
  });

  /**
   * ⚠️ **No `[^>]*` anywhere**, for the reason the plugin's own contract test
   * records: the templates build attributes inside `<?php if ( … ) : ?>` blocks,
   * so a pattern that stops at `?>` *"reports 'no price attribute' for a
   * template full of them."*
   */
  it('finds nothing in a type that publishes no per-value price', () => {
    expect(storefrontValues(RENDERED.text_field)).toEqual([]);
  });
});

describe('the fidelity report (M21.6)', () => {
  /**
   * 🔴 **Every registry type appears, with a verdict and a reason** — the
   * milestone's acceptance. A type added to the registry and never previewed
   * shows up here rather than being remembered.
   */
  it('reports on every authorable type', () => {
    const reported = AUTHORABLE_TYPES.map((type) =>
      compareType(type.value, RENDERED[type.value] ?? '', SAMPLE_BASE_MINOR),
    );

    expect(reported).toHaveLength(AUTHORABLE_TYPES.length);
    reported.forEach((row) => {
      expect(row.reason).not.toBe('');
      expect(['exact', 'approximate', 'not previewed']).toContain(row.fidelity);
    });
  });

  /**
   * 🔴 **No type may be `approximate` today.** That is the report's whole point:
   * a divergence is a finding, not a status. If this fails, the preview and the
   * storefront have stopped agreeing on a price.
   */
  it('finds no type whose prices disagree with the storefront', () => {
    const disagreeing = AUTHORABLE_TYPES.map((type) =>
      compareType(type.value, RENDERED[type.value] ?? '', SAMPLE_BASE_MINOR),
    ).filter((row) => row.fidelity === 'approximate');

    expect(disagreeing).toEqual([]);
  });

  /**
   * The five choice types are the ones that publish a per-value price;
   * `takesValues` gates it. Asserted so a change to that rule shows up here.
   */
  it('compares a price for every type that publishes one', () => {
    const compared = AUTHORABLE_TYPES.map((type) =>
      compareType(type.value, RENDERED[type.value] ?? '', SAMPLE_BASE_MINOR),
    ).filter((row) => row.compared > 0);

    expect(compared.map((row) => row.type).sort()).toEqual([
      'checkbox',
      'color_swatch',
      'dropdown',
      'image_swatch',
      'radio',
    ]);
  });

  /**
   * ⚠️ **`file_input` takes values and its template draws none** — an upload has
   * no choice list. A real fidelity fact, recorded rather than treated as a gap.
   */
  it('records that an upload previews no priced choice', () => {
    const row = compareType('file_input', RENDERED.file_input, SAMPLE_BASE_MINOR);

    expect(row.compared).toBe(0);
    expect(row.fidelity).toBe('not previewed');
  });

  /**
   * 🔴 **A divergence must be caught, or the report certifies nothing.**
   *
   * ✏️ **The first version could not catch a wrong amount.** It read a price out
   * of the markup and fed it to the evaluator, which returns what it is given —
   * so markup and evaluator agreed with each other however wrong both were. A
   * mutation replacing the amount check with `>= 0` survived, which is what
   * exposed it.
   *
   * The authored amount is the second source that makes this a comparison: the
   * storefront must publish what was configured, and the preview must price that
   * to the same number.
   */
  it('reports a storefront that publishes the wrong amount as approximate', () => {
    const tampered = RENDERED.dropdown.replace(
      'data-optionia-price="1050"',
      'data-optionia-price="9999"',
    );

    expect(compareType('dropdown', tampered, SAMPLE_BASE_MINOR).fidelity).toBe('approximate');
  });

  it('reports a price the preview cannot evaluate as approximate', () => {
    const broken = RENDERED.dropdown.replace(
      'data-optionia-price-type="fixed"',
      'data-optionia-price-type="not_a_real_type"',
    );

    expect(compareType('dropdown', broken, SAMPLE_BASE_MINOR).fidelity).toBe('approximate');
  });
});

/**
 * `docs/PREVIEW-FIDELITY.md`, written from the comparison above.
 *
 * 🔴 **Generated, never hand-maintained** (ADR-102). M21.5 asks for deviations
 * *"documented rather than surprising"*, and a hand-written document records
 * what someone remembered. This records what the comparison **measured**, so a
 * type added to the registry and never previewed appears on its own.
 *
 * ⚠️ **Written from a test rather than a script**, because the comparison
 * imports through the `@/` alias and the storefront fixture — both of which the
 * test runner already resolves. A standalone Node script could not load them
 * without duplicating the bundler's resolution, which is a second answer to a
 * question `vitest.config.ts` has already answered.
 */
describe('PREVIEW-FIDELITY.md', () => {
  /**
   * The limits that are **decisions**, not measurements — each with an ADR
   * behind it, so each belongs in the document but cannot be derived from the
   * comparison.
   */
  const RECORDED_LIMITS: readonly (readonly [string, string])[] = [
    [
      'Pricing shown',
      'The preview prices what the **server** charges — all five price types. The storefront’s own live estimate shows `fixed` only, because *“a storefront guessing… would show a total the server disagrees with.”* (ADR-107)',
    ],
    [
      'Column counts',
      '`columns` is a **maximum, not a count**. The storefront gives every count one `auto-fit` rule with a `7em` minimum, so the number decides whether a grid applies, never how many columns appear. (ADR-108)',
    ],
    [
      'Collapsed groups',
      '`collapsed_by_default` de-emphasises rather than collapses, on both sides. Honouring it in CSS alone *“would hide a control from sighted customers while leaving it in the tab order.”*',
    ],
    [
      'Preview width',
      'The three presets are **viewport** widths, but the frame is a content column — narrower in any real theme. There is no way to know a theme’s column width, which is why the storefront owns none. (ADR-108)',
    ],
    [
      'Base price',
      'A real product’s price is a **mirror of the last catalogue push**, not a live quote: `StoreProduct` is display-only, and the catalogue is push-driven. (ADR-067, ADR-101)',
    ],
    [
      'Multiple sets',
      'The preview prices **one set**. A product may carry several, and the storefront sums every one into a single line total.',
    ],
    [
      'Selection and date bounds',
      '`min_selections`, `max_selections`, `min_date` and `max_date` are **server-enforced only** — no template sends them to a browser, so the preview sends none either.',
    ],
    [
      'Control shape',
      'The table above reads **numbers, never markup** (ADR-109), so it cannot see a control drawn wrongly. Control shape is pinned separately, against this same fixture.',
    ],
    [
      'Unordered entries',
      'An option or heading with **no** `sort_order` sorts *first* in the preview and *last* on the storefront, which defaults it to `PHP_INT_MAX` so that *“a document missing `sort_order`”* cannot hoist itself above everything the merchant did order. Unreachable through the API — `sortOrder` is required and defaults to `0` — so the preview does not add a branch no data can take.',
    ],
    [
      'Dialect safety',
      'The authoring and published shapes are both `Record<string, unknown>`, so reading an authoring key off a converted value **compiles**. The seam is held by tests and ADR-103, never by the compiler; a branded type cannot help, because an intersection is still assignable to the converter’s parameter.',
    ],
  ];

  it('writes the document from what was measured', () => {
    const rows = AUTHORABLE_TYPES.map((type) =>
      compareType(type.value, RENDERED[type.value] ?? '', SAMPLE_BASE_MINOR),
    );

    const verdict = (row: (typeof rows)[number]) =>
      `${row.fidelity}${row.compared > 0 ? ` (${row.agreed}/${row.compared})` : ''}`;

    const doc = [
      '# Preview fidelity',
      '',
      '**Generated by `npm test` — do not edit by hand.**',
      '',
      'The live preview and the storefront are two renderers that are *meant* to',
      'differ in markup. What they must agree on is behaviour, so this compares',
      '**numbers**, never markup.',
      '',
      '**What is measured:** every price the storefront publishes in its own',
      'rendered output, evaluated through the same evaluator the preview runs, and',
      'checked against the amount that was authored. All three must line up.',
      '',
      '**What is measured elsewhere:** that the preview *produces* those published',
      'prices — the authoring tree is converted by `previewTree()`, and its own',
      'suite prices straight off that tree. And that each type draws the right',
      '**control**, which a comparison of numbers cannot see.',
      '',
      '## Every option type',
      '',
      '| Type | Fidelity | Why |',
      '| --- | --- | --- |',
      ...rows.map((row) => `| \`${row.type}\` | ${verdict(row)} | ${row.reason} |`),
      '',
      '*`exact` means every published price evaluates to the amount the storefront',
      'charges. `not previewed` means the customer supplies no answer to price.*',
      '',
      '## Recorded limits',
      '',
      'These are deliberate, each with a decision behind it.',
      '',
      '| Limit | What it means |',
      '| --- | --- |',
      ...RECORDED_LIMITS.map(([name, text]) => `| **${name}** | ${text} |`),
      '',
    ].join('\n');

    writeFileSync(join(process.cwd(), '..', 'docs', 'PREVIEW-FIDELITY.md'), doc);

    /* Every type reached the document, and none of them silently. */
    expect(doc).toContain('| `radio` |');
    expect(rows).toHaveLength(AUTHORABLE_TYPES.length);
  });
});
