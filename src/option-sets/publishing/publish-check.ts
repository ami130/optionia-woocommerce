import type { OptionSetTree } from '../serialization/option-set.serializer';
import { findType } from '../types/type-registry';

/** How much a finding matters. */
export const PublishSeverity = {
  /** Publishing is refused. */
  BLOCKER: 'blocker',
  /** Publishing proceeds; the merchant should know. */
  WARNING: 'warning',
} as const;
export type PublishSeverity = (typeof PublishSeverity)[keyof typeof PublishSeverity];

/** One thing wrong with a set, in terms a merchant can act on. */
export interface PublishFinding {
  readonly severity: PublishSeverity;
  /** Stable machine-readable reason, e.g. `OPTION_HAS_NO_VALUES`. */
  readonly code: string;
  /** What it is about: `option:<id>`, `set:<id>`. */
  readonly subject: string;
  /** Human-readable, naming the thing rather than its id. */
  readonly message: string;
}

/** Everything a validator needs. Extended, never narrowed, as phases add checks. */
export interface PublishContext {
  readonly tree: OptionSetTree;
  /** Rules belonging to the set, live only. Empty until Phase 17 builds rule CRUD. */
  readonly rules: ReadonlyArray<{
    id: string;
    targetType: string;
    targetId: string;
    isEnabled: boolean;
    disabledReason: string | null;
  }>;
  /**
   * Live assignments, loaded as a count for the publish preflight.
   *
   * Populated since Phase 10 Stage 1 — the picker that lets a merchant create
   * them is M13.6, so in practice this is empty until then.
   */
  readonly assignments: ReadonlyArray<{ id: string }>;
}

/**
 * One pre-publish check.
 *
 * **A registered extension point, not a switch statement.** M7.4 names two
 * validators that belong to later phases — M17.3's cycle detection and M14.4's
 * regex complexity — and the contract promises Phase 14 and Phase 17 add a
 * validator to a list rather than reopening the publish transaction. That only
 * holds if the list is the mechanism from the start.
 */
export interface PublishValidator {
  /** Stable name, for tests and for saying which check found what. */
  readonly name: string;
  validate(context: PublishContext): readonly PublishFinding[];
}

/**
 * An option a customer cannot answer.
 *
 * A choice option with no values renders as an empty control. If it is also
 * required, the customer cannot complete the form at all — so this blocks rather
 * than warns.
 */
export const optionsHaveValues: PublishValidator = {
  name: 'options-have-values',
  validate({ tree }) {
    const findings: PublishFinding[] = [];

    tree.groups.forEach((group) => {
      if (!group.group.isEnabled) {
        return;
      }

      group.options.forEach(({ option, values }) => {
        if (!option.isEnabled) {
          return;
        }

        // Only types that take values. A text field legitimately has none.
        if (!takesValues(option.presentation)) {
          return;
        }

        const live = values.filter((value) => value.isEnabled);

        if (live.length === 0) {
          findings.push({
            severity: PublishSeverity.BLOCKER,
            code: 'OPTION_HAS_NO_VALUES',
            subject: `option:${option.id}`,
            message: `"${option.label}" is a ${option.presentation} with no values, so a customer would see an empty control.`,
          });
        }
      });
    });

    return findings;
  },
};

/**
 * Rules the cascade disabled because their target was deleted (7g).
 *
 * A warning, not a blocker: the rule is already disabled, so the storefront is
 * consistent. The merchant is told because a rule that silently stopped working
 * is the thing they would otherwise discover from a customer.
 */
export const rulesHaveTargets: PublishValidator = {
  name: 'rules-have-targets',
  validate({ rules }) {
    return rules
      .filter((rule) => rule.disabledReason === 'target_deleted')
      .map((rule) => ({
        severity: PublishSeverity.WARNING,
        code: 'RULE_TARGET_DELETED',
        subject: `rule:${rule.id}`,
        message:
          'A rule was disabled because the option, group or value it targeted was deleted. ' +
          'It will not be published.',
      }));
  },
};

