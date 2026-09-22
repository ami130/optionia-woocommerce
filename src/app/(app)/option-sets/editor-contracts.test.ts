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
      /* A local helper, tested where it lives — see the note on WRITES. */
      .filter((name) => name !== 'reorderPayloads');

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

