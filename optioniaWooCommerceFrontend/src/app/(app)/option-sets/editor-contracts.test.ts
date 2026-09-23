import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The option-set editor's load-bearing calls, asserted rather than assumed.
 *
 * ## Why this file exists
 *
 * `option-sets/[id]/page.tsx` is **1,997 lines** and performs **sixteen**
 * distinct writes — creating and deleting groups, options, values and items,
 * reordering three of them, publishing, and the pre-publish check. Until this
 * file, the only test touching it asserted that text-only `<label>`s carry
 * `htmlFor`. Nothing asserted that any of those writes still happened.
 *
 * 🔴 **Measured, not feared.** Rewriting one mutation so it never reaches the
 * API —
 *
 * ```ts
 * mutationFn: () => Promise.resolve() ?? deleteValue(id)
 * ```
 *
 * — compiles cleanly and leaves **571 tests passing**. A merchant's delete
 * button would appear to work and change nothing. Phase 20 decomposes this file
 * into a three-pane builder; that refactor is exactly where a call gets dropped
 * while moving, and this is what makes such a drop fail.
 *
 * ## Why source-reading rather than rendering
 *
 * The page is `'use client'` and depends on `useParams`, React Query and a
 * session provider, so mounting it needs a renderer this repository does not
 * have (`@testing-library/react` is not a dependency) plus four provider
 * wrappers. A source contract costs nothing, needs no dependency, and protects
 * the refactor **today** — which is worth more than a better test that arrives
 * after the code has moved.
 *
 * ⚠️ It is weaker than a render test and stronger than the nothing that let the
 * mutation above survive. When a renderer is added — 20-1d, if M20.10 earns it
 * — these assertions move into it rather than being deleted.
 *
 * ## What this CANNOT see, stated so it is not mistaken for coverage
 *
 * 🔴 **A call that exists but no merchant can reach passes every assertion
 * here.** Measured: making `RemoveValue` return `null` — so the delete control
 * renders **nothing** and `deleteValue` is unreachable — is clean under `tsc`,
 * passes all of these, and passes the full **612**-test suite. A merchant would
 * see no delete button at all.
 *
 * That is the boundary of reading source: it proves a call is *wired*, never
 * that it is *reachable*. Only a real renderer can close it, and pretending
 * otherwise is worse than the gap — a guard trusted past its range is how the
 * next defect ships green.
 */
/**
 * Every file the editor's writes may live in.
 *
 * 🔴 **A file SET, not one file — and the first draft got this wrong.** The
 * contract existed to protect the Phase 20 decomposition, and it was pinned to
 * `page.tsx` alone. Decomposition *moves code out of that file*, so a correct
 * extraction failed the guard with **exactly the same three failures** as
 * deleting the call outright — measured both ways, identical test names. A
 * guard that cannot tell correct work from a defect teaches the next reader to
 * edit the guard, which is how it stops guarding.
 *
 * ⚠️ **And the narrow scope hid five real writes.** `updateGroup` (twice),
 * `createRule`, `deleteRule` and `updateRule` live in sibling components and
 * were covered by nothing: neutering `deleteRule` the same way compiled
 * cleanly and left **612 tests passing**.
 *
 * Reading the directory rather than listing files means a component extracted
 * in 20-2 is covered the moment it exists, without anyone remembering to add
 * it.
 */
const EDITOR_FILES = [
  join(process.cwd(), 'src/app/(app)/option-sets/[id]/page.tsx'),
  ...sourcesUnder(join(process.cwd(), 'src/components/option-sets')),
];

/**
 * Every component file under a directory, **including subdirectories**.
 *
 * 🔴 **Non-recursive was a hole exactly where 20-2 steps.** A three-pane split
 * naturally creates `panes/` or `forms/`, and a flat `readdirSync` cannot see
 * them. Proven: a neutered `deleteRule` in `rules-panel.tsx` was caught, while
 * a copy placed in `option-sets/panes/` was **invisible** — so a write moved
 * wholly into a subdirectory would leave coverage silently, with the suite
 * green.
 *
 * ⚠️ Test files are excluded on purpose. A contract that read its own
 * assertions would find every call name it looks for, in itself.
 */
function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourcesUnder(full);
    }

    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [full] : [];
  });
}

/** The editor's source, comments stripped, as one body of text. */
const editorCode = (): string => EDITOR_FILES.map((file) => code(file)).join('\n');

/**
 * Source with comments stripped, so prose *about* a call cannot satisfy the
 * assertion that the call exists. The same helper `state-contracts.test.ts`
 * uses, and for the same reason: this file's docblocks name every operation it
 * guards, so an un-stripped read would pass against a page that called none of
 * them.
 */
