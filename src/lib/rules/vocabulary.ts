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

/* -------------------------------------------------------------------------
 * The five operand shapes
 *
 * 🔴 **The API has five condition schemas, not one.** `ruleConditionSchema` is a
 * discriminated union keyed on the operator, and each branch accepts a different
 * `value`: absent, a list, a number, a string, or any scalar. The builder picks
 * its input control from these, so a missing grouping is a text box where the
 * API demands a number — a 400 the merchant discovers at submit.
 *
 * ✏️ **Two of the five were missing until the builder needed them**, and the
 * parity gate could not see it: it compared the four flat lists and nothing
 * else. It now compares the groupings too.
 * ---------------------------------------------------------------------- */

/**
 * Operators that take **no** operand.
 *
 * ⚠️ **Offering a value field for `is_empty` is a 400, not an ignored field.**
 * The schema is `.strict()`, so an extra key is refused outright — the builder
 * must not render one.
 */
export const UNARY_OPERATORS: readonly RuleOperator[] = ['is_empty', 'is_not_empty'];

/**
 * Operators whose operand is a **list**, capped at `MAX_OPERAND_LIST_LENGTH`.
 */
export const LIST_OPERATORS: readonly RuleOperator[] = ['in', 'not_in'];

/**
 * Operators that compare **numbers**.
 *
 * ⚠️ Text has no ordering PHP and JavaScript agree on, so these are numeric
 * only — the schema refuses a string operand, and the builder asks for a number
 * rather than letting a merchant discover that at submit.
 *
 * Named for what it means to a merchant; the API calls the same pair
 * `ORDERING_RULE_OPERATORS`, and the parity gate maps one to the other.
 */
export const NUMERIC_OPERATORS: readonly RuleOperator[] = ['greater_than', 'less_than'];

/**
 * Operators whose operand is a **string**, and only a string.
 *
 * `contains` asks about text. A number would have to be stringified to compare,
 * and the two languages disagree about how — so the schema refuses one.
 */
export const SUBSTRING_OPERATORS: readonly RuleOperator[] = ['contains'];

/**
 * Operators that accept **any scalar**: a string, a number or a boolean.
 *
 * The widest branch, and the default the builder falls back to.
 */
export const EQUALITY_OPERATORS: readonly RuleOperator[] = ['equals', 'not_equals'];

/**
 * What kind of input one operator needs.
 *
 * 🔴 **One function, so the builder and any validation cannot disagree.** Asking
 * "is this unary?" in one place and "is this a list?" in another is how a form
 * comes to render a text box for `in` — the shape M11.1a records, where two
 * places computed the same thing separately.
 */
export type OperandShape = 'none' | 'list' | 'number' | 'text' | 'scalar';

export function operandShape(operator: RuleOperator): OperandShape {
  if (UNARY_OPERATORS.includes(operator)) {
    return 'none';
  }

  if (LIST_OPERATORS.includes(operator)) {
    return 'list';
  }

  if (NUMERIC_OPERATORS.includes(operator)) {
    return 'number';
  }

  if (SUBSTRING_OPERATORS.includes(operator)) {
    return 'text';
  }

  return 'scalar';
}

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
};
