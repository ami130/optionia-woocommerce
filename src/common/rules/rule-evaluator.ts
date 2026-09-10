/**
 * The rule evaluator (M17.2), in TypeScript.
 *
 * The plugin holds a PHP twin, and both answer to one shared fixture. This file
 * is the cloud half; the two are held together by `bin/check-shared-fixtures.sh`
 * exactly as the pricing evaluators are.
 *
 * ## What "order-independent" means here
 *
 * M17.2 requires evaluation be **deterministic and order-independent**, and
 * `sortOrder` is presentation rather than precedence. So the pass order cannot
 * decide anything, and two rules acting on one target in opposite directions
 * are resolved by **what they say**, not by which ran first (ADR-052):
 *
 * | Pair | Winner |
 * |---|---|
 * | `show` / `hide` | **`hide`** — a hidden field cannot be filled |
 * | `require` / `unrequire` | **`require`** — refusing an incomplete order is recoverable |
 *
 * 🔴 **`hide` winning is what makes ADR-051 safe.** A rule-hidden option is not
 * charged and not stored. If `show` could win, a rule meaning to hide an option
 * could be overridden and the customer charged for a field their own
 * configuration removed — 16c's defect with a rule in front of it.
 *
 * ## Cascading, and why a fixed point rather than one pass
 *
 * Hiding an option clears its answer (ADR-051), and a cleared answer may satisfy
 * another rule's condition. So evaluation runs to a **fixed point**: repeat
 * until nothing changes.
 *
 * 🔴 **The cap refuses; it does not return what it reached** (ADR-050). A
 * truncated pass is a wrong price that looks right, which this project has
 * shipped twice — 16c quoted 85.00 and charged 130.00, and 16d made an option
 * silently free at an overflow boundary. Both passed their suites.
 *
 * ⚠️ **The cap is not a limit on legitimate depth.** A document needing more
 * passes than this is one the merchant should be told about at publish, which is
 * M17.3's cycle detection. This bounds what a **cached** document can cost a
 * storefront — the plugin evaluates documents no publish check has seen.
 */

/** Every action a rule may take. */
export const RULE_ACTIONS = [
  'show',
  'hide',
  'require',
  'unrequire',
  'set_price',
  'set_default',
] as const;
export type RuleActionName = (typeof RULE_ACTIONS)[number];

/**
 * The most passes a rule set may take to settle.
 *
 * Each pass can only ever *add* a hide or a require — the resolution table has
 * no way back — so a set of N rules settles in at most N passes. Ten is far
 * above any real cascade: a rule hiding a group whose option feeds a rule hiding
 * another is two.
 *
 * A constant with a stated reason rather than a tuned number: it bounds the work
 * a hostile or corrupt document can cause on a storefront page render.
 */
export const MAX_RULE_PASSES = 10;

/** One condition, in the shape the published document carries. */
export interface EvaluableCondition {
  readonly optionId: string;
  readonly operator: string;
  readonly value?: unknown;
}

/** One rule, in the shape the published document carries. */
export interface EvaluableRule {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly action: string;
  readonly matchType: string;
  readonly conditions: readonly EvaluableCondition[];
  readonly actionValue?: Record<string, unknown> | null;
}

/** What the customer has answered so far, keyed by option id. */
export type Answers = Readonly<Record<string, unknown>>;

/**
 * What a target resolves to, once every rule that fires has been collected.
 *
 * Absent means "no rule said anything", which is different from a rule saying
 * the default: a merchant can see that difference in the builder.
 */
export interface TargetState {
  readonly hidden: boolean;
  readonly required: boolean | null;
  readonly priceMinor: number | null;
  readonly defaultValueKey: string | null;
}

export interface RuleOutcome {
  /** Target id -> what the rules decided about it. */
  readonly states: ReadonlyMap<string, TargetState>;
  /** How many passes it took to settle. */
  readonly passes: number;
  /**
   * Set when evaluation was refused rather than completed.
   *
   * `null` on success. A caller must treat a non-null reason as "this line
   * cannot be priced", never as "no rules applied" (ADR-050).
   */
  readonly refused: string | null;
}

