import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { AuthoringSet } from './api';
import {
  invalidateAfterEdit,
  invalidateAfterPublish,
  optionSetKeys,
  patchTree,
  replaceGroupInTree,
  replaceItemInTree,
  replaceOptionInTree,
  replaceValueInTree,
} from './cache';

/**
 * What an edit refreshes, asserted against a real cache.
 *
 * 🔴 **Measured before this existed: one edit invalidated FOUR queries.** The
 * tree, the publish-check, the published history and the draft-versus-live
 * comparison — the last of which is two full-document fetches on its own. Five
 * HTTP requests, three of them whole documents, because a merchant renamed a
 * label.
 */
const seed = (client: QueryClient, setId: string) => {
  client.setQueryData(optionSetKeys.tree(setId), { seeded: true });
  client.setQueryData(optionSetKeys.publishCheck(setId), { seeded: true });
  client.setQueryData(optionSetKeys.unpublished(setId, 3), { seeded: true });
  client.setQueryData(optionSetKeys.versions(setId, 3), { seeded: true });

  /*
   * ⚠️ **`version` is the lock token; `versions` is the published history.**
   * One character apart and unrelated — and this helper seeded only the
   * second, so a test asserting the token was refetched read an empty list and
   * failed no matter what the code did. Both are cached by the editor, so both
   * belong here.
   */
  client.setQueryData(optionSetKeys.version(setId), 3);
};

const invalidated = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.isInvalidated)
    .map((query) => query.queryKey.join('/'))
    .sort();

describe('invalidateAfterEdit', () => {
  it('refreshes the tree', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    invalidateAfterEdit(client, 's1');
    await Promise.resolve();

    expect(invalidated(client)).toContain('option-set/s1');
  });

  /**
   * 🔴 **The published history cannot change because a label was edited.**
   * Refetching it was pure waste — and it is the assertion that fails if the
   * `exact: true` is ever dropped and the prefix takes its siblings again.
   */
  it('leaves the published history alone', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    invalidateAfterEdit(client, 's1');
    await Promise.resolve();

    expect(invalidated(client)).not.toContain('option-set/s1/versions/3');
  });

  /**
   * 🔴 **It MUST refresh, and this test asserted the opposite (F73).**
   *
   * The original read *"leaves the publish check alone"*, because the findings
   * *"re-run when opened"* — true while publishing lived in a panel below the
   * product picker. Since the button moved into the header (F58) the check runs
   * on mount and nothing is ever opened, so the answer survived every edit that
   * changed it.
   *
   * ⚠️ **The test held the same expired assumption as the source it guarded**,
   * so it protected the defect rather than catching it: a merchant added their
   * first option, saw it on screen, and the header still read *"1 thing to
   * fix"* over a blocker saying the set had *"no enabled options or content"*.
   * Measured by walking the flow as a new merchant.
   */
  it('refreshes the publish check, which an edit can change', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    invalidateAfterEdit(client, 's1');
    await Promise.resolve();

    expect(invalidated(client)).toContain('option-set/s1/publish-check');
  });

  /**
   * ⚠️ **The one sibling that MUST refresh.** An edit is precisely what makes a
   * published set differ from its draft, so the *"still serving version N"*
   * notice would otherwise be stale in the one direction that matters.
   */
  it('refreshes the draft-versus-live comparison', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    invalidateAfterEdit(client, 's1');
    await Promise.resolve();

    expect(invalidated(client)).toContain('option-set/s1/unpublished/3');
  });

  it('touches nothing belonging to another set', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    seed(client, 'other');
    invalidateAfterEdit(client, 's1');
    await Promise.resolve();

    expect(invalidated(client).filter((key) => key.includes('other'))).toEqual([]);
  });

  /**
   * 🔴 **A create advances `rowVersion` too, and this did not refetch it (F79).**
   *
   * `patchTree` — the path for edits *in place* — refetches the version, with
   * the reasoning recorded there: *"every child edit advances the parent set's
   * `rowVersion` server-side"*. **Every** edit, not only in-place ones. This
   * function serves every create, delete and reorder, and left the token at
   * whatever the page loaded with.
   *
   * ⚠️ **Measured end to end**: a merchant adds two values to a dropdown and
   * presses Publish 131ms later; the API answers **409** and the editor says
   * *"Someone else changed this"* — naming a conflict they caused themselves,
   * alone, in a set they had just built.
   */
  it('refreshes the row version, which every create advances', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    invalidateAfterEdit(client, 's1');
    await Promise.resolve();

    expect(invalidated(client)).toContain('option-set/s1/row-version');
  });

  /**
   * The count is the headline: **three**, where it used to be four, and where a
   * naive prefix invalidation would take everything.
   *
   * ✏️ **It was two until F73.** The publish-check was deliberately excluded on
   * the grounds that it *"re-runs when the publish panel is opened"* — which
   * stopped being true when the button moved into the header. Three is the
   * honest number: the tree, the draft-versus-live diff, and the findings that
   * decide whether the header may offer to publish at all.
   *
   * 📌 **The guard is still worth keeping.** Its job is to fail when someone
   * drops `exact: true` and the prefix quietly takes the published history with
   * it — a regression that costs a whole document fetch per keystroke.
   */
  it('invalidates four queries, not the whole prefix', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    invalidateAfterEdit(client, 's1');
    await Promise.resolve();

    /*
     * ✏️ Two, then three (F73's publish-check), now **four** — the lock token
     * an edit advances (F79). Each rise is a sibling whose answer an edit
     * genuinely changes; the published history is still left alone, which is
     * what this count exists to prove.
     */
    expect(invalidated(client)).toHaveLength(4);
  });
});

