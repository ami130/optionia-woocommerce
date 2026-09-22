import type { QueryClient } from '@tanstack/react-query';

import type {
  AuthoringGroup,
  AuthoringItem,
  AuthoringOption,
  AuthoringSet,
  AuthoringValue,
} from './api';

/**
 * What an edit invalidates, and what it deliberately does not.
 *
 * ## The cost this exists to cut
 *
 * 🔴 **One edit cost FIVE HTTP requests, three of them full documents.**
 * `reload()` invalidated `['option-set', setId]` — a **prefix**, with no
 * `exact` anywhere — so a renamed label refetched the whole tree *and*
 * `publish-check` *and* `versions` *and* `hasUnpublishedChanges`, which is
 * itself two full-document reads (the preview and the published snapshot).
 * Measured: four cache entries invalidated per edit, from **29** call sites.
 *
 * At `AUTHORING_LIMITS` scale — 20 groups of 30 options is 600 options and
 * 12,000 values — that is the entire tree, per keystroke-pause, before
 * autosave (M20.10) multiplies it.
 *
 * ## Why a module rather than inline options
 *
 * 📌 **The same reason `chunk()` moved out of the picker in 20-1.** A policy
 * written inline in a component cannot be tested in a repository whose
 * renderer arrived only in 20-2c, and *which* queries an edit should refresh is
 * exactly the kind of decision that rots silently — a query added later joins
 * the prefix by accident and nobody notices the extra fetch.
 */
export const optionSetKeys = {
  /** The authoring tree: groups, options, values, items. */
  tree: (setId: string) => ['option-set', setId] as const,

  /** Pre-publish findings — blockers and warnings. */
  publishCheck: (setId: string) => ['option-set', setId, 'publish-check'] as const,

  /** Whether the draft differs from what the storefront serves. */
  unpublished: (setId: string, rowVersion: number) =>
    ['option-set', setId, 'unpublished', rowVersion] as const,

  /** The published history. */
  versions: (setId: string, rowVersion: number) =>
    ['option-set', setId, 'versions', rowVersion] as const,

  /**
   * The set's own `rowVersion` — the optimistic-lock token, on its own key.
   *
   * 🔴 **Separate from the tree because a patched tree cannot carry it.** The
   * backend advances the *parent set's* version on every child edit
   * (`ParentSetService`, twelve call sites), but an edit response returns only
   * the entity — so a tree patched from that response keeps the version it
   * loaded with. `publishSet` and `rollbackTo` send that token, and a stale one
   * answers 409 naming a conflict the merchant caused themselves.
   */
  version: (setId: string) => ['option-set', setId, 'row-version'] as const,
};

/**
 * Refresh what an **edit** changed: the tree, and nothing else.
 *
 * ⚠️ **`exact: true` is the whole point.** Without it the key is a prefix and
 * takes its three siblings with it. Editing a label cannot change the published
 * history, and the publish-check is re-run when the publish panel is opened —
 * neither needs refetching because a merchant renamed an option.
 *
 * 🔴 **`unpublished` is the deliberate exception**, and it is invalidated here
 * on purpose: an edit is *precisely* what makes a published set differ from its
 * draft, so the "still serving version N" notice would otherwise be stale in
 * the one direction that matters.
 */
export function invalidateAfterEdit(client: QueryClient, setId: string): void {
  void client.invalidateQueries({ queryKey: optionSetKeys.tree(setId), exact: true });

  void client.invalidateQueries({
    queryKey: ['option-set', setId, 'unpublished'],
  });
}

/**
 * Refresh what a **publish** changed: everything about the set.
 *
 * A publish moves the version, writes history, and settles the draft-versus-live
 * question — so here the broad prefix invalidation is correct rather than
 * wasteful, and it happens once per publish rather than once per keystroke.
 */
export function invalidateAfterPublish(client: QueryClient, setId: string): void {
  void client.invalidateQueries({ queryKey: optionSetKeys.tree(setId) });
}

/**
 * Replace one option in the cached tree, without refetching it.
 *
 * 🔴 **Every mutation already returns the entity it changed** — `updateOption`
 * answers with an `AuthoringOption`, `updateValue` with an `AuthoringValue`,
 * and so on for all six. Refetching the whole tree afterwards **discards data
 * the server just sent**, then asks for it again: at 20 groups of 30 options
 * that is 600 options and 12,000 values, to apply one edited label.
 *
 * ⚠️ **Only for edits in place.** A create or a delete changes the tree's
 * *shape* — ordering, counts, which group owns what — and patching that by hand
 * is where a cache and a database quietly diverge. Those still invalidate.
 *
 * 📌 **Returns a new tree rather than mutating.** React Query compares by
 * reference to decide what re-renders; editing the cached object in place
 * changes the data and updates nothing on screen.
 */