/**
 * A set assigned to nothing reaches no product.
 *
 * A warning rather than a blocker: publishing to nothing is wasteful, not
 * broken, and a merchant may deliberately publish before assigning. Blocking
 * would make the natural order of work — build, publish, then assign — an error.
 */
export const setHasAssignments: PublishValidator = {
  name: 'set-has-assignments',
  validate({ tree, assignments }) {
    if (assignments.length > 0) {
      return [];
    }

    return [
      {
        severity: PublishSeverity.WARNING,
        code: 'SET_HAS_NO_ASSIGNMENT',
        subject: `set:${tree.set.id}`,
        message:
          `"${tree.set.name}" is not assigned to any product, so publishing it will not ` +
          `change any storefront.`,
      },
    ];
  },
};

/**
 * A set with nothing in it.
 *
 * Not one of M7.4's five, and blocking for the same reason as an option with no
 * values: there is nothing to render, so the publish cannot mean what the
 * merchant intends.
 */
export const setHasContent: PublishValidator = {
  name: 'set-has-content',
  validate({ tree }) {
    const liveGroups = tree.groups.filter((group) => group.group.isEnabled);

    const liveOptions = liveGroups.flatMap((group) =>
      group.options.filter(({ option }) => option.isEnabled),
    );

    /**
     * ✏️ **Presentational items count as content.**
     *
     * This once counted enabled *options* alone, which was right while nothing
     * could create an item. After M5.4c's routes shipped, a set of pure
     * explanatory copy — care instructions, a sizing note above a variant
     * picker — is legitimate content, and the plugin's renderer already draws a
     * group that holds only items. Blocking the publish left the two disagreeing
     * about the same set.
     *
     * ⚠️ **`presentational_items` has no `isEnabled`** — it is the one authorable
     * table without one (see `projections.ts`), so presence is the only test
     * available here. A disabled *group* still hides its items, which is why the
     * count runs over `liveGroups` rather than every group.
     */
    const liveItems = liveGroups.flatMap((group) => group.items);

    if (liveOptions.length > 0 || liveItems.length > 0) {
      return [];
    }

    return [
      {
        severity: PublishSeverity.BLOCKER,
        code: 'SET_HAS_NO_OPTIONS',
        subject: `set:${tree.set.id}`,
        message: `"${tree.set.name}" has no enabled options or content, so there is nothing to publish.`,
      },
    ];
  },
};

/**
 * The checks that run before every publish.
 *
 * ⚠️ **Two of M7.4's five are absent, and deliberately so.**
 *
 * - *"required options hidden by their own rule"* needs rule **evaluation**,
 *   which is M17.3.
 * - *"pricing referencing a removed value"* has nothing to reference: no pricing
 *   schema in the registry names a value id, so the check has no subject until
 *   a type that does exists.
 *
 * Both are added by appending to this array, which is the point of the shape.
 * M7.4's other named validators — M17.3 cycle detection, M14.4 regex complexity
 * — arrive the same way.
 */
/**
 * The longest merchant-authored regex accepted. Mirrors the plugin's own cap.
 */
const MAX_PATTERN_LENGTH = 200;

