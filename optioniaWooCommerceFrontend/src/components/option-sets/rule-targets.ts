import type { AuthoringSet } from '@/lib/option-sets/api';
import type { RuleTargetType } from '@/lib/rules/vocabulary';

/** One thing a rule can act on, or read an answer from. */
export interface RuleTarget {
  id: string;
  kind: RuleTargetType;
  /** What a merchant reads: "Engraving", or "Engraving: Yes" for a value. */
  label: string;
}

/**
 * Everything in this set that a rule may name.
 *
 * 🔴 **Built from the loaded set and nothing else, and that is the whole
 * point.** `assertTargetIsWhatItClaims` checks only that a target *exists* —
 * anywhere in the tenant — so a picker offering an id from another set lets a
 * merchant save a rule successfully and then **blocks publish for the whole
 * set**: `RULE_TARGET_NOT_IN_SET` is a `BLOCKER`, and its only cure is finding
 * and deleting the rule that caused it.
 *
 * Scoping the picker to `set.groups` makes that unreachable by construction
 * rather than by a check somebody has to remember.
 *
 * ⚠️ **A disabled option is still offered.** Disabled is a merchant's own state
 * and they may re-enable it; a rule pointing at one is not wrong, and the
 * publish check says nothing about it. Deleted is the case that matters, and a
 * deleted option is simply absent from the tree.
 */
export function targetsIn(set: AuthoringSet): RuleTarget[] {
  const targets: RuleTarget[] = [];

  set.groups.forEach((group) => {
    targets.push({ id: group.id, kind: 'group', label: group.label });

    group.options.forEach((option) => {
      targets.push({ id: option.id, kind: 'option', label: option.label });

      option.values.forEach((value) => {
        /*
         * A value reads with its option, because a bare "Large" is ambiguous in
         * a set with two size options — and a value-targeted rule is exactly
         * where that ambiguity bites. `summary.ts` labels them the same way.
         */
        targets.push({
          id: value.id,
          kind: 'value',
          label: `${option.label}: ${value.label}`,
        });
      });
    });
  });

  return targets;
}

/**
 * The options a condition may read an answer from.
 *
 * ⚠️ **Options only — not groups, not values.** A condition asks *"what did the
 * customer answer?"*, and only an option holds an answer. A group is a heading
 * and a value is one of the possible answers, so neither can be the subject of
 * a comparison. `EvaluableCondition.optionId` says the same thing in its name.
 */
export function answerableIn(set: AuthoringSet): RuleTarget[] {
  const options: RuleTarget[] = [];

  set.groups.forEach((group) => {
    group.options.forEach((option) => {
      options.push({ id: option.id, kind: 'option', label: option.label });
    });
  });

  return options;
}

/**
 * The value keys a given option offers, for building an `equals` or `in` operand.
 *
 * 🔴 **Keys, not ids** — a condition compares against what the *customer
 * submits*, which is the `value_key`. Comparing against a value id would be
 * comparing an answer to something no form ever posts, and the rule would
 * silently never fire.
 */
export function choicesFor(set: AuthoringSet, optionId: string): Array<{ key: string; label: string }> {
  for (const group of set.groups) {
    for (const option of group.options) {
      if (option.id === optionId) {
        return option.values.map((value) => ({ key: value.valueKey, label: value.label }));
      }
    }
  }

  return [];
}
