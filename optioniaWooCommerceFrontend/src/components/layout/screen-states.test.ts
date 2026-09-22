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

/** Every `.tsx` file under a directory, recursively. */
function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      return tsxUnder(path);
    }

    /* Tests describe layouts they do not render; only sources are asserted. */
    return entry.endsWith('.tsx') && !entry.includes('.test.') ? [path] : [];
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

/**
 * Every `.tsx` under `src`, not only the pages.
 *
 * ✏️ **The wording guard below iterated `ALL` and missed its own target.** The
 * copy it polices lives in components — `EmptyCatalogue` is where the
 * ADR-067 mistake was originally made, and where reintroducing it passed. A rule
 * about what a merchant reads has to read every file a merchant reads from.
 */
function sourceFiles(dir: string = join(process.cwd(), 'src')): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }

    /* Tests describe the mistakes they prevent; they must not be policed for them. */
    return entry.endsWith('.tsx') && !entry.includes('.test.') ? [path] : [];
  });
}

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
describe('the builder’s panes collapse on a phone', () => {
  /**
   * 🔴 **A two-pane grid with no breakpoint is unusable on a phone.**
   * 20-2d made the option-set editor `structure | editor`, with the structure
   * column fixed between 12rem and 18rem. On a 375px screen that leaves the
   * editor roughly 5rem wide — every field crushed, the form unusable — and
   * nothing would report it: the markup is valid, the tests pass, and `jsdom`
   * has no viewport.
   *
   * ⚠️ **The guard is the `md:` prefix.** Without it the grid applies at every
   * width; with it, a phone gets one column and the panes stack. Asserted in
   * source for the same reason the truncation rules above are — it is a
   * *class*, and no renderer in this repository can observe a breakpoint.
   */
  /**
   * ⚠️ **Every screen and component, not one file.**
   *
   * ✏️ **This read a single hardcoded path until M21.1 step 3's audit** — the
   * option-set editor — so a multi-column grid in any other screen, or in any
   * component under `src/components`, was unguarded. The live preview is a new
   * component (ADR-104), and ADR-105 chose this mechanism to verify its three
   * widths; a guard scoped to one file would have watched the wrong one.
   */
  const LAYOUT_FILES = [...screens(), ...tsxUnder(join(process.cwd(), 'src/components'))];

  /**
   * ✏️ **And it matched only `grid-cols-[…]`**, the bracketed arbitrary form.
   * `grid-cols-2` and `sm:grid-cols-4` were already in the tree, unseen by a
   * guard written for the editor's one bracketed grid.
   *
   * ⚠️ **A bare `grid-cols-1` is not a violation**, and neither is a bare
   * `grid-cols-2` that a `sm:` rule overrides — a one- or two-column base *is*
   * the phone layout. What this refuses is a multi-column grid that applies at
   * **every** width with no breakpoint anywhere in the same class list.
   */
  /*
   * ✏️ **No trailing `\b`, and that is deliberate.** A first version had one and
   * **passed against a known-broken file**: an arbitrary value ends in `]`, a
   * non-word character, so a word boundary after it can never match. The guard
   * silently watched only the unbracketed forms — which is how the original
   * guard came to miss `grid-cols-2` in the first place.
   *
   * `[2-9]|1[0-9]` deliberately excludes a bare `grid-cols-1`: one column *is*
   * the phone layout.
   */
  /**
   * The **unprefixed** grid in a class list — the one a phone gets.
   *
   * 🔴 **The question is what applies at 375px, not whether a breakpoint
   * exists.** An earlier version asked the second, and passed
   * `md:grid-cols-4 grid-cols-7`: a seven-column grid on a phone, wearing an
   * `md:` rule as camouflage. The `md:` only takes over at tablet, so the
   * defect this guard exists to prevent was present *and* green.
   *
   * The lookbehind refuses a variant prefix (`md:`) and a longer class name
   * (`subgrid-cols-…`), so what is captured is the rule with no condition on it.
   */
  const UNPREFIXED_GRID = /(?<![:\w-])grid-cols-(\[[^\]]*\]|\d+)/;

  /**
   * What a phone may be given without a breakpoint: **one or two columns**.
   *
   * ⚠️ **Two is deliberate, not a rounding.** `grid-cols-2` with an
   * `sm:grid-cols-4` override is the pattern already used for compact badge and
   * summary rows, and two columns at 375px is roughly 180px each — narrow, but a
   * layout rather than a crush. Three is where fields stop being usable.
   *
   * An **arbitrary** value (`grid-cols-[…]`) is never safe unprefixed: its track
   * list is written in absolute units, which is exactly how the builder's
   * `minmax(12rem,18rem)` sidebar crushed the editor beside it.
   */
  const PHONE_SAFE = new Set(['1', '2']);

  /**
   * Every string literal in a file — quoted, single-quoted or a template chunk.
   *
   * 🔴 **Not `className="…"`.** That idiom, used by the assertions above, sees
   * only a literal attribute: `className={cn('grid grid-cols-7', x)}` and
   * `className={`grid-cols-${n}`}` are both invisible to it. This repository has
   * **43** dynamic `className={…}` sites and a `cn()` helper, and a preview
   * computing its own responsive classes (M21.2) is the most likely place for
   * the next one.
   *
   * ⚠️ **Wider, and measured to cost nothing**: run across every `.tsx` in
   * `src`, this produced **zero** findings on correct code, so it adds reach
   * without adding false alarms. Matching each wrapper shape — `cn`, arrays,
   * ternaries, `buttonVariants` — would be brittle in a way this is not.
   */
  const stringLiterals = (source: string): string[] =>
    source.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? [];

  it.each(LAYOUT_FILES.map((path) => [label(path), path] as const))(
    '%s gives a phone at most two columns',
    (_name, path) => {
      const classLists = stringLiterals(code(path));

      for (const className of classLists) {
        const unprefixed = UNPREFIXED_GRID.exec(className);

        if (unprefixed === null) {
          /* Every grid rule is behind a breakpoint: the phone gets one column. */
          continue;
        }

        expect(
          PHONE_SAFE.has(unprefixed[1]),
          `${className} applies ${unprefixed[1]} columns at every width, phones included`,
        ).toBe(true);
      }
    },
  );

  it('still sees the builder’s own pane grid', () => {
    /*
     * The floor. A regex that matched nothing would pass every file above, and
     * the editor's `md:grid-cols-[minmax(12rem,18rem)_1fr]` is the grid this
     * guard was written for — if it stops being found, the pattern is wrong
     * rather than the code.
     */
    const source = code(join(process.cwd(), 'src/app/(app)/option-sets/[id]/page.tsx'));
    const columned = (source.match(/className="[^"]*"/g) ?? []).filter((c) =>
      /\bgrid-cols-/.test(c),
    );

    expect(columned.length, 'the builder should define its pane grid').toBeGreaterThan(0);
  });
});

