import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * What the API sends, and what the dashboard admits it sends.
 *
 * 🔴 **The authoring projection carries SIXTEEN fields per value; the dashboard
 * declared NINE.** `priceConfig` was among the seven dropped — and it is the
 * first argument to `optionPricingDelta`, the function M20.6's sample total is
 * built on. Copying the evaluator without this would have computed **£0.00**
 * for every configured price, because `pricing` arrives `undefined` and the
 * function's first guard returns zero. Working-looking code, silently wrong.
 *
 * 🔴 **`AuthoringSet` declared no `rules` either**, though the projection sends
 * them — its own docblock records the mirror-image mistake ("a fifth query on
 * every dashboard render whose result was thrown away"). `RulesPanel` fetches
 * them separately to this day. A sample total needs rules, because rules add
 * and remove price.
 *
 * ⚠️ **Asserted against the SOURCE of both repositories**, not against a
 * hand-copied list. A test that restated the field names would agree with
 * whatever I typed; reading the projection is what makes a drift in either
 * direction fail.
 */
const backendProjection = readFileSync(
  join(process.cwd(), '..', 'optioniaWooCommerceBackend/src/option-sets/serialization/projections.ts'),
  'utf8',
);

const dashboardApi = readFileSync(join(process.cwd(), 'src/lib/option-sets/api.ts'), 'utf8');

/**
 * Field names declared in one `interface` block, ignoring comments.
 *
 * ⚠️ **Matches `interface Name` without the brace**, because `AuthoringSet`
 * declares `extends OptionSetSummary` between the two. The first draft looked
 * for `interface Name {` literally, found nothing, and reported a missing field
 * that was present — the test failing for its own reason rather than the code's.
 */
const fieldsOf = (source: string, name: string): string[] => {
  const start = source.search(new RegExp(`interface ${name}\\b`));
  const body = source.slice(start, source.indexOf('\n}', start));

  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]!);
};

describe('the dashboard admits every field the API sends', () => {
  /**
   * 🔴 **`priceConfig` is the one M20.6 cannot proceed without.** The others
   * are listed so the gap is visible rather than rediscovered later.
   */
  it('declares priceConfig on a value', () => {
    expect(fieldsOf(dashboardApi, 'AuthoringValue')).toContain('priceConfig');
  });

  it('declares rules on the set', () => {
    expect(fieldsOf(dashboardApi, 'AuthoringSet')).toContain('rules');
  });

  /**
   * 🔴 **`pricing` on the option — the SAME defect as `priceConfig`, one level
   * up.** The projection carries twenty fields per option and the dashboard
   * declared eight, so option-level pricing (`per_char`, `per_unit`, `tiered`)
   * arrived on every editor load and was discarded at the type boundary.
   *
   * ⚠️ Found by extending this test rather than by the feature failing — the
   * lesson M20.6's F1 taught, applied before writing the UI this time.
   */
  it('declares pricing on an option', () => {
    expect(fieldsOf(dashboardApi, 'AuthoringOption')).toContain('pricing');
  });

  it('declares no option field the API does not send', () => {
    const sent = fieldsOf(backendProjection, 'AuthoringOption');
    const declared = fieldsOf(dashboardApi, 'AuthoringOption');

    expect(declared.filter((field) => !sent.includes(field))).toEqual([]);
  });

  /**
   * ⚠️ **Not every field — the dashboard may legitimately ignore some.**
   * `createdAt`/`updatedAt` are metadata no editor renders, and declaring them
   * would be noise. What this pins is that the fields the dashboard DOES
   * declare all exist in the projection: a typo or a renamed field fails here
   * rather than reading `undefined` at runtime.
   */
  it('declares no value field the API does not send', () => {
    const sent = fieldsOf(backendProjection, 'AuthoringOptionValue');
    const declared = fieldsOf(dashboardApi, 'AuthoringValue');

    expect(declared.filter((field) => !sent.includes(field))).toEqual([]);
  });

  it('declares no rule field the API does not send', () => {
    const sent = fieldsOf(backendProjection, 'AuthoringRule');
    const declared = fieldsOf(dashboardApi, 'AuthoringRule');

    expect(declared.filter((field) => !sent.includes(field))).toEqual([]);
  });
});

