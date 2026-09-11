/**
 * The words a rule is built from, as the dashboard understands them.
 *
 * ## Mirrored from the API, and gated
 *
 * `common/database/enums.ts` in `optioniaWooCommerceBackend` is the source of
 * truth. This is a copy, because the two repositories cannot import from each
 * other — and `bin/check-rule-vocabulary-parity.sh` compares them, because a
 * copy nothing compares is a copy that drifts.
 *
 * 🔴 **The failure this prevents is silent in both suites.** Measured on the
 * option-type picker, 2026-09-03: *"adding `checkbox` to the picker passed all
 * 305 frontend tests and `tsc`, because nothing compared the two."* An operator
 * offered here that the API refuses is a merchant choosing it, submitting, and
 * being handed a 400 they cannot act on.
 *
 * ## Every word carries the sentence it reads as
 *
 * M17.6 asks for plain-language summaries — *"Show Engraving Text when Engraving
 * = Yes"*. Keeping the phrasing beside the value means the summary and the
 * picker cannot describe the same operator differently, which is the
 * `optionia-app` defect M11.1a records: a counter and a price computed the same
 * thing separately, and disagreed in front of the customer.
 */

/** What a rule can act on. */
export const RULE_TARGET_TYPES = ['option', 'group', 'value'] as const;
export type RuleTargetType = (typeof RULE_TARGET_TYPES)[number];

/** What a rule does to its target. */
export const RULE_ACTIONS = [
  'show',
  'hide',
  'require',
  'unrequire',
  'set_price',
  'set_default',
] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** How a rule's conditions combine. */
export const RULE_MATCH_TYPES = ['all', 'any'] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

/** How one condition compares an answer. */
export const RULE_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

/**
 * Operators that take **no** operand.
 *
 * ⚠️ **Mirrored from `UNARY_RULE_OPERATORS`, and the builder must honour it.**
 * Offering a value field for `is_empty` invites a merchant to fill one in, and
 * the schema is `.strict()` — the extra key is a 400, not an ignored field.
 */
export const UNARY_OPERATORS: readonly RuleOperator[] = ['is_empty', 'is_not_empty'];

/**
 * Operators whose operand is a **list**.
 *
 * The builder collects several values for these and one for the rest.
 */
export const LIST_OPERATORS: readonly RuleOperator[] = ['in', 'not_in'];

/**
 * Operators that compare **numbers**.
 *
 * ⚠️ Text has no ordering PHP and JavaScript agree on, so these are numeric
 * only — the schema refuses a string operand, and the builder should ask for a
 * number rather than let a merchant discover that at submit.
 */
export const NUMERIC_OPERATORS: readonly RuleOperator[] = ['greater_than', 'less_than'];

/** How each operator reads in a sentence: *"Engraving **is** Yes"*. */
export const OPERATOR_PHRASING: Readonly<Record<RuleOperator, string>> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  greater_than: 'is more than',
  less_than: 'is less than',
  is_empty: 'is empty',
  is_not_empty: 'is answered',
  in: 'is one of',
  not_in: 'is not one of',
};

/** How each action reads: *"**Show** Engraving Text when…"*. */
export const ACTION_PHRASING: Readonly<Record<RuleAction, string>> = {
  show: 'Show',
  hide: 'Hide',
  require: 'Require',
  unrequire: 'Make optional',
  set_price: 'Set the price of',
  set_default: 'Preselect',
};
