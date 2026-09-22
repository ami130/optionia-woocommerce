import type { RuleOutcome, TargetState } from '@/lib/rules/rule-evaluator';

/**
 * What the rules decided, in the form a renderer can act on.
 *
 * 🔴 **The evaluator reports states for THREE target types, and a first version
 * of the preview consumed one.** `evaluateRules` keys `states` by whatever a
 * rule targeted — a group, an option, or a value — and a component reading only
 * `states.get(option.id)` draws a hidden group in full and a hidden value beside
 * its siblings. Found by audit rather than by mutation, because absent code has
 * nothing to mutate.
 *
 * ## The two mechanisms are different, and the storefront keeps them apart
 *
 * **Options** are hidden by *expansion*: `hidden_options()` walks every hidden
 * target through the containment map, so hiding a **group** hides each option
 * inside it. The group itself is never asked whether it is hidden — its options
 * are.
 *
 * **Values** are hidden *directly*: `hidden_values()` looks only at rules whose
 * `target_type` is `value`, and hides that value alone. A value is never reached
 * by expansion, because `optionsUnder` maps it to nothing (M17.8) — hiding one
 * colour removes a *choice*, not the question.
 */
export interface RuleEffects {
  /** Option ids the rules removed from the page. */
  readonly hiddenOptions: ReadonlySet<string>;
  /** Value ids the rules removed from their option. */
  readonly hiddenValues: ReadonlySet<string>;
}

/**
 * Expand the evaluator's states into what a renderer must not draw.
 *
 * @param outcome What `evaluateRules` decided.
 * @param under The containment map the same call was given.
 * @param valueIds Every value id in the tree, so a value target is recognised.
 */
export function ruleEffects(
  outcome: RuleOutcome,
  under: ReadonlyMap<string, readonly string[]>,
  valueIds: ReadonlySet<string>,
): RuleEffects {
  const hiddenOptions = new Set<string>();
  const hiddenValues = new Set<string>();

  outcome.states.forEach((state, targetId) => {
    if (!state.hidden) {
      return;
    }

    /*
     * A value target hides itself and nothing else. Checked before the
     * expansion, because `optionsUnder` registers a value with an **empty**
     * list — so expanding it would correctly do nothing, and a reader would be
     * left wondering where the value went.
     */
    if (valueIds.has(targetId)) {
      hiddenValues.add(targetId);

      return;
    }

    /*
     * Everything else expands through containment: a group hides its options,
     * an option hides itself. This is `hidden_options()`, which walks the map
     * rather than testing the target's own type — so a target type added later
     * is handled by the map rather than by a branch here.
     */
    (under.get(targetId) ?? []).forEach((optionId) => hiddenOptions.add(optionId));
  });

  return { hiddenOptions, hiddenValues };
}

/**
 * The state that decides a value's price, which is not always the option's.
 *
 * 🔴 **A value's `price_minor` OVERRIDES its option's, and a conflict on either
 * refuses.** `SelectionResolver::set_price_for()` checks both and prefers the
 * value. A preview reading only the option's state would show a merchant a price
 * the server will not charge.
 *
 * ⚠️ **`set_price` is not offered by the rule builder** — it carries a payload
 * the builder has no field for, and ADR-054's question about quoted totals is
 * open. But the API accepts one, so a rule can arrive by import or from before
 * that filter, and the document is input rather than authority (AC4).
 */
export function pricingState(
  optionState: TargetState | undefined,
  valueState: TargetState | undefined,
): { priceMinor: number | null; priceConflict: boolean } {
  const priceConflict = optionState?.priceConflict === true || valueState?.priceConflict === true;

  if (priceConflict) {
    return { priceMinor: null, priceConflict: true };
  }

  /* The value wins when it has something to say, exactly as the storefront does. */
  const fromValue = valueState?.priceMinor ?? null;
  const fromOption = optionState?.priceMinor ?? null;

  return { priceMinor: fromValue ?? fromOption, priceConflict: false };
}