/**
 * 🔴 **Completeness, not a hand-written list of what to check.**
 *
 * The three named assertions above each arrived the same way: a feature failed,
 * an audit found a field the API sends and the dashboard drops, and a test was
 * written for *that* field. `priceConfig`, then `rules`, then `pricing` — three
 * instances of one defect class, each caught after it bit.
 *
 * ⚠️ **A guard that names fields catches regressions and never catches the NEXT
 * one.** This reverses it: every projection field must be either declared or
 * listed below as a deliberate omission, so a field added to the API fails here
 * until somebody decides about it.
 *
 * 📌 **The exemptions are the point.** Each says why the dashboard does not need
 * the field; an entry that stops being true is one line to delete.
 */
const NOT_DECLARED: Record<string, Record<string, string>> = {
  AuthoringOptionValue: {
    createdAt: 'row metadata; no editor renders it',
    updatedAt: 'row metadata; no editor renders it',
  },
  AuthoringOption: {
    createdAt: 'row metadata; no editor renders it',
    updatedAt: 'row metadata; no editor renders it',
    valueKind: 'derived from `presentation`, which the editor already carries',
    cardinality: 'derived from `presentation`; M18.3 allows MANY for checkbox alone',
  },
  AuthoringGroup: {
    createdAt: 'row metadata; no editor renders it',
    updatedAt: 'row metadata; no editor renders it',
  },
  AuthoringRule: {
    createdAt: 'row metadata; no editor renders it',
    updatedAt: 'row metadata; no editor renders it',
  },
  AuthoringPresentationalItem: {
    createdAt: 'row metadata; no editor renders it',
    updatedAt: 'row metadata; no editor renders it',
    /*
     * ✅ **Exemption retired 2026-09-22 (M21c.5).** It read *"published but no
     * plugin template reads it — nothing to author yet"*, which was true and is
     * not any more: `divider.php` reads `display.style`, the preview draws it,
     * and `AddItem` offers the three styles.
     *
     * 🔴 **This test is what noticed.** The exemption went stale the moment the
     * field became authorable, and the suite failed on the next run rather than
     * leaving a comment describing a state that had passed.
     */
  },
};

describe('every projection field is declared or deliberately omitted', () => {
  it.each([
    ['AuthoringOptionValue', 'AuthoringValue'],
    ['AuthoringOption', 'AuthoringOption'],
    ['AuthoringGroup', 'AuthoringGroup'],
    ['AuthoringRule', 'AuthoringRule'],
    ['AuthoringPresentationalItem', 'AuthoringItem'],
  ])('%s', (projection, dashboard) => {
    const sent = fieldsOf(backendProjection, projection);
    const declared = fieldsOf(dashboardApi, dashboard);
    const exempt = NOT_DECLARED[projection] ?? {};

    const undecided = sent.filter(
      (field) => !declared.includes(field) && exempt[field] === undefined,
    );

    expect(undecided).toEqual([]);
  });

  /** ⚠️ An exemption for a field the dashboard now declares is stale. */
  it.each([
    ['AuthoringOptionValue', 'AuthoringValue'],
    ['AuthoringOption', 'AuthoringOption'],
    ['AuthoringGroup', 'AuthoringGroup'],
    ['AuthoringRule', 'AuthoringRule'],
    ['AuthoringPresentationalItem', 'AuthoringItem'],
  ])('%s has no stale exemption', (projection, dashboard) => {
    const declared = fieldsOf(dashboardApi, dashboard);
    const exempt = Object.keys(NOT_DECLARED[projection] ?? {});

    expect(exempt.filter((field) => declared.includes(field))).toEqual([]);
  });
});
