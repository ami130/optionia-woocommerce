import type { AuthoringRule, AuthoringSet, RuleCondition } from '@/lib/option-sets/api';

import {
  ACTION_PHRASING,
  LIST_OPERATORS,
  OPERATOR_PHRASING,
  UNARY_OPERATORS,
} from './vocabulary';

/**
 * A rule, as a sentence (M17.6).
 *
 * 🔴 **A merchant must be able to read a rule without documentation**, which is
 * the one Phase 17 exit criterion no shipped code satisfies. `target_id` and
 * `option_id` are UUIDs; a list of them is a list nobody can check.
 *
 * ## Why the phrasing lives in `vocabulary.ts`
 *
 * Beside the operator it describes, so the picker and the summary cannot
 * describe the same operator differently. That is the `optionia-app` defect
 * M11.1a records — a counter and a price computed the same thing separately and
 * disagreed in front of the customer — and a rule builder that offers *"is one
 * of"* while the list reads *"in"* is the same failure in a smaller place.
 *
 * ## Why a deleted target still reads
 *
 * A rule whose target was deleted is disabled by the cascade, not removed — the
 * merchant is told at publish. It still has to render, and rendering a bare UUID
 * is how a merchant ends up unable to find the rule they need to delete.
 */

/** Every id in a set that a rule can name, with the label a merchant reads. */
export function labelsIn(set: AuthoringSet): Map<string, string> {
  const labels = new Map<string, string>();

  set.groups.forEach((group) => {
    labels.set(group.id, group.label);

    group.options.forEach((option) => {
      labels.set(option.id, option.label);

      option.values.forEach((value) => {
        /*
         * A value reads as "Option: Value", because a bare "Large" is ambiguous
         * in a set with two size options — and a rule targeting one value is
         * exactly where that ambiguity bites.
         */
        labels.set(value.id, `${option.label}: ${value.label}`);
      });
    });
  });

  return labels;
}

/**
 * What to call an id a rule names.
 *
 * ⚠️ **A missing label is reported as missing, never as its id.** *"a deleted
 * option"* tells a merchant what happened; `01a08c…` tells them nothing and
 * looks like a bug.
 */
function nameFor(id: string, labels: Map<string, string>): string {
  return labels.get(id) ?? 'a deleted option';
}

/** One condition, as a clause: *"Engraving is Yes"*. */
export function conditionSentence(
  condition: RuleCondition,
  labels: Map<string, string>,
): string {
  const subject = nameFor(condition.optionId, labels);
  const verb = OPERATOR_PHRASING[condition.operator] ?? condition.operator;

  if (UNARY_OPERATORS.includes(condition.operator)) {
    return `${subject} ${verb}`;
  }

  if (LIST_OPERATORS.includes(condition.operator)) {
    const items = Array.isArray(condition.value) ? condition.value : [];

    /*
     * An empty list reads as "nothing", which is true and unhelpful — but the
     * schema refuses one, so this is reachable only from a row that predates
     * that check. Saying so beats printing "is one of ".
     */
    return items.length === 0
      ? `${subject} ${verb} nothing`
      : `${subject} ${verb} ${items.join(', ')}`;
  }

  return `${subject} ${verb} ${String(condition.value ?? '')}`;
}

/**
 * A whole rule, as a sentence.
 *
 * *"Hide Engraving Text when Engraving is Yes"*
 * *"Show Gift Note when all of: Gift is Yes, Wrapping is answered"*
 */
export function ruleSentence(rule: AuthoringRule, labels: Map<string, string>): string {
  const verb = ACTION_PHRASING[rule.action] ?? rule.action;
  const target = nameFor(rule.targetId, labels);

  if (rule.conditions.length === 0) {
    /*
     * ⚠️ **A rule with no conditions never fires**, in both evaluators — the
     * schema refuses one, so this is a row from before that check. Saying
     * "never" is the truth a merchant can act on; describing it as an
     * unconditional rule would be the opposite of what happens.
     */
    return `${verb} ${target} — never, because this rule has no conditions`;
  }

  const clauses = rule.conditions.map((condition) => conditionSentence(condition, labels));

  if (clauses.length === 1) {
    return `${verb} ${target} when ${clauses[0]}`;
  }

  const joiner = rule.matchType === 'any' ? 'any of' : 'all of';

  return `${verb} ${target} when ${joiner}: ${clauses.join(', ')}`;
}