/**
 * Whether one condition holds against the answers so far.
 *
 * ⚠️ **An unknown operator is `false`, not a throw.** The document is input
 * rather than authority (AC4), and a plugin build older than the operator that
 * reaches it must render the product rather than refuse it. The authoring API
 * is where an unknown operator is an error.
 */
export function conditionHolds(condition: EvaluableCondition, answers: Answers): boolean {
  const answer = answers[condition.optionId];
  const supplied = answer !== undefined && answer !== null && answer !== '';

  switch (condition.operator) {
    case 'is_empty':
      return !supplied;
    case 'is_not_empty':
      return supplied;
    case 'equals':
      return supplied && sameScalar(answer, condition.value);
    case 'not_equals':
      /*
       * ⚠️ **An unanswered option does NOT satisfy `not_equals`.** "Colour is
       * not red" reads as a question about a colour that was chosen; treating a
       * blank as a match would fire the rule on a form the customer has not
       * begun. `is_empty` is how a merchant asks about absence.
       */
      return supplied && !sameScalar(answer, condition.value);
    case 'contains':
      return supplied && typeof condition.value === 'string' && String(answer).includes(condition.value);
    case 'greater_than':
      return compareNumeric(answer, condition.value, (a, b) => a > b);
    case 'less_than':
      return compareNumeric(answer, condition.value, (a, b) => a < b);
    case 'in':
      return supplied && listOf(condition.value).some((entry) => sameScalar(answer, entry));
    case 'not_in':
      return supplied && !listOf(condition.value).some((entry) => sameScalar(answer, entry));
    default:
      return false;
  }
}

/**
 * Whether a rule's conditions are satisfied, under its own connective.
 *
 * ⚠️ **A rule with no conditions never fires.** The authoring schema refuses
 * one, so this can only be reached by a document written before that check —
 * and a rule that always fires is not a conditional rule at all. `false` is the
 * safe direction: it leaves the storefront as the merchant would see it without
 * the rule.
 */
export function ruleFires(rule: EvaluableRule, answers: Answers): boolean {
  if (rule.conditions.length === 0) {
    return false;
  }

  return rule.matchType === 'any'
    ? rule.conditions.some((condition) => conditionHolds(condition, answers))
    : rule.conditions.every((condition) => conditionHolds(condition, answers));
}

/**
 * Evaluate a rule set to a fixed point.
 *
 * `answersFor` maps a target id to the options whose answers it controls —
 * a group target controls every option inside it, an option controls itself,
 * a value controls the option that owns it. The caller supplies it because only
 * the caller has the document; the evaluator stays a pure function of its
 * arguments, which is what lets one fixture drive two languages.
 */
export function evaluateRules(
  rules: readonly EvaluableRule[],
  answers: Answers,
  optionsUnder: ReadonlyMap<string, readonly string[]>,
): RuleOutcome {
  let current: Record<string, unknown> = { ...answers };

  for (let pass = 1; pass <= MAX_RULE_PASSES; pass += 1) {
    const states = resolve(rules, current);
    const next: Record<string, unknown> = { ...answers };

    /*
     * ADR-051: a rule-hidden option is not charged and not stored, so its answer
     * is cleared before the next pass — and a cleared answer may satisfy another
     * rule's condition, which is what makes cascading real.
     *
     * Rebuilt from the ORIGINAL answers each pass rather than mutated, so a
     * value cleared by a rule that stops firing comes back. Mutating would make
     * the result depend on pass order, which M17.2 forbids.
     */
    states.forEach((state, targetId) => {
      if (!state.hidden) {
        return;
      }

      (optionsUnder.get(targetId) ?? []).forEach((optionId) => {
        delete next[optionId];
      });
    });

    /*
     * Settled when a pass changes nothing: the answers it would evaluate next
     * are the ones it just evaluated, so every further pass is identical.
     *
     * Compared against `current` rather than the previous *signature*, which is
     * the same question asked directly — an earlier version kept a signature
     * variable and needed a special case for the first pass, which is a state
     * machine where a comparison will do.
     */
    if (sameAnswers(next, current)) {
      return { states, passes: pass, refused: null };
    }

    current = next;
  }

  /*
   * 🔴 Refused, not truncated (ADR-050). Returning the state reached would be a
   * field wrongly shown or hidden and a price computed from it — a wrong price
   * that looks right, which is the shape this project has shipped twice.
   */
  return {
    states: new Map(),
    passes: MAX_RULE_PASSES,
    refused: 'Rules did not settle within the pass limit.',
  };
}

