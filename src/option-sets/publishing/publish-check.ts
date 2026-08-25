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
  /** Live assignments. Empty until Phase 13. */
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
    const liveOptions = tree.groups
      .filter((group) => group.group.isEnabled)
      .flatMap((group) => group.options.filter(({ option }) => option.isEnabled));

    if (liveOptions.length > 0) {
      return [];
    }

    return [
      {
        severity: PublishSeverity.BLOCKER,
        code: 'SET_HAS_NO_OPTIONS',
        subject: `set:${tree.set.id}`,
        message: `"${tree.set.name}" has no enabled options, so there is nothing to publish.`,
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
export const PUBLISH_VALIDATORS: readonly PublishValidator[] = [
  setHasContent,
  optionsHaveValues,
  rulesHaveTargets,
  setHasAssignments,
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