describe('unbounded merchant text', () => {
  /*
   * ✏️ **`product-picker.tsx` was here until M19.1'.** Its one row rendering
   * merchant text — `AssignedRow` — moved into `product-display.tsx`, where the
   * other shared rows live, so the picker no longer renders unbounded text
   * directly and has nothing for this guard to check. Removed rather than left
   * failing: a guard listing a file that cannot satisfy it teaches the next
   * reader to edit the list, which is exactly the habit it exists to prevent.
   * The rule still covers the markup — it just covers it where it now lives.
   */
  const UNBOUNDED = [
    join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'),
    join(process.cwd(), 'src/components/products/product-display.tsx'),
  ];

  it.each(UNBOUNDED.map((p) => [p.slice(process.cwd().length + 1), p]))(
    '%s truncates inside a shrinkable column',
    (_name, path) => {
      const source = code(path);

      /* Asserted inside a className, so a comment mentioning them cannot pass. */
      expect(source).toMatch(/className="[^"]*\bmin-w-0\b/);
      expect(source).toMatch(/className="[^"]*\btruncate\b/);

      /**
       * 🔴 **Counted, not merely present — a survivor proved why.** Presence
       * alone passes a file whose *second* row forgot `min-w-0`, because the
       * first row's satisfies the match. That became reachable at M19.1', when
       * `AssignedRow` joined `ProductRow` in this module: deleting
       * `AssignedRow`'s `min-w-0` left the guard green, verified by mutation.
       *
       * A truncating line is only shrinkable if an ancestor column says so, and
       * each row here has exactly one such column. So: **at least one `min-w-0`
       * wrapper per `<li>` that truncates.** Counting rows rather than
       * truncating lines is what makes the assertion stable — `ProductRow`
       * truncates twice inside one column, and that is correct.
       */
      /*
       * Scanned per **component**, not per `<li>`: the option-sets screen puts
       * its row inside one component and the truncating column inside another,
       * so an `<li>` scan skips it entirely — a survivor proved that too. A
       * `function Name(` boundary is where JSX for one row begins and ends.
       */
      const components = source.split(/\n(?=(?:export\s+)?function\s)/);

      for (const component of components) {
        if (!/className="[^"]*\btruncate\b/.test(component)) {
          continue;
        }

        expect(component).toMatch(/className="[^"]*\bmin-w-0\b/);
      }
    },
  );
});