/**
 * Collect what every rule says, and resolve each target by ADR-052's table.
 *
 * 🔴 **No rule order is consulted.** `hide` beats `show` and `require` beats
 * `unrequire` because of what they mean, not because of when they ran — which is
 * what makes the result identical whatever order the rules arrive in, and what
 * makes a shared fixture meaningful at all.
 */
function resolve(rules: readonly EvaluableRule[], answers: Answers): Map<string, TargetState> {
  const states = new Map<string, TargetState>();

  const seed = (targetId: string): TargetState =>
    states.get(targetId) ?? {
      hidden: false,
      required: null,
      priceMinor: null,
      defaultValueKey: null,
    };

  rules.forEach((rule) => {
    if (!ruleFires(rule, answers)) {
      return;
    }

    const state = seed(rule.targetId);

    switch (rule.action) {
      case 'hide':
        states.set(rule.targetId, { ...state, hidden: true });
        break;
      case 'show':
        /* `hide` wins: never clear a hide that another rule set. */
        states.set(rule.targetId, state);
        break;
      case 'require':
        states.set(rule.targetId, { ...state, required: true });
        break;
      case 'unrequire':
        /* `require` wins, for the same reason `hide` does. */
        states.set(rule.targetId, {
          ...state,
          required: state.required === true ? true : false,
        });
        break;
      case 'set_price': {
        const amount = rule.actionValue?.amountMinor;

        if (typeof amount === 'number' && Number.isSafeInteger(amount)) {
          states.set(rule.targetId, { ...state, priceMinor: amount });
        }

        break;
      }
      case 'set_default': {
        const key = rule.actionValue?.valueKey;

        if (typeof key === 'string' && key !== '') {
          states.set(rule.targetId, { ...state, defaultValueKey: key });
        }

        break;
      }
      default:
        /* An action a newer build authored. Ignored, never fatal (AC4). */
        break;
    }
  });

  return states;
}

/**
 * Whether two scalars are the same answer.
 *
 * ⚠️ **Compared as strings when the types differ.** A customer's answer arrives
 * from a form and is a string; a merchant's operand may be typed as a number in
 * JSON. `"2" === 2` is false in both languages and the merchant meant yes —
 * whereas coercing with `==` differs between PHP and JavaScript for values like
 * `"0e0"`, which is exactly how two evaluators diverge.
 */
function sameScalar(answer: unknown, operand: unknown): boolean {
  if (typeof answer === typeof operand) {
    return answer === operand;
  }

  if (typeof operand === 'boolean' || typeof answer === 'boolean') {
    return String(answer) === String(operand);
  }

  return String(answer) === String(operand);
}

/**
 * Compare two values as numbers, or answer `false`.
 *
 * The schema already refuses a non-numeric operand for `greater_than` and
 * `less_than` (M17.1), because text has no ordering two languages agree on. This
 * is the second line: a document may carry a rule written before that check.
 */
function compareNumeric(
  answer: unknown,
  operand: unknown,
  compare: (a: number, b: number) => boolean,
): boolean {
  const left = Number(answer);
  const right = Number(operand);

  if (answer === '' || answer === null || answer === undefined) {
    return false;
  }

  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }

  return compare(left, right);
}

/**
 * Whether two answer sets are the same.
 *
 * Key-by-key rather than by serializing both: `JSON.stringify` orders keys by
 * insertion, so two identical answer sets built in different orders compare
 * unequal and the loop runs to the cap on a document that had already settled.
 */
function sameAnswers(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);

  if (keys.length !== Object.keys(b).length) {
    return false;
  }

  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

/** An `in` / `not_in` operand, defensively. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
