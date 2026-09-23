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