const code = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

/**
 * Every write the editor performs, by the API function that performs it.
 *
 * 📌 **`reorderPayloads` is deliberately absent.** It is a local helper from
 * `lib/option-sets/entries`, already covered by `entries.test.ts` — listing it
 * here would guard arithmetic twice and the network not at all.
 */
const WRITES = [
  'createGroup',
  'createOption',
  'createValue',
  'createItem',
  'createRule',
  'updateGroup',
  'updateOption',
  'updateValue',
  'updateItem',
  'updateRule',
  'deleteGroup',
  'deleteOption',
  'deleteValue',
  'deleteItem',
  'deleteRule',
  'reorderGroups',
  'reorderOptions',
  'reorderItems',
  'publishSet',
  'publishCheck',
] as const;

describe('option-set editor', () => {
  /**
   * 🔴 **The call must be what the mutation RETURNS, not merely present.**
   *
   * A first draft asserted only that `fn(` appeared somewhere, and the mutant
   * this file was written against survived it:
   *
   * ```ts
   * mutationFn: () => Promise.resolve() ?? deleteValue(id)
   * ```
   *
   * The name is still there; the request never happens. So the assertion
   * anchors on `mutationFn:` and allows only whitespace, an `async`, an arrow
   * and its parameter list between that and the call — `await` included, since
   * several handlers use it. Anything else between them is something standing
   * *in front of* the network, which is precisely the defect.
   */
  it.each(WRITES)('returns %s from the mutation that owns it', (fn) => {
    const source = editorCode();

    /* `publishCheck` is a query, not a mutation — asserted on `queryFn` below. */
    const key = fn === 'publishCheck' ? 'queryFn' : 'mutationFn';

    /*
     * Two shapes, both real in this file:
     *   concise — `mutationFn: () => deleteGroup(id)`
     *   block   — `mutationFn: async () => { … return createValue(…) }`
     *             `mutationFn: async () => { … await reorderGroups(…) }`
     *
     * The block form is matched by requiring `return` or `await` immediately
     * before the call, which is what makes the call the mutation's *result*
     * rather than a bystander. `Promise.resolve() ?? deleteValue(id)` satisfies
     * neither.
     */
    const concise = new RegExp(
      `${key}:\\s*(async\\s*)?\\([^)]*\\)\\s*=>\\s*(await\\s+)?${fn}\\s*\\(`,
    );

    const block = new RegExp(`(return|await)\\s+${fn}\\s*\\(`);

    /*
     * 🔴 **Checked PER FILE, because one satisfied call site was covering
     * another.** `updateGroup` is called from both `group-description` and
     * `group-layout`; neutering one of them still matched against the joined
     * source, and the mutant survived — measured. Every file that mentions the
     * call must bind it, so two call sites need two correct ones.
     */
    const owners = EDITOR_FILES.filter((file) =>
      new RegExp(`\\b${fn}\\s*\\(`).test(code(file)),
    );

    expect(owners.length, `${fn} is called somewhere`).toBeGreaterThan(0);

    for (const file of owners) {
      const own = code(file);

      expect(
        concise.test(own) || block.test(own),
        `${fn} in ${file.split('/').pop()} must be what its mutation returns`,
      ).toBe(true);
    }

    expect(concise.test(source) || block.test(source)).toBe(true);
  });

  /**
   * 🔴 **Imported as well as called.** A refactor that moves a call into an
   * extracted component leaves the name behind in a stale import, or leaves the
   * import behind with no call — and the per-call assertions above would pass on
   * a lingering mention either way.
   */
  it.each(WRITES)('still imports %s', (fn) => {
    const imports = editorCode().match(/import\s*\{[\s\S]*?\}\s*from[^\n]*/g) ?? [];

    expect(imports.join('\n')).toMatch(new RegExp(`\\b${fn}\\b`));
  });

  /**
   * ⚠️ **The count is asserted, so an operation ADDED without a guard fails
   * here.** A list that only checks what it already knows about goes stale on
   * the first new mutation — silently, which is the failure mode this whole
   * file exists to answer.
   */
  it('performs exactly the writes this contract knows about', () => {
    const source = editorCode();

    const called = (source.match(/\b(create|update|delete|reorder|publish)[A-Z][A-Za-z]*\s*\(/g) ?? [])
      .map((match) => match.replace(/\s*\($/, ''))
      /*
       * Local helpers, tested where they live — see the note on WRITES.
       *
       * 📌 **`publishGate` is a pure decision, not a request.** It matches the
       * `publish[A-Z]` shape this regex looks for and performs no network call
       * at all; listing it in `WRITES` would assert a `mutationFn` that cannot
       * exist. Its own tests kill the mutations that matter, and the wiring is
       * asserted by `publishing consults its gate` below.
       */
      .filter((name) => name !== 'reorderPayloads' && name !== 'publishGate');

    expect([...new Set(called)].sort()).toEqual([...WRITES].sort());
  });
});

/**
 * Every cache patch must be observed by a test.
 *
 * 🔴 **Four `onSuccess` patches were untested, and deleting any of them passed
 * all 1,236 tests** (M290–M293). The dashboard patches rather than refetching
 * (M20.10's groundwork), so the patch callback **is** the update — there is no
 * refetch behind it to cover a missing one. A merchant clicked Disable, the
 * server wrote it, and the screen did not change.
 *
 * ⚠️ **Each was added later than its neighbours**, one milestone at a time:
 * `ValueRow`'s own save had the assertion from the start, and the four that
 * followed did not. A list that grows without its guard growing is how this
 * recurs.
 *
 * 📌 **Asserted on the TEST files, not the editor.** The editor's patches are
 * already found by the contract above; what goes missing is the *test*, so that
 * is what this counts.
 */
describe('every cache patch is asserted somewhere', () => {
  const editorDir = join(process.cwd(), 'src/app/(app)/option-sets');

  const testSources = readdirSync(editorDir)
    .filter((entry) => entry.includes('.test.'))
    .map((entry) => readFileSync(join(editorDir, entry), 'utf8'))
    .join('\n');

  /**
   * Every patched entity kind must have an assertion naming it.
   *
   * 🔴 **A count with slack is not a guard.** The first version compared a
   * total of `.mock.calls` occurrences against a total of patches — 23 against
   * 4 — so removing an assertion changed nothing and a mutant survived (M294).
   * `toBeGreaterThanOrEqual` over unrelated matches measures almost nothing.
   *
   * ⚠️ **So it checks each KIND the editor patches** — `option`, `group`,
   * `value`, `item` — and requires an assertion reading that spy's recorded
   * call. A kind patched with nothing asserting it fails by name.
   */
  it('asserts every entity kind the editor patches', () => {
    const source = editorCode();

    const patched = new Set(
      [...source.matchAll(/onSuccess: patch\.(option|group|value|item)\b/g)].map(
        (match) => match[1] as string,
      ),
    );

    /* `onPatched` is the same callback one layer down, where a child component
     * takes it as its own prop — so a test asserts it under that name. */
    if (/onSuccess: onPatched\b/.test(source)) {
      patched.add('onPatched');
    }

    const unasserted = [...patched].filter((kind) => {
      const spy = kind === 'onPatched' ? 'onPatched' : `patch.${kind}`;

      return !testSources.includes(`${spy}.mock.calls`);
    });

    expect(unasserted).toEqual([]);
  });
});

/**
 * The empty-state button and the field it focuses agree (M20b.5).
 *
 * 🔴 **A mismatch here fails silently.** `getElementById` returns null, the
 * `?.scrollIntoView` and `?.focus` are optional-chained, and the button becomes a
 * no-op — no error, no console warning, and an empty state that once again
 * instructs an action it does not perform.
 *
 * The two references are **216 lines apart** in a four-thousand-line file, which
 * is exactly the distance at which a rename goes unnoticed.
 */
describe('the add-group field id is shared, not repeated', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/[id]/page.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

  it('declares the id once', () => {
    const literals = source.match(/'new-group-label'/g) ?? [];

    // The constant's own definition, and nothing else.
    expect(literals).toHaveLength(1);
    expect(source).toMatch(/const NEW_GROUP_FIELD_ID = 'new-group-label';/);
  });

  /** The button, the label's `htmlFor` and the input's `id` all use it. */
  it('uses that constant everywhere the id is needed', () => {
    expect(source).toMatch(/getElementById\(NEW_GROUP_FIELD_ID\)/);
    expect(source).toMatch(/htmlFor=\{NEW_GROUP_FIELD_ID\}/);
    expect(source).toMatch(/id=\{NEW_GROUP_FIELD_ID\}/);
  });
});


/**
 * The preview column and the frame inside it agree about width (F55).
 *
 * 🔴 **This is the guard that would have caught F55 before the audit did.** I
 * put a frame offering phone (23.4rem), tablet (46rem) and desktop (100%)
 * into a fixed **24rem** column. Tablet overflowed by 22rem; desktop clamped
 * to the column while its button still said *Desktop*. Every test passed —
 * because every test asserted which buttons rendered, and none asserted that
 * the rendered width fit the space it rendered into.
 *
 * ⚠️ **Resizing is the feature, not decoration.** The storefront ships zero
 * `@media` queries (ADR-108): the preview is a frame the merchant resizes
 * around markup that is intrinsically responsive. So the answer was never to
 * drop the wider widths — it was to dock the column to the one width that
 * fits and give the other two a full-width dialog. Both halves of that are
 * asserted here; neither is safe alone.
 *
 * 📌 **Arithmetic, not a snapshot.** The column width and the preset widths
 * are parsed from source and compared, so changing either one to a value that
 * no longer fits fails here rather than in a merchant's browser. A snapshot
 * would have re-blessed F55 the moment I updated it.
 *
 * What this cannot see, stated plainly: it reads Tailwind classes as text and
 * cannot know what a browser computes. Padding, borders and scrollbars are
 * outside its range. It catches the order-of-magnitude mistake — a 46rem frame
 * in a 24rem column — and nothing subtler.
 */
describe('the docked preview fits its column', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/[id]/page.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

  const previewSource = readFileSync(
    join(process.cwd(), 'src/components/option-sets/set-preview.tsx'),
    'utf8',
  );

  /** The `24rem` out of `lg:grid-cols-[minmax(0,1fr)_24rem]`. */
  const columnRem = (() => {
    const match = source.match(/lg:grid-cols-\[minmax\(0,1fr\)_([\d.]+)rem\]/);

    expect(match, 'the editor no longer declares a fixed preview column').not.toBeNull();

    return Number(match![1]);
  })();

  /** Every preset the frame can render at, in rem; `100%` is not a rem value. */
  const presets = Object.fromEntries(
    [...previewSource.matchAll(/^ {2}(\w+): '([\d.]+)rem',$/gm)].map(([, name, rem]) => [
      name,
      Number(rem),
    ]),
  );

  it('parsed both sides, so a silent regex miss cannot pass this file', () => {
    expect(columnRem).toBeGreaterThan(0);
    expect(presets.phone).toBe(23.4);
    expect(presets.tablet).toBe(46);
  });

  /** The width a docked frame actually starts and stays at. */
  it('docks the column to a preset that fits it', () => {
    expect(source).toMatch(/<SetPreviewSection set=\{set\} docked \/>/);
    expect(presets.phone).toBeLessThanOrEqual(columnRem);
  });

  /**
   * 🔴 The inverse, so this file states *why* the dock is needed. If someone
   * widens the column to 46rem+, this fails and the dock should be revisited —
   * a guard that only ever agrees with today's numbers teaches nothing.
   */
  it('records that the wider presets are the ones that do not fit', () => {
    expect(presets.tablet).toBeGreaterThan(columnRem);
  });

  /**
   * The escape hatch the docked picker's sentence promises. An undocked
   * `SetPreviewSection` inside the dialog is what restores tablet and desktop.
   */
  it('keeps the wider presets reachable through the full-width dialog', () => {
    const dialog = source.slice(source.indexOf('<DialogContent'));

    expect(source).toContain('Open full width');
    expect(dialog).toMatch(/<SetPreviewSection set=\{set\} \/>/);
  });
});

