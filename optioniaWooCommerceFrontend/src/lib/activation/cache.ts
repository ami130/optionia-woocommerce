import type { QueryClient } from '@tanstack/react-query';

/**
 * The dashboard's activation queries.
 *
 * 🔴 **Siblings, never nested — `invalidateQueries` matches by PREFIX.**
 *
 * The preferences query was first keyed `['activation', 'preferences']`, which
 * sits *underneath* the funnel's `['activation']`. Proven against a real client:
 *
 * ```text
 * invalidateQueries({ queryKey: ['activation'] })
 *   → invalidated: ["activation", "activation/preferences"]
 * ```
 *
 * So every publish, assign, create, disconnect and verification — five screens —
 * also refetched a preference that cannot have changed. Not a correctness bug,
 * but an extra request on every funnel-moving action, and invisible because the
 * refetch returns the same answer.
 *
 * 📌 **Both keys live here** so the relationship between them is one decision in
 * one place. A key invented at a call site is how the nesting happened.
 */
export const activationKeys = {
  /** The funnel position — `GET /activation/me`. */
  me: () => ['activation'] as const,

  /**
   * This person's dashboard preferences — `GET /activation/preferences`.
   *
   * ⚠️ `activation-preferences`, not `['activation', 'preferences']`: a distinct
   * root, so no invalidation of the funnel can reach it.
   */
  preferences: () => ['activation-preferences'] as const,
};

/**
 * Refresh the merchant's funnel position after something that could move it.
 *
 * 🔴 **Nothing invalidated this key at all, and the checklist lied for 30
 * seconds.** `GET /activation/me` is cached with the app's default
 * `staleTime: 30_000` and `refetchOnWindowFocus: false`, so a merchant who
 * connected a store, created a set, assigned it or published, then returned to
 * the dashboard inside that window, was told they had not.
 *
 * M20b.2 requires the checklist to reflect *"real state rather than a static
 * list"*. A thirty-second stale answer is a smaller version of exactly the
 * failure that requirement names, and it is invisible in development because a
 * developer navigating slowly never sees the window.
 *
 * ## Why a module rather than a call at each site
 *
 * 📌 **Six mutations across four screens move this one key.** Written inline,
 * the next mutation that moves the funnel — M20b.3's install check, a future
 * unassign — joins by being remembered, which is how the original omission
 * happened. A named function is a place to look and a thing to test.
 *
 * ⚠️ **Deliberately broad in the other direction: this invalidates only the
 * funnel.** It is called alongside each screen's own invalidation, never in
 * place of it — a publish still refreshes the set's tree and history through
 * `invalidateAfterPublish`.
 */
export function invalidateActivation(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: activationKeys.me() });
}