export function replaceOptionInTree(
  set: AuthoringSet,
  option: AuthoringOption,
): AuthoringSet {
  return {
    ...set,
    groups: set.groups.map((group) => ({
      ...group,
      options: group.options.map((existing) =>
        existing.id === option.id ? { ...existing, ...option } : existing,
      ),
    })),
  };
}

/**
 * Replace one value in the cached tree.
 *
 * ⚠️ **Merged over the existing value, not substituted.** `updateValue` answers
 * with the fields the API stores; anything the tree holds that the response
 * omits would otherwise be dropped — and a value losing its price because a
 * label was renamed is exactly the kind of silent divergence this whole module
 * exists to avoid.
 */
export function replaceValueInTree(set: AuthoringSet, value: AuthoringValue): AuthoringSet {
  return {
    ...set,
    groups: set.groups.map((group) => ({
      ...group,
      options: group.options.map((option) => ({
        ...option,
        values: option.values.map((existing) =>
          existing.id === value.id ? { ...existing, ...value } : existing,
        ),
      })),
    })),
  };
}

/**
 * Replace one presentational item in the cached tree.
 *
 * ⚠️ **Merged rather than substituted**, for the same reason as the other
 * three: `updateItem` answers with the fields the API stores, and anything the
 * tree holds that the response omits would otherwise be dropped.
 */
export function replaceItemInTree(set: AuthoringSet, item: AuthoringItem): AuthoringSet {
  return {
    ...set,
    groups: set.groups.map((group) => ({
      ...group,
      items: group.items.map((existing) =>
        existing.id === item.id ? { ...existing, ...item } : existing,
      ),
    })),
  };
}

/** Replace one group's own fields, leaving its options and items untouched. */
export function replaceGroupInTree(set: AuthoringSet, group: AuthoringGroup): AuthoringSet {
  return {
    ...set,
    groups: set.groups.map((existing) =>
      existing.id === group.id ? { ...existing, ...group } : existing,
    ),
  };
}

/**
 * Apply an in-place edit to the cached tree, instead of refetching it.
 *
 * 🔴 **This is the call that turns a proven-but-unused helper into a saved
 * request.** `replace*InTree` are pure and were tested in isolation from the
 * day they were written, but nothing invoked them: every edit still went
 * through `invalidateAfterEdit` and refetched the whole document. At 20 groups
 * of 30 options — 600 options, 12,000 values — that is the entire set, to
 * apply one label the server already handed back.
 *
 * ⚠️ **The draft-versus-live comparison is still invalidated**, for the same
 * reason `invalidateAfterEdit` invalidates it: an edit is precisely what makes
 * a published set differ from its draft. Only the *tree* fetch is saved here.
 *
 * ⚠️ **A cold cache is left cold.** `setQueryData` on an absent key would write
 * whatever `patch` returns for `undefined` — a fragment the loader never
 * produced, which the next read would mistake for the whole set. If the tree
 * is not cached there is nothing to patch, and the next mount fetches it.
 *
 * 📌 Only for edits **in place**. A create, a delete or a reorder changes the
 * tree's *shape*, and reproducing that by hand is where a cache and a database
 * quietly diverge. Those still call `invalidateAfterEdit`.
 */
export function patchTree(
  client: QueryClient,
  setId: string,
  patch: (set: AuthoringSet) => AuthoringSet,
): void {
  const key = optionSetKeys.tree(setId);
  const current = client.getQueryData<AuthoringSet>(key);

  if (current !== undefined) {
    client.setQueryData(key, patch(current));
  }

  void client.invalidateQueries({
    queryKey: ['option-set', setId, 'unpublished'],
  });

  /*
   * 🔴 **Refetched, never guessed.** Every child edit advances the parent set's
   * `rowVersion` server-side. Adding one to the cached number would usually be
   * right and is the wrong fix: under a concurrent edit a guessed version can
   * coincidentally match the row, the write succeeds, and another merchant's
   * work is overwritten with **no error at all** — the precise failure the
   * optimistic lock exists to prevent. A refetch costs one small request and
   * cannot be wrong.
   */
  void client.invalidateQueries({ queryKey: optionSetKeys.version(setId) });
}