describe('invalidateAfterPublish', () => {
  /**
   * 📌 **Broad on purpose, and correct here.** A publish moves the version,
   * writes history and settles the draft-versus-live question — and it happens
   * once, not once per keystroke.
   */
  it('refreshes everything about the set', async () => {
    const client = new QueryClient();

    seed(client, 's1');
    invalidateAfterPublish(client, 's1');
    await Promise.resolve();

    /*
     * ✏️ **Five, not four** — the seed now includes the row-version key the
     * editor really caches (F79). A publish invalidates the whole set prefix
     * deliberately: it moves the version, writes a history row and settles the
     * draft-versus-live question, so everything about the set has changed.
     */
    expect(invalidated(client)).toHaveLength(5);
  });
});

/** A two-group tree with one option and one value, enough to catch a wrong branch. */
const tree = (): AuthoringSet =>
  ({
    id: 'set-1',
    name: 'Set',
    groups: [
      {
        id: 'g1',
        label: 'Finish',
        options: [
          {
            id: 'o1',
            label: 'Colour',
            values: [{ id: 'v1', label: 'Red', priceAmountMinor: 500 }],
          },
        ],
        items: [{ id: 'i1', kind: 'heading', content: 'Pick a finish' }],
      },
      { id: 'g2', label: 'Size', options: [], items: [] },
    ],
  }) as unknown as AuthoringSet;

describe('replaceOptionInTree', () => {
  it('replaces the option that changed', () => {
    const next = replaceOptionInTree(tree(), { id: 'o1', label: 'Finish colour' } as never);

    expect(next.groups[0]?.options[0]?.label).toBe('Finish colour');
  });

  /**
   * 🔴 **Merged, not substituted.** The API answers with the fields it stores;
   * anything the tree holds that the response omits would otherwise vanish —
   * a value losing its price because a label was renamed.
   */
  it('keeps fields the response did not carry', () => {
    const next = replaceOptionInTree(tree(), { id: 'o1', label: 'X' } as never);

    expect(next.groups[0]?.options[0]?.values).toHaveLength(1);
  });

  it('leaves every other group alone', () => {
    const before = tree();
    const next = replaceOptionInTree(before, { id: 'o1', label: 'X' } as never);

    expect(next.groups[1]).toEqual(before.groups[1]);
  });

  /**
   * ⚠️ **A new object, or nothing re-renders.** React Query compares by
   * reference; editing the cached tree in place changes the data and updates
   * nothing on screen.
   */
  it('returns a new tree rather than mutating', () => {
    const before = tree();
    const next = replaceOptionInTree(before, { id: 'o1', label: 'X' } as never);

    expect(next).not.toBe(before);
    expect(before.groups[0]?.options[0]?.label).toBe('Colour');
  });

  it('changes nothing when the option is not in the tree', () => {
    const next = replaceOptionInTree(tree(), { id: 'absent', label: 'X' } as never);

    expect(next.groups[0]?.options[0]?.label).toBe('Colour');
  });
});

describe('replaceValueInTree', () => {
  it('replaces the value that changed', () => {
    const next = replaceValueInTree(tree(), { id: 'v1', label: 'Crimson' } as never);

    expect(next.groups[0]?.options[0]?.values[0]?.label).toBe('Crimson');
  });

  /** 🔴 The price survives a label edit — the merge, proven where it matters most. */
  it('keeps a price the response did not carry', () => {
    const next = replaceValueInTree(tree(), { id: 'v1', label: 'Crimson' } as never);

    expect(
      (next.groups[0]?.options[0]?.values[0] as { priceAmountMinor?: number }).priceAmountMinor,
    ).toBe(500);
  });
});

