import type { PreviewTree } from './preview-tree';

/** What a customer has entered, keyed by option id. */
export type PreviewAnswers = Readonly<Record<string, unknown>>;

/**
 * The answers the rule evaluator sees, which are not quite the customer's.
 *
 * 🔴 **A `hidden` option answers itself.** Its type gives a customer nothing to
 * type into, so the storefront substitutes the option's `default_value` — and
 * **removes the key entirely** when there is none, rather than leaving an empty
 * string. `SelectionResolver::rule_answers()` does exactly this, and a rule
 * reading *"batch is empty"* gets a different answer depending on which.
 *
 * ⚠️ **`hidden` here is the option TYPE, not a rule's effect.** A rule that hides
 * an option is handled inside `evaluateRules`, which clears answers through
 * `optionsUnder`. The two are unrelated and the names collide unhelpfully.
 *
 * @param tree The preview projection.
 * @param entered What the customer has actually filled in.
 */
export function evaluableAnswers(tree: PreviewTree, entered: PreviewAnswers): PreviewAnswers {
  const answers: Record<string, unknown> = { ...entered };

  tree.groups.forEach((group) => {
    group.options.forEach((option) => {
      if (option.presentation !== 'hidden') {
        return;
      }

      const configured = typeof option.defaultValue === 'string' ? option.defaultValue.trim() : '';

      if (configured === '') {
        delete answers[option.id];

        return;
      }

      answers[option.id] = configured;
    });
  });

  return answers;
}

/**
 * The rules an evaluator can act on, in the dialect it reads.
 *
 * `previewTree()` leaves rules in the authoring spelling deliberately (ADR-103)
 * because `rule-evaluator` reads `targetType` and `matchType`. This exists to
 * make that explicit at the call site rather than leaving a reader to wonder
 * whether a conversion was forgotten.
 */
export function evaluableRules(tree: PreviewTree) {
  return tree.rules.map((rule) => ({
    id: rule.id,
    targetType: rule.targetType,
    targetId: rule.targetId,
    action: rule.action,
    matchType: rule.matchType,
    conditions: rule.conditions,
    actionValue: rule.actionValue,
  }));
}
