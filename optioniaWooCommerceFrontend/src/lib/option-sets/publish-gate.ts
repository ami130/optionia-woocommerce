import type { PublishFinding } from '@/lib/option-sets/api';

/**
 * Whether a set may be published, and what to say when it may not.
 *
 * ## Why this is a module and not three expressions in the button
 *
 * 🔴 **The gate lived inline and nothing could reach it.** Removing `blocked`
 * from the button's `disabled` — so a set with unresolved blockers publishes to
 * a live storefront — compiled cleanly and left **1752 tests passing**. The
 * decision was entangled with React Query inside a `'use client'` page, which
 * is the condition under which "absent code has nothing to mutate" becomes
 * "present code nothing asserts".
 *
 * ⚠️ **`blocker` and `warning` are not the same word.** A blocker stops the
 * publish; a warning is *"worth knowing"* and must not. Treating them alike in
 * either direction is a real defect — one ships a broken set, the other traps a
 * merchant behind advice they have read and accepted.
 */
export interface PublishGate {
  /** True when something must be fixed before the storefront can be served this set. */
  blocked: boolean;

  /** The findings that block, in the order the API reported them. */
  blockers: readonly PublishFinding[];

  /** The findings worth reading that do not block. */
  warnings: readonly PublishFinding[];

  /**
   * What a disabled button says beside itself, or `null` when nothing blocks.
   *
   * 🔴 **A disabled control that does not say why is a dead end.** The findings
   * themselves render further down the page, so without a count the merchant's
   * question is *"why is this greyed out?"* with no answer in view.
   */
  summary: string | null;
}

export function publishGate(findings: readonly PublishFinding[] | undefined): PublishGate {
  const all = findings ?? [];
  const blockers = all.filter((finding) => finding.severity === 'blocker');
  const warnings = all.filter((finding) => finding.severity === 'warning');

  return {
    blocked: blockers.length > 0,
    blockers,
    warnings,

    /*
     * 📌 Singular is spelled out rather than pluralised with an `(s)`, which
     * reads as machine output in the one place a merchant is already stuck.
     */
    summary:
      blockers.length === 0
        ? null
        : blockers.length === 1
          ? '1 thing to fix'
          : `${blockers.length} things to fix`,
  };
}

/**
 * Whether a publish confirmation still describes the set in front of the merchant.
 *
 * 🔴 **A confirmation that outlives its state contradicts the page it sits
 * on.** Publishing writes *"Published version 7"* at the top; the merchant then
 * edits, and `UnpublishedChangesNotice` renders below it saying the storefront
 * is serving something older. Both sentences are on screen, and the stale one
 * is first. ⚠️ **The previous code had this flaw too** — `publish.data` also
 * lived until unmount — but it sat in a panel below the product picker, so
 * moving the message to the top is what made a quiet staleness loud.
 *
 * ## Why unpublished changes, and not a version number
 *
 * 📌 **Three plausible keys were wrong, each for its own reason**, and they are
 * recorded because the next person will reach for them in the same order:
 *
 * - `set.version` is the **published** version. It does not move when a
 *   merchant edits, so the message would survive exactly the edits it needs to
 *   expire on.
 * - `set.rowVersion` is the optimistic lock and does move on every edit — but
 *   **publishing moves it too**, and `invalidateAfterPublish` refetches the
 *   tree asynchronously, so a version captured in `onSuccess` is the
 *   *pre*-publish one and the incoming refetch erases the message in the tick
 *   that produced it.
 * - `PublishResult.rowVersion` would settle it and **does not exist**; the
 *   response carries `version`, `publishedAt`, `configVersion` and `warnings`.
 *   Guessing the lock token is the class of defect the lock exists to prevent.
 *
 * What the message actually claims is *"your storefront matches what you have
 * here"*. The question already asked on this page is whether anything differs
 * from the published version — so the confirmation is true exactly while that
 * answer is empty, and no version arithmetic is needed.
 *
 * ⚠️ **`undefined` is "not asked yet", and must not expire the message.** The
 * diff is a query; treating its pending state as "something changed" would
 * blank the confirmation on every refetch, which is most of the time.
 */
export function publishResultIsCurrent(
  hasResult: boolean,
  unpublishedChanges: readonly string[] | undefined,
): boolean {
  if (!hasResult) {
    return false;
  }

  return unpublishedChanges === undefined || unpublishedChanges.length === 0;
}
