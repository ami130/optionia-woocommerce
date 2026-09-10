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
  /**
   * The options hidden so far. **Accumulated, never recomputed.**
   *
   * 🔴 **This is what stops an ordinary rule oscillating for ever.** Hiding an
   * option clears its answer (ADR-051), so a rule whose condition reads an
   * option its own target contains would otherwise flip between two states:
   *
   * ```text
   * pass 1  A answered -> "hide A when A is answered" fires -> A cleared
   * pass 2  A cleared   -> the rule no longer fires        -> A restored
   * pass 3  identical to pass 1, for ever
   * ```
   *
   * Measured before this set existed: that rule reached the cap and **refused**,
   * making the product unbuyable — while **M17.3 publishes it with a 201**,
   * because its cycle detector deliberately exempts a self-edge as a legitimate
   * one-step rule. The publish gate and the evaluator contradicted each other,
   * and the evaluator was the half that was wrong.
   *
   * ⚠️ **Not confined to self-reference.** Any rule whose *target contains* the
   * option its condition reads had the same shape — measured, a group hiding the
   * option its own condition tested refused, while the same rule over a group not
   * containing that option settled in two passes.
   *
   * Accumulating keeps the fixed point **monotone**: a hide never comes back off,
   * so each pass can only add, and the loop must settle. It is also what a
   * customer sees — a field that vanished does not reappear because vanishing
   * removed the reason it vanished.
   */
  const hidden = new Set<string>();
  let current: Record<string, unknown> = { ...answers };

  for (let pass = 1; pass <= MAX_RULE_PASSES; pass += 1) {
    const states = resolve(rules, current, hidden);

    states.forEach((state, targetId) => {
      if (state.hidden) {
        hidden.add(targetId);
      }
    });

    /*
     * ADR-051: a rule-hidden option is not charged and not stored, so its answer
     * is cleared before the next pass — and a cleared answer may satisfy another
     * rule's condition, which is what makes cascading real.
     *
     * Rebuilt from the ORIGINAL answers each pass rather than mutated, so the
     * result cannot depend on the order rules were visited (M17.2). What carries
     * between passes is `hidden`, not the answers.
     */
    const next: Record<string, unknown> = { ...answers };

    hidden.forEach((targetId) => {
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
function resolve(
  rules: readonly EvaluableRule[],
  answers: Answers,
  alreadyHidden: ReadonlySet<string>,
): Map<string, TargetState> {
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

  /*
   * 🔴 **A target hidden by an earlier pass stays hidden**, even when the rule
   * that hid it no longer fires — because what stopped it firing was the hide
   * itself clearing the answer its condition read.
   *
   * This one block is what makes the fixed point **monotone**, and therefore what
   * makes it terminate. Without it, "hide A when A is answered" flips between two
   * states for ever and reaches the cap — measured, and **M17.3 publishes that
   * rule with a 201**, deliberately exempting a self-edge as a legitimate
   * one-step rule. The evaluator refusing it made the product unbuyable on a
   * document the publish gate had approved.
   *
   * ⚠️ **One mechanism, not two.** An earlier version also seeded `hidden` from
   * this set inside `seed()`, which was redundant — mutation showed removing
   * *either* half alone changed nothing, because each hid the other's absence.
   * Two mechanisms for one fact is the divergence shape this codebase keeps
   * paying for, so the seeding went and this stayed.
   *
   * It also matches what a customer sees: a field that vanished does not
   * reappear because vanishing removed the reason it vanished.
   */
  alreadyHidden.forEach((targetId) => {
    states.set(targetId, {
      ...(states.get(targetId) ?? {
        required: null,
        priceMinor: null,
        defaultValueKey: null,
      }),
      hidden: true,
    });
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
  const left = numericValue(answer);
  const right = numericValue(operand);

  if (left === null || right === null) {
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

/**
 * A value as a number, or `null` when it is not one.
 *
 * 🔴 **Neither language's own coercion can be trusted here, and they disagree in
 * opposite directions.** Measured:
 *
 * | Input | `Number()` (JS) | `(float)` (PHP) | `is_numeric()` (PHP) |
 * |---|---|---|---|
 * | `"abc"` | `NaN` | **`0.0`** | false |
 * | `"0x10"` | **`16`** | `0.0` | false |
 * | `"9abc"` | `NaN` | **`9.0`** | false |
 * | `"1e3"` | `1000` | `1000.0` | true |
 * | `" 9 "` | `9` | `9.0` | true |
 *
 * So PHP's cast makes `less_than 5` fire on the answer `"abc"`, and JavaScript's
 * makes `greater_than 5` fire on `"0x10"`. **A rule's outcome decides whether a
 * field is hidden, and ADR-051 makes a hidden field one that is not charged** —
 * so a disagreement here is a disagreement about money.
 *
 * The shared rule fixture pins the answer: **decimal notation only**, matching
 * `is_numeric()` minus its hex-free quirks. Anything else is not a number, in
 * both languages, whatever their casts would say.
 */
function numericValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  /*
   * Decimal, with an optional sign and exponent. Deliberately NOT `Number()`:
   * that accepts `0x10`, `0b11` and `Infinity`, none of which `is_numeric()`
   * reads the same way — and a rule that fires in one language only is the
   * defect a shared fixture exists to prevent.
   */
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
}

/** An `in` / `not_in` operand, defensively. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