/**
 * The publish button is wired to the gate that decides whether it may fire.
 *
 * 🔴 **`publishGate` being correct is not the same as the button using it.**
 * Its own tests kill a mutation that makes blockers stop blocking — but a
 * button that never consults the gate publishes a broken set to a live
 * storefront past a suite that is entirely green, because every assertion is
 * about a function nobody called. Measured before this existed: dropping
 * `blocked` from the `disabled` expression failed only the write-inventory
 * check, and only incidentally — because it left `isLoading` unused, not
 * because anything noticed the gate was gone.
 *
 * ⚠️ **Source-reading, with the limits `editor-contracts` already states.**
 * The action needs React Query and a session, so a render test costs a mount
 * this file does not have. This proves the wiring, never that a merchant can
 * reach the button — the boundary recorded at the top of this file.
 */
describe('publishing consults its gate', () => {
  const source = editorCode();

  /** The gate is the source of the decision, not a second inline filter. */
  it('derives the decision from publishGate', () => {
    expect(source).toMatch(/publishGate\(/);
  });

  /**
   * 🔴 The button's `disabled` must include `blocked`. Anything that publishes
   * while the gate says blocked is the defect this guard exists for.
   */
  it('disables the publish button while the gate blocks', () => {
    expect(source).toMatch(/disabled=\{blocked \|\|/);
  });

  /**
   * 📌 **And the findings must still render somewhere.** A count beside a
   * disabled button tells a merchant how many things are wrong and not what
   * they are; `FindingList` is what answers that, and moving the button must
   * not have taken the explanation with it.
   */
  it('still lists the findings in full', () => {
    expect(source).toMatch(/<FindingList findings=\{blockers\}/);
    expect(source).toMatch(/<FindingList findings=\{warnings\}/);
  });
});