/**
 * Two controls must not answer to one accessible name.
 *
 * 🔴 **Found while writing the M19.1' E2E, not by reading the markup.** The
 * assignment form's `<label>` named the target-type select and the reference
 * input's `aria-label` repeated the same phrase, so `getByLabel(...)` matched
 * both — Playwright fails such a locator rather than guessing, and a screen
 * reader announces two different fields as the same thing.
 */
describe('assignment form labelling', () => {
  const source = code(join(process.cwd(), 'src/components/products/product-picker.tsx'));

  it('does not give the reference input the select’s name', () => {
    const selectLabel = /Or assign by category, tag, attribute or price range/;
    const ariaLabels = source.match(/aria-label="([^"]*)"/g) ?? [];

    for (const label of ariaLabels) {
      expect(selectLabel.test(label)).toBe(false);
    }
  });

  it('still labels the reference input', () => {
    expect(source).toMatch(/aria-label="[^"]+"/);
  });
});

/**
 * Every `<label>` names a control.
 *
 * 🔴 **Found by a failing E2E, not by a guard — which is why this exists.** The
 * option-set authoring page and the shared auth `Field` both rendered
 * `<label className="…">Text</label>` with nothing bound to them. A screen
 * reader announced those inputs as unlabelled, and clicking the label text did
 * not focus the field.
 *
 * It also left the canonical E2E with only `getByPlaceholder` to address them —
 * example copy that changes whenever a writer picks a friendlier word. That is
 * exactly how the canonical suite came to time out for five stages against
 * placeholders (`finish`/`Finish`) the page had **never** rendered.
 *
 * ⚠️ **A wrapping label is fine and is not counted.** `<label>` with the input
 * nested inside associates implicitly — valid HTML, and the pattern the
 * checkbox rows here already use. Only a label that *opens and closes around
 * plain text* needs `htmlFor`.
 */
describe('labelled controls', () => {
  const FORMS = [
    join(process.cwd(), 'src/app/(app)/option-sets/[id]/page.tsx'),
    join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'),
    join(process.cwd(), 'src/components/forms/auth-form.tsx'),
    join(process.cwd(), 'src/components/products/product-picker.tsx'),
  ];

  it.each(FORMS.map((p) => [p.slice(process.cwd().length + 1), p]))(
    '%s binds every text-only label to a control',
    (_name, path) => {
      const source = code(path);

      /*
       * A label whose content is plain text — no `<` inside — wraps nothing, so
       * it must carry `htmlFor`. One containing an element is the implicit-
       * association form and is left alone.
       */
      const textOnly = (source.match(/<label\b[^>]*>[^<]*<\/label>/g) ?? []).filter(
        (label) => !/\bhtmlFor\b/.test(label),
      );

      expect(textOnly).toEqual([]);
    },
  );
});

/**
 * Every empty state teaches, and offers a way out (M20b.5).
 *
 * 🔴 **This guard exists because a screen was missed by eye.** M20b.5's audit
 * enumerated "every list screen" by reading the directory and found three; there
 * are four, and the fourth — the option-set editor — carried an empty state
 * reading *"Add one to begin"* with nothing to click, on the merchant's first
 * view of a set they had just created.
 *
 * ## Two earlier versions proved nothing
 *
 * ✏️ **First it searched the whole page** for `href="/` or `onClick={` — which
 * every one of these screens contains many times over. Deleting the editor's
 * empty-state button left it green.
 *
 * ✏️ **Then it searched 1,200 characters from the marker**, which on the
 * products screen ran past the empty state and matched the **"Load more"
 * pagination button** 402 characters later. Deleting that screen's real action
 * left it green too.
 *
 * Both failures had the same shape: a window wide enough to catch something
 * unrelated. So the expression is now extracted by **balancing braces** — the
 * exact `empty={…}` the screen passes, and nothing after it.
 */
const EMPTY_MARKERS = ['empty=', 'groups.length === 0 ?'] as const;

/**
 * The `{…}` expression beginning at `from`, balanced rather than truncated.
 *
 * A character count cannot know where a prop ends; brace depth can.
 */