describe('replaceGroupInTree', () => {
  it('replaces the group that changed', () => {
    const next = replaceGroupInTree(tree(), { id: 'g2', label: 'Dimensions' } as never);

    expect(next.groups[1]?.label).toBe('Dimensions');
  });

  /** ⚠️ A group edit must not disturb the options hanging off it. */
  it('keeps the group’s options', () => {
    const next = replaceGroupInTree(tree(), { id: 'g1', label: 'Renamed' } as never);

    expect(next.groups[0]?.options).toHaveLength(1);
  });
});

/**
 * Writing a patched tree back into the cache.
 *
 * 🔴 **This is the half that actually saves the request.** `replace*InTree` are
 * pure and were proven in isolation above, but nothing called them: every edit
 * still invalidated and refetched. These tests pin the wiring — that a patch
 * lands in the cache, and that it does NOT also queue a refetch.
 */
describe('patchTree', () => {
  const cached = (client: QueryClient, setId: string) =>
    client.getQueryData(optionSetKeys.tree(setId)) as AuthoringSet | undefined;

  it('writes the patched tree into the cache', () => {
    const client = new QueryClient();
    client.setQueryData(optionSetKeys.tree('s1'), tree());

    patchTree(client, 's1', (set) =>
      replaceValueInTree(set, { id: 'v1', label: 'Patched' } as never),
    );

    expect(cached(client, 's1')?.groups[0]?.options[0]?.values[0]?.label).toBe('Patched');
  });

  /**
   * ⚠️ **The whole point.** A patch that also invalidated would cost the very
   * refetch it exists to avoid — and the test would still pass on the data,
   * because the refetch returns the same thing.
   */
  it('does not invalidate the tree', () => {
    const client = new QueryClient();
    client.setQueryData(optionSetKeys.tree('s1'), tree());

    patchTree(client, 's1', (set) =>
      replaceValueInTree(set, { id: 'v1', label: 'Patched' } as never),
    );

    expect(client.getQueryState(optionSetKeys.tree('s1'))?.isInvalidated).toBe(false);
  });

  /**
   * 🔴 **An in-place edit can change what may be published (F73).**
   * `isEnabled` is patched through here, so disabling the only option in a set
   * left the header still offering to publish something the API would refuse —
   * inviting a merchant to ship nothing. The mirror of the stale blocker: one
   * direction says the work is missing, this one says it is ready.
   */
  it('refreshes the publish check, which an in-place edit can change', async () => {
    const client = new QueryClient();

    /*
     * ⚠️ **Seeded before patched.** `invalidateQueries` marks queries that
     * exist; a key never fetched cannot be invalidated, so a test that only
     * seeds the tree reports an empty list and passes whatever the code does.
     */
    seed(client, 's1');
    client.setQueryData(optionSetKeys.tree('s1'), tree());

    patchTree(client, 's1', (set) =>
      replaceValueInTree(set, { id: 'v1', label: 'Patched' } as never),
    );
    await Promise.resolve();

    expect(invalidated(client)).toContain('option-set/s1/publish-check');
  });

  /**
   * 🔴 **An edit still makes the draft differ from what is published.** The
   * saved request is the tree; the draft-versus-live notice must still refresh,
   * or the "still serving version N" banner goes stale in the one direction a
   * merchant would notice.
   */
  it('still invalidates the draft-versus-live comparison', () => {
    const client = new QueryClient();
    client.setQueryData(optionSetKeys.tree('s1'), tree());
    client.setQueryData(optionSetKeys.unpublished('s1', 3), { seeded: true });

    patchTree(client, 's1', (set) => set);

    expect(client.getQueryState(optionSetKeys.unpublished('s1', 3))?.isInvalidated).toBe(true);
  });

  /**
   * ⚠️ **A cold cache must not be populated by a patch.** Patching an absent
   * tree would write a partial document the loader never produced; the next
   * read would treat that fragment as the whole set.
   */
  /**
   * ⚠️ **The patch must not run at all on a cold cache.**
   *
   * 🔴 An earlier version of this test asserted only that nothing was cached
   * afterwards — and a mutant that deleted the guard SURVIVED it. React Query
   * treats `setQueryData(key, undefined)` as a no-op and does not even create
   * the entry, so an identity patch produced the same observable outcome with
   * the guard gone. The test passed by coincidence.
   *
   * The real patches are `replace*InTree`, which dereference `set.groups` and
   * would throw on `undefined`. So this asserts what the guard actually buys:
   * the callback is never invoked when there is no tree to patch.
   */
  it('does not run the patch when the tree is not cached', () => {
    const client = new QueryClient();
    let ran = false;

    patchTree(client, 's1', (set) => {
      ran = true;

      return set;
    });

    expect(ran).toBe(false);
    expect(cached(client, 's1')).toBeUndefined();
  });

  /** 🔴 A realistic patch on a cold cache must not throw. */
  it('survives a cold cache with a patch that dereferences the tree', () => {
    const client = new QueryClient();

    expect(() =>
      patchTree(client, 's1', (set) =>
        replaceValueInTree(set, { id: 'v1', label: 'Patched' } as never),
      ),
    ).not.toThrow();
  });

  /** 📌 Reference identity is what React Query re-renders on. */
  it('writes a new object rather than mutating in place', () => {
    const client = new QueryClient();
    const before = tree();
    client.setQueryData(optionSetKeys.tree('s1'), before);

    patchTree(client, 's1', (set) =>
      replaceValueInTree(set, { id: 'v1', label: 'Patched' } as never),
    );

    expect(cached(client, 's1')).not.toBe(before);
  });
});

