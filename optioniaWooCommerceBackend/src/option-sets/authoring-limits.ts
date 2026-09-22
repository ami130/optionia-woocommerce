import { DomainException } from '../common/errors/domain.exception';

/**
 * Structural ceilings on how much one parent may hold.
 *
 * **Not plan quotas.** Billing limits are Phase 22 and vary by tier; these are
 * absolute bounds that protect the system whatever a merchant pays for. Two
 * things depend on them:
 *
 * - `duplicate` copies a whole subtree inside one transaction. Unbounded input
 *   means an unbounded transaction holding row locks for as long as it takes.
 * - The child list endpoints are deliberately unpaginated, on the stated
 *   assumption that a set's contents are bounded. Nothing enforced that
 *   assumption until now, which made the contract's claim an aspiration.
 *
 * The numbers are far above any usable configurator — a form with 200 options
 * in one group is not a form anyone completes — and far below the point where a
 * copy or a render becomes expensive.
 */
export const AUTHORING_LIMITS = {
  /** Groups in one option set. */
  groupsPerSet: 100,
  /** Options in one group. */
  optionsPerGroup: 200,

  /**
   * Headings, paragraphs and dividers in one group.
   *
   * Lower than `optionsPerGroup` deliberately: presentational items exist to
   * make a long form readable, and a group needing fifty headings is a group
   * that should have been several groups.
   */
  itemsPerGroup: 50,
  /** Values on one option. */
  valuesPerOption: 500,

  /**
   * Conditional rules in one option set.
   *
   * 🔴 **Missing until Stage 17-1's audit**, while `MAX_CONDITIONS_BYTES` bounded
   * a single rule at 16 KB and nothing bounded how many rules a set could hold.
   * Both halves are needed: the per-rule cap stops one rule being enormous, and
   * this stops a thousand ordinary ones — and rules reach the published document
   * every storefront caches, so the total is what matters there.
   *
   * Lower than `optionsPerGroup` deliberately. A set with more rules than options
   * is not a configurator anyone can reason about, and M17.6's plain-language
   * summaries have to be readable as a list. It is also the bound on the
   * cycle detector's input at publish (M17.3): cycle detection over a rule graph
   * is superlinear, and an unbounded graph is an unbounded publish.
   *
   * ⚠️ **Declared here in 17-1, enforced in 17-2** — there is no rule-creating
   * route to enforce it on yet. Stated because a limit nothing calls is
   * indistinguishable from a limit nobody wrote, and this file's own history is
   * why: `assertWithinLimit` existed and was applied to authoring limits only,
   * so per-plan `file_storage_mb` stayed metered and unenforced for a whole
   * phase.
   */
  rulesPerSet: 200,
} as const;

/**
 * Refuse a create that would exceed a ceiling.
 *
 * `PLAN_LIMIT_EXCEEDED` is deliberately **not** used: that code promises an
 * upgrade would help, and no plan raises a structural bound. This is a
 * validation failure against the field that names the parent.
 */
export function assertWithinLimit(current: number, limit: number, resource: string): void {
  if (current >= limit) {
    throw DomainException.validation([
      {
        field: resource,
        code: 'LIMIT_REACHED',
        params: {
          message: `An option set cannot hold more than ${limit} ${resource}.`,
          limit,
        },
      },
    ]);
  }
}