function balanced(source: string, from: number): string {
  const open = source.indexOf('{', from);

  if (open === -1) {
    return '';
  }

  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;

      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }

  return '';
}

/**
 * Empty states that legitimately offer nothing, each for a recorded reason.
 *
 * ⚠️ **Named individually, so an exemption is a decision rather than a gap.**
 * Both are cases where the merchant cannot act, and a button would promise
 * something the system cannot do.
 */
const NO_ACTION_BY_DESIGN: Readonly<Record<string, string>> = {
  /* ADR-091: a catalogue sync is store-realm and cannot be triggered here. */
  EmptyCatalogue: 'the plugin pushes the catalogue; the dashboard cannot ask it to',
  /* A version list before the first publish — publishing is the action, and its
   * panel sits directly beside this one.
   *
   * ⚠️ **This exempts that screen's `empty={…}` only.** The editor carries a
   * *second* empty state — the no-groups notice — which must have an action and
   * is asserted separately below. An earlier version of this map keyed on the
   * path and so excused both; deleting the no-groups button passed. */
  'option-sets/[id]': 'publishing is the action, and its panel sits beside this list',
};

describe('every list screen’s empty state offers an action', () => {
  const lists = ALL.filter((path) => /<AsyncState/.test(code(path)));

  it('finds the list screens', () => {
    // stores, products, option-sets, and the option-set editor.
    expect(lists.length).toBeGreaterThanOrEqual(4);
  });

  it.each(lists.map((path) => [label(path), path]))(
    '%s offers something to click when empty, or delegates to a component that does',
    (name, path) => {
      const source = code(path);
      const marker = EMPTY_MARKERS.map((m) => source.indexOf(m)).find((i) => i > -1);

      expect(marker).toBeGreaterThan(-1);

      const expression = balanced(source, marker as number);
      expect(expression).not.toBe('');

      /*
       * A screen may delegate its empty state to a component — `EmptyCatalogue`
       * does — so a bare component reference is followed rather than failed, and
       * the component answers for itself.
       */
      const delegate = /^\{\s*<([A-Z][A-Za-z0-9]*)[^>]*\/>\s*\}$/.exec(expression.trim());
      const exempt =
        Object.keys(NO_ACTION_BY_DESIGN).some((key) => name.includes(key)) ||
        (delegate !== null && delegate[1] in NO_ACTION_BY_DESIGN);

      if (exempt) {
        return;
      }

      expect(expression).toMatch(/action=\{|href="\/|onClick=\{|<Button/);
    },
  );

  /**
   * 🔴 **The editor's no-groups notice**, which is not an `empty={…}` prop and so
   * is not reached by the case above — and is the empty state M20b.5's audit
   * missed entirely. It greets a merchant on their first view of a set they have
   * just created, and read *"Add one to begin"* with nothing to click.
   */
  it('offers a way to add the first group', () => {
    const source = code(join(APP, '(app)/option-sets/[id]/page.tsx'));
    const notice = source.slice(source.indexOf('set.groups.length === 0 ?'));

    expect(notice.slice(0, notice.indexOf('</Alert>'))).toMatch(/<Button/);
  });

  /**
   * 🔴 **The branch shown when no store is connected at all**, which is a
   * different construct from the list's own empty state and was the one that
   * both misinformed (ADR-067) and offered nothing.
   */
  it('offers a way to connect a store when none is connected', () => {
    const source = code(join(APP, '(app)/products/page.tsx'));
    const branch = source.slice(source.indexOf('Connect a store first'));

    expect(branch.slice(0, branch.indexOf('</Alert>'))).toMatch(/href="\/install"/);
  });

  /**
   * 🔴 **The direction of the catalogue sync, written backwards twice.**
   * ADR-067 inverted it: the store **pushes** its products, because the cloud
   * holds no WooCommerce credentials and AC8 forbids it holding any.
   *
   * ✏️ **Pages alone were not enough.** The first version of this iterated
   * `ALL` — `src/app` only — while the copy lives in `src/components`:
   * reintroducing the exact phrase into `EmptyCatalogue`, whose own docblock
   * records fixing it, passed. Every source file is read now.
   */
  it.each(sourceFiles().map((path) => [path.slice(process.cwd().length + 1), path]))(
    '%s never tells a merchant that Optionia imports their products',
    (_name, path) => {
      expect(code(path)).not.toMatch(/imported from WooCommerce|Optionia imports/i);
    },
  );
});