/**
 * 🔴 **`rowVersion` must not go stale when an edit is patched in.**
 *
 * The backend advances the *parent set's* `rowVersion` on every child edit —
 * `ParentSetService.touchForValue` / `touchForOption` / `touchSet`, at twelve
 * call sites. The edit response carries only the entity, not the new parent
 * version, so a patched tree keeps the version it loaded with.
 *
 * That token is sent by `publishSet` and `rollbackTo`, and
 * `assertVersionMatches` throws on a mismatch. Editing a value and then
 * publishing therefore answered **409 "This option set was changed by someone
 * else."** — naming a conflict the merchant caused themselves one second
 * earlier, recoverable only by reloading the page.
 *
 * ⚠️ Before the refetch was removed this could not happen: invalidating the
 * tree refetched it and brought back a fresh version. Cutting the refetch is
 * what exposed it, so the saved request has to be paid for here.
 */
describe('patchTree and rowVersion', () => {
  /**
   * 🔴 **The authoritative version is REFETCHED, never guessed.**
   *
   * Incrementing the cached number by one would usually be right and is the
   * wrong fix: if another editor saves concurrently, a guessed version can
   * coincidentally match the row and the write then succeeds — a **silent
   * overwrite**, which is the exact failure optimistic locking exists to
   * prevent. A false 409 annoys one merchant; a guess that lands loses another
   * merchant's work with no error at all.
   */
  it('refetches the set version rather than assuming it advanced by one', async () => {
    const client = new QueryClient();
    let fetches = 0;
    client.setQueryData(optionSetKeys.tree('s1'), { ...tree(), rowVersion: 7 });

    await client.prefetchQuery({
      queryKey: optionSetKeys.version('s1'),
      queryFn: () => {
        fetches += 1;

        return Promise.resolve(7);
      },
    });

    patchTree(client, 's1', (set) => set);

    expect(client.getQueryState(optionSetKeys.version('s1'))?.isInvalidated).toBe(true);
    expect(fetches).toBe(1);
  });

  /** ⚠️ The patched tree keeps its own stale copy; nothing reads it for locking. */
  it('does not fabricate a version on the patched tree', () => {
    const client = new QueryClient();
    client.setQueryData(optionSetKeys.tree('s1'), { ...tree(), rowVersion: 7 });

    patchTree(client, 's1', (set) => set);

    const after = client.getQueryData(optionSetKeys.tree('s1')) as { rowVersion: number };

    expect(after.rowVersion).toBe(7);
  });
});


describe('replaceItemInTree', () => {
  it('replaces the item that changed', () => {
    const next = replaceItemInTree(tree(), { id: 'i1', content: 'Updated' } as never);

    expect(next.groups[0]?.items[0]?.content).toBe('Updated');
  });

  /** ⚠️ Merged, not substituted — the same rule the other three follow. */
  it('keeps fields the response omits', () => {
    const next = replaceItemInTree(tree(), { id: 'i1', content: 'Updated' } as never);

    expect((next.groups[0]?.items[0] as { kind?: string }).kind).toBe('heading');
  });

  /** 📌 An item edit must not disturb the options beside it. */
  it('leaves the group’s options alone', () => {
    const next = replaceItemInTree(tree(), { id: 'i1', content: 'Updated' } as never);

    expect(next.groups[0]?.options).toHaveLength(1);
  });
});
