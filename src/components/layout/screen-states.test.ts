import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Criterion 4: **loading, empty, and error states present on every screen**.
 *
 * ## Why this reads source rather than rendering
 *
 * The states are already enforced where a screen uses `AsyncState`: its four
 * props are required, so omitting one is a *compile* error, not a review
 * finding. `EmptyState` likewise requires an action, which is what makes the
 * plan's rule — "an empty state that says 'No data' is a defect" — structurally
 * unviolatable.
 *
 * What no type can check is the **hand-rolled** path: a screen that fetches but
 * branches by hand can forget a case and still compile. `/connect` did exactly
 * that — it checked `error` and not `data === undefined`, so one path rendered a
 * consent dialog above an empty site URL. This guard exists for that path.
 *
 * ⚠️ It asserts *presence*, not correctness. A screen cannot silently stop
 * handling a state; whether the wording is right is a human question.
 */
const APP = join(process.cwd(), 'src/app');

/** Every `page.tsx` under `src/app`, whatever route group it sits in. */
function screens(dir: string = APP): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      return screens(path);
    }

    return entry === 'page.tsx' ? [path] : [];
  });
}

/**
 * A file's **code**, with comments removed.
 *
 * ⚠️ Not a nicety. Three of this guard's first four mutants survived because the
 * assertions matched the prose explaining a fix rather than the fix: deleting
 * `query.data === undefined` from `/connect` left the phrase in the doc comment
 * directly above it, and deleting `min-w-0` from a `className` left it in the
 * comment saying why it was there. A guard that reads its own documentation
 * proves nothing.
 */
const code = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

const label = (path: string) => path.slice(APP.length + 1);

const ALL = screens();

/** A screen that fetches has states to get wrong; one that does not, does not. */
const fetching = ALL.filter((path) => /use(Infinite)?Query\(/.test(code(path)));

describe('screen inventory', () => {
  /** Guards the walker: an empty list would make every case below vacuous. */
  it('finds every screen', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(13);
    expect(fetching.length).toBeGreaterThanOrEqual(5);
  });
});

describe.each(fetching.map((p) => [label(p), p]))('%s', (_name, path) => {
  const source = code(path);
  const usesAsyncState = /\bAsyncState\b/.test(source);

  /* `\b` on every identifier: `isLoadingXX` contains `isLoading`, and an
   * unanchored match called a renamed symbol a present one. */
  it('reports loading', () => {
    expect(/\b(isLoading|isPending|FullPageLoading|LoadingRows|Suspense)\b/.test(source)).toBe(
      true,
    );
  });

  it('reports errors', () => {
    expect(/\b(error|ErrorState|ConflictAwareError)\b/.test(source)).toBe(true);
  });

  /**
   * 🔴 The `/connect` defect, generalised.
   *
   * `AsyncState` narrows `data` itself, so a screen using it cannot reach its
   * children with `undefined`. A screen branching by hand must say so — checking
   * only `error` leaves a settled-but-empty path that renders the populated view
   * over missing data.
   */
  it('narrows data before rendering it', () => {
    if (usesAsyncState) {
      return;
    }

    expect(/data\s*===\s*undefined|data\s*!==\s*undefined|data\?\./.test(source)).toBe(true);
  });
});

/**
 * A merchant's own text has no length limit worth trusting: an option-set name
 * is capped at 255 characters with no space required, and a SKU is whatever
 * WooCommerce holds. Both render in a flex row, where `truncate` does nothing
 * without `min-w-0` — a flex child defaults to `min-width: auto` and refuses to
 * shrink past its content, so the row widens on a phone instead.
 */
describe('unbounded merchant text', () => {
  const UNBOUNDED = [
    join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'),
    join(process.cwd(), 'src/components/products/product-display.tsx'),
    join(process.cwd(), 'src/components/products/product-picker.tsx'),
  ];

  it.each(UNBOUNDED.map((p) => [p.slice(process.cwd().length + 1), p]))(
    '%s truncates inside a shrinkable column',
    (_name, path) => {
      const source = code(path);

      /* Asserted inside a className, so a comment mentioning them cannot pass. */
      expect(source).toMatch(/className="[^"]*\bmin-w-0\b/);
      expect(source).toMatch(/className="[^"]*\btruncate\b/);
    },
  );
});