/**
 * Nested quantifiers — the shape that makes a regex catastrophic.
 *
 * `(a+)+`, `(a*)*`, `(a+)*` and their `{n,}` spellings all describe the same
 * thing: a repetition inside a repetition, where the engine can split the input
 * exponentially many ways before concluding it does not match.
 *
 * ⚠️ **Deliberately a shape check, not a proof.** Deciding whether an arbitrary
 * regex backtracks catastrophically is not something a linter settles, and a
 * check pretending otherwise would be worse than none. This refuses the shape
 * that causes it in practice, which is what a merchant would actually write by
 * accident.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*}][^)]*\)\s*[+*]|\([^)]*[+*][^)]*\)\s*\{\d+,\}?/;

/**
 * 🔴 **A pattern a customer's request would have to survive.**
 *
 * M14.4 calls regex a security boundary: merchant-authored patterns run on every
 * add-to-cart, and a catastrophically backtracking one is a denial-of-service
 * vector. The milestone is explicit that it must be *"rejected at publish time
 * … not discovered at customer request time"*.
 *
 * A **blocker**, not a warning. A warning would let a merchant publish it, and
 * the cost would land on their customers rather than on them.
 *
 * ⚠️ **The plugin defends itself too** — it caps length, and treats a backtrack
 * bailout as "rule could not be applied" rather than "input invalid", so a bad
 * pattern cannot refuse every answer. This check is what stops one being
 * published at all; that one is what stops a published one being fatal.
 */
export const patternsAreSafe: PublishValidator = {
  name: 'patterns-are-safe',
  validate({ tree }) {
    const findings: PublishFinding[] = [];

    tree.groups.forEach((group) => {
      if (!group.group.isEnabled) {
        return;
      }

      group.options.forEach(({ option }) => {
        if (!option.isEnabled) {
          return;
        }

        const pattern = (option.validation as Record<string, unknown> | null)?.pattern;

        if (typeof pattern !== 'string' || pattern === '') {
          return;
        }

        if (pattern.length > MAX_PATTERN_LENGTH) {
          findings.push({
            severity: PublishSeverity.BLOCKER,
            code: 'PATTERN_TOO_LONG',
            subject: `option:${option.id}`,
            message:
              `"${option.label}" has a validation pattern of ${pattern.length} characters; ` +
              `${MAX_PATTERN_LENGTH} is the limit.`,
          });

          return;
        }

        /*
         * Compiled here so an invalid pattern is caught at publish rather than
         * silently ignored on the storefront — the plugin treats one it cannot
         * compile as no rule at all, which is safe but means the merchant's
         * intended validation never happens and nothing says so.
         */
        try {
          new RegExp(pattern);
        } catch {
          findings.push({
            severity: PublishSeverity.BLOCKER,
            code: 'PATTERN_INVALID',
            subject: `option:${option.id}`,
            message: `"${option.label}" has a validation pattern that is not a valid regular expression.`,
          });

          return;
        }

        if (NESTED_QUANTIFIER.test(pattern)) {
          findings.push({
            severity: PublishSeverity.BLOCKER,
            code: 'PATTERN_UNSAFE',
            subject: `option:${option.id}`,
            message:
              `"${option.label}" has a validation pattern with a repetition inside a repetition ` +
              `(such as "(a+)+"), which can take exponential time on input that does not match.`,
          });
        }
      });
    });

    return findings;
  },
};

export const PUBLISH_VALIDATORS: readonly PublishValidator[] = [
  setHasContent,
  optionsHaveValues,
  rulesHaveTargets,
  setHasAssignments,
  patternsAreSafe,
];

/** Run every validator and collect what they found. */
export function runPublishChecks(
  context: PublishContext,
  validators: readonly PublishValidator[] = PUBLISH_VALIDATORS,
): readonly PublishFinding[] {
  return validators.flatMap((validator) => validator.validate(context));
}

/** Whether any finding refuses the publish. */
export function hasBlockers(findings: readonly PublishFinding[]): boolean {
  return findings.some((finding) => finding.severity === PublishSeverity.BLOCKER);
}

/**
 * Whether a presentation renders a list of values.
 *
 * Read from the registry rather than hardcoded, so a type added in Phase 14 is
 * classified by its own declaration and this check needs no edit. An unknown
 * type is treated as taking no values — the validator refuses unregistered types
 * at the API boundary, so a stored one cannot be reasoned about here.
 */
function takesValues(presentation: string): boolean {
  return findType(presentation)?.takesValues ?? false;
}
