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
  /**
   * Rules belonging to the set, live only.
   *
   * ✏️ **`conditions`, `matchType` and `action` added in M17.3.** The loader has always
   * fetched whole `OptionRule` rows; this interface narrowed them to what the
   * checks of the day needed. Cycle detection needs the conditions — they are
   * the *inputs* half of every edge — so the narrowing is widened rather than
   * the loader changed. "Extended, never narrowed", as this block says.
   *
   * `conditions` is typed as the stored shape rather than `RuleCondition[]`:
   * a validator reads rows that may predate today's schema, and a check that
   * throws on unfamiliar JSON would refuse a publish for the wrong reason.
   */
  readonly rules: ReadonlyArray<{
    id: string;
    targetType: string;
    targetId: string;
    isEnabled: boolean;
    disabledReason: string | null;
    conditions: readonly unknown[];
    matchType: string;
    action: string;
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

/**
 * Every id in a set, sorted by what kind of thing it names.
 *
 * Built once per validator run rather than per rule: a set may hold two hundred
 * rules, and rebuilding this for each would walk the whole tree two hundred times
 * to answer the same question.
 *
 * 🔴 **Two answers, because "in the set" and "in the document" are different
 * questions and conflating them hid a defect.**
 *
 * `OptionSetSerializer` drops a disabled thing **entirely** — its own docblock
 * says so: *"a disabled thing is absent from the document entirely, so the flag
 * has nothing left to say."* Groups, options and values are each filtered on
 * `isEnabled` on the way out.
 *
 * So a rule may name an id that is genuinely in the set and genuinely **absent
 * from what publishes**. Measured before this split: such a rule published with
 * a 201 and no finding at all — the same "publishes and silently governs
 * nothing" defect this validator exists to prevent, reached through a door it
 * was not watching. Nothing else catches it either: `CascadeService` fires on
 * **delete**, never on disable.
 *
 * `groups` / `options` / `values` answer *"is it in the set"*; the `published`
 * sets answer *"will it be in the document"*.
 */
function idsIn(tree: OptionSetTree): {
  groups: Set<string>;
  options: Set<string>;
  values: Set<string>;
  /** The same three, narrowed to what a publish will actually emit. */
  published: { groups: Set<string>; options: Set<string>; values: Set<string> };
  /** Option ids reachable from a target, whatever kind that target names. */
  optionsUnder: Map<string, readonly string[]>;
} {
  const groups = new Set<string>();
  const options = new Set<string>();
  const values = new Set<string>();
  const published = {
    groups: new Set<string>(),
    options: new Set<string>(),
    values: new Set<string>(),
  };
  const optionsUnder = new Map<string, readonly string[]>();

  tree.groups.forEach(({ group, options: children }) => {
    groups.add(group.id);
    optionsUnder.set(
      group.id,
      children.map(({ option }) => option.id),
    );

    if (group.isEnabled) {
      published.groups.add(group.id);
    }

    children.forEach(({ option, values: optionValues }) => {
      options.add(option.id);
      /* An option target affects exactly itself. */
      optionsUnder.set(option.id, [option.id]);

      /*
       * An option inside a disabled group does not publish either, however
       * enabled it is itself — the serializer drops the whole group.
       */
      const optionPublishes = group.isEnabled && option.isEnabled;

      if (optionPublishes) {
        published.options.add(option.id);
      }

      optionValues.forEach((value) => {
        values.add(value.id);
        /* A value target affects the option that owns it. */
        optionsUnder.set(value.id, [option.id]);

        if (optionPublishes && value.isEnabled) {
          published.values.add(value.id);
        }
      });
    });
  });

  return { groups, options, values, published, optionsUnder };
}

/**
 * Every id a rule names must belong to the set being published.
 *
 * 🔴 **A blocker, and this is the stage that can decide it.** M17.1 validates
 * `targetId` for shape and M17.1's CRUD checks the row exists and is the kind
 * claimed — but "is it in *this* set" needs the whole set loaded, which is what
 * a publish context is.
 *
 * Blocking rather than warning, because the plugin cannot resolve an id the
 * document does not contain: a published cross-set rule is one that **silently
 * governs nothing**, and the merchant discovers it from a customer.
 *
 * ⚠️ **Worse than an ordinary stale rule.** `CascadeService` disables a rule
 * whose target was deleted and records `TARGET_DELETED`, so the merchant is
 * told. A cross-set target is never swept by that: a cascade sweeps within the
 * deleted row's own set, so the other set's delete never reaches this rule. This
 * check is the only thing standing between that rule and a storefront.
 *
 * ⚠️ **A rule the cascade already disabled is NOT reported here.**
 * `rulesHaveTargets` above owns that case and makes it a *warning*, on the
 * stated grounds that a disabled rule cannot reach a storefront — the merchant
 * is told, and the publish proceeds. Blocking it here would silently reverse
 * that decision and refuse a publish over logic already switched off.
 *
 * The case this owns is the opposite one: a rule that is **live**, whose target
 * exists somewhere, and is in the wrong set. Nothing sweeps that — a cascade
 * sweeps within the deleted row's own set — so without this check it publishes.
 *
 * A rule the *merchant* disabled is still checked. That is one they intend to
 * re-enable, and letting it publish broken only defers the same failure.
 */
export const ruleTargetsAreInThisSet: PublishValidator = {
  name: 'rule-targets-are-in-this-set',
  validate({ tree, rules }) {
    const { groups, options, values, published } = idsIn(tree);
    const findings: PublishFinding[] = [];

    /* Owned by `rulesHaveTargets`, which warns rather than blocks. */
    const live = rules.filter((rule) => rule.disabledReason !== 'target_deleted');

    const holds = (targetType: string, id: string): boolean => {
      switch (targetType) {
        case 'group':
          return groups.has(id);
        case 'option':
          return options.has(id);
        case 'value':
          return values.has(id);
        default:
          /*
           * An unrecognised target type is reported by falling through to the
           * finding below rather than throwing. A row written by a future build
           * must not make a publish fail with a stack trace.
           */
          return false;
      }
    };

    live.forEach((rule) => {
      if (!holds(rule.targetType, rule.targetId)) {
        findings.push({
          severity: PublishSeverity.BLOCKER,
          code: 'RULE_TARGET_NOT_IN_SET',
          subject: `rule:${rule.id}`,
          message:
            `A rule acts on a ${rule.targetType} that is not part of this option set, ` +
            'so it could never apply. Point it at something in this set, or delete it.',
        });
      }

      conditionOptionIds(rule.conditions).forEach((optionId) => {
        if (!options.has(optionId)) {
          findings.push({
            severity: PublishSeverity.BLOCKER,
            code: 'RULE_CONDITION_NOT_IN_SET',
            subject: `rule:${rule.id}`,
            message:
              'A rule tests an option that is not part of this option set, so its ' +
              'condition could never be answered.',
          });
        }
      });
    });

    return [
      ...findings,
      ...targetsThatWillNotPublish(rules, published, (rule) =>
        holds(rule.targetType, rule.targetId),
      ),
    ];
  },
};

/**
 * Rules naming something real that this publish will **not emit**.
 *
 * 🔴 **The gap between "in the set" and "in the document".** A disabled group,
 * option or value is dropped by the serializer entirely, so a rule pointing at
 * one publishes and then finds nothing to act on. Measured before this check:
 * a 201 with **no finding at all** — the same defect `RULE_TARGET_NOT_IN_SET`
 * exists to prevent, one state earlier.
 *
 * Nothing else catches it. `CascadeService` reacts to a **delete**, never to a
 * disable, so `TARGET_DELETED` is never recorded and the merchant is never told.
 *
 * ⚠️ **A warning, not a blocker, and the difference from a cross-set target is
 * real.** Disabling is reversible and routinely deliberate mid-edit — a merchant
 * turning an option off, publishing, and turning it back on is ordinary work,
 * and blocking it would make the natural order of work an error. A cross-set id
 * is never going to resolve; a disabled one resolves the moment it is re-enabled.
 *
 * The precedent is `rulesHaveTargets`, which warns for the same reason: the rule
 * cannot misbehave, it simply will not fire, and the merchant needs to know
 * before a customer does.
 *
 * ⚠️ **Disabled rules are skipped.** A rule that is off, pointing at something
 * that is off, is not a surprise waiting to happen.
 */
function targetsThatWillNotPublish(
  rules: PublishContext['rules'],
  published: { groups: Set<string>; options: Set<string>; values: Set<string> },
  isInThisSet: (rule: PublishContext['rules'][number]) => boolean,
): readonly PublishFinding[] {
  const willPublish = (targetType: string, id: string): boolean => {
    switch (targetType) {
      case 'group':
        return published.groups.has(id);
      case 'option':
        return published.options.has(id);
      case 'value':
        return published.values.has(id);
      default:
        /* An unknown type is already a blocker above; say nothing twice. */
        return true;
    }
  };

  return rules
    .filter(
      (rule) =>
        rule.isEnabled &&
        rule.disabledReason !== 'target_deleted' &&
        /*
         * Only for a target that IS in the set. One that is not is already a
         * blocker, and a second finding about the same rule would bury the one
         * that actually stops the publish.
         */
        isInThisSet(rule) &&
        !willPublish(rule.targetType, rule.targetId),
    )
    .map((rule) => ({
      severity: PublishSeverity.WARNING,
      code: 'RULE_TARGET_NOT_PUBLISHED',
      subject: `rule:${rule.id}`,
      message:
        `A rule acts on a ${rule.targetType} that is disabled, so it is left out of ` +
        'the published configuration and the rule will not fire. Re-enable it, or ' +
        'remove the rule.',
    }));
}

/**
 * The options a condition list reads.
 *
 * ⚠️ **Defensive about the stored shape.** `conditions` is a `json` column, so a
 * row may predate today's schema or have been written by hand. Anything
 * unrecognised contributes no ids rather than throwing: a publish must not fail
 * with a stack trace because one rule holds unfamiliar JSON, and
 * `ruleConditionsSchema` is what refuses malformed conditions at the door.
 */
function conditionOptionIds(conditions: readonly unknown[]): readonly string[] {
  if (!Array.isArray(conditions)) {
    return [];
  }

  return conditions.flatMap((condition) => {
    if (typeof condition !== 'object' || condition === null) {
      return [];
    }

    const optionId = (condition as Record<string, unknown>).optionId;

    return typeof optionId === 'string' ? [optionId] : [];
  });
}

/**
 * The actions that change what a **later rule can read**.
 *
 * 🔴 **Not every action creates an edge, and treating all six as edges refuses
 * publishes that are perfectly sound.**
 *
 * A rule's condition reads an option's *answer*. So an action forms an edge only
 * if it can change one:
 *
 * | Action | Edge? | Why |
 * |---|---|---|
 * | `show` / `hide` | **yes** | An option that is not rendered has no answer |
 * | `set_default` | **yes** | It writes the answer directly |
 * | `set_price` | no | Changes what a line costs, never an answer |
 * | `require` / `unrequire` | no | Changes validation, never an answer |
 *
 * ⚠️ **`set_price` is the one worth naming.** It is the most consequential action
 * in the vocabulary — ADR-049 gives it the power to replace a value's delta — and
 * it is still not an edge, because money is an output of evaluation rather than
 * an input to it. Severity and graph position are different questions.
 */
const ANSWER_AFFECTING_ACTIONS: ReadonlySet<string> = new Set(['show', 'hide', 'set_default']);

/**
 * Rules that depend on each other in a loop cannot settle (M17.3).
 *
 * ADR-050: the evaluator refuses rather than accepting a truncated pass, so a
 * published cycle is a line a customer cannot buy. **A blocker.**
 *
 * ## What an edge is
 *
 * A rule reads options (its conditions) and affects options (its target). The
 * edge runs **read → affected**, so a cycle is a set of rules each waiting on
 * the last.
 *
 * 🔴 **The nodes are not all the same kind, which is the whole difficulty.** A
 * condition always names an **option**; a target may be a **group**, an
 * **option** or a **value**. So this resolves a target to the options it
 * contains before drawing any edge — a group to its options, a value to the
 * option that owns it. Without that step this cycle is invisible:
 *
 * ```text
 * rule 1: hide GROUP g   when option A is empty
 * rule 2: show option A  when option B equals x     (B lives in g)
 * ```
 *
 * ⚠️ **A self-loop is legitimate and must not fire.** *"Hide A when A is empty"*
 * is a one-step rule a merchant may reasonably write, verified accepted by the
 * 17-2 audit. Only a loop **through another rule** cannot settle.
 *
 * ⚠️ **Disabled rules are excluded here, unlike the target check above.** A
 * cycle among rules that never run is not a cycle a storefront can reach, and
 * blocking it would refuse a publish over logic the merchant has already
 * switched off.
 */
export const rulesHaveNoCycles: PublishValidator = {
  name: 'rules-have-no-cycles',
  validate({ tree, rules }) {
    const { optionsUnder } = idsIn(tree);

    /** option id -> the options its answer can go on to affect. */
    const edges = new Map<string, Set<string>>();

    rules
      .filter((rule) => rule.isEnabled && ANSWER_AFFECTING_ACTIONS.has(rule.action))
      .forEach((rule) => {
        const affected = optionsUnder.get(rule.targetId) ?? [];

        conditionOptionIds(rule.conditions).forEach((readOption) => {
          affected.forEach((affectedOption) => {
            /*
             * A rule whose target is the option it reads is a one-step rule, not
             * a loop. Dropping the self-edge here is what keeps the detector from
             * over-firing on it.
             */
            if (affectedOption === readOption) {
              return;
            }

            const bucket = edges.get(readOption);

            if (bucket) {
              bucket.add(affectedOption);
            } else {
              edges.set(readOption, new Set([affectedOption]));
            }
          });
        });
      });

    return cycleIn(edges)
      ? [
          {
            severity: PublishSeverity.BLOCKER,
            code: 'RULES_FORM_A_CYCLE',
            subject: `set:${tree.set.id}`,
            message:
              'Two or more rules depend on each other in a loop, so the options they ' +
              'control can never settle. Remove one of the conditions that closes the loop.',
          },
        ]
      : [];
  },
};

/**
 * Whether a directed graph holds a cycle.
 *
 * Iterative depth-first search with an explicit stack. **Not recursion:** a set
 * may hold two hundred rules over as many options, and a deep chain would risk a
 * stack overflow inside a publish — which would surface as a 500 rather than as
 * the actionable message this check exists to produce.
 */
function cycleIn(edges: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const settled = new Set<string>();
  const onPath = new Set<string>();

  for (const start of edges.keys()) {
    if (settled.has(start)) {
      continue;
    }

    /* `enter` distinguishes descending into a node from returning through it. */
    const stack: Array<{ node: string; enter: boolean }> = [{ node: start, enter: true }];

    while (stack.length > 0) {
      const step = stack.pop();

      if (!step) {
        break;
      }

      if (!step.enter) {
        onPath.delete(step.node);
        settled.add(step.node);
        continue;
      }

      if (onPath.has(step.node)) {
        return true;
      }

      if (settled.has(step.node)) {
        continue;
      }

      onPath.add(step.node);
      stack.push({ node: step.node, enter: false });

      (edges.get(step.node) ?? new Set<string>()).forEach((next) => {
        if (!settled.has(next)) {
          stack.push({ node: next, enter: true });
        }
      });
    }
  }

  return false;
}

/**
 * The price types that live on an **option** rather than a value.
 *
 * Each holds a **function of the customer's input** — a rate per character, a
 * rate per unit, a bracket table — not an amount. `PRICING-SPEC.md` §2 places
 * all three at the option level for that reason.
 */
const OPTION_LEVEL_PRICE_TYPES: ReadonlySet<string> = new Set(['per_char', 'per_unit', 'tiered']);

/**
 * `set_price` cannot override an option that prices itself (ADR-049).
 *
 * 🔴 **A blocker, and ADR-049 said so in 17-0 while nothing implemented it.**
 * The decision was written, tagged M17.4, and fell between stages: too
 * pricing-specific for 17-3's cycle work, and assumed already done by the time
 * 17-4 planned to consume it. Found by auditing what the ADR claimed against
 * what the code did.
 *
 * ## Why refusing is the honest answer
 *
 * `per_char`, `per_unit` and `tiered` hold a **function**, not a number. A rule
 * setting a flat amount on one does not override a value — it **replaces a
 * function with a constant**, discarding the merchant's rate silently and
 * charging the same for a 3-character engraving as for a 300-character one.
 * There is no arithmetic that reconciles them.
 *
 * ⚠️ **Refused at publish rather than at authoring**, deliberately. A merchant
 * may author the rule and *then* change the option's pricing to `per_unit`,
 * which would make an already-saved rule invalid — validating only at creation
 * would let that through. Publish is where the whole document is visible at
 * once, which is the same reason cycle detection lives here.
 *
 * ⚠️ **A rule targeting a VALUE is fine even when its option prices itself.**
 * The two never collide: an option-level type prices what the customer supplied,
 * and an option that supplies a quantity or a string has no values to target.
 */
export const setPriceDoesNotFightOptionPricing: PublishValidator = {
  name: 'set-price-does-not-fight-option-pricing',
  validate({ tree, rules }) {
    /** Option id -> the option-level price type it carries, if any. */
    const optionPricing = new Map<string, string>();

    tree.groups.forEach(({ options }) => {
      options.forEach(({ option }) => {
        const type = (option.pricing as Record<string, unknown> | null)?.type;

        if (typeof type === 'string' && OPTION_LEVEL_PRICE_TYPES.has(type)) {
          optionPricing.set(option.id, type);
        }
      });
    });

    return rules
      .filter((rule) => rule.isEnabled && rule.action === 'set_price')
      .flatMap((rule) => {
        const type = optionPricing.get(rule.targetId);

        if (rule.targetType !== 'option' || type === undefined) {
          return [];
        }

        return [
          {
            severity: PublishSeverity.BLOCKER,
            code: 'SET_PRICE_OVERRIDES_OPTION_PRICING',
            subject: `rule:${rule.id}`,
            message:
              `A rule sets a flat price on an option priced by ${type}, which charges ` +
              'by what the customer supplies. The rule would replace that rate with one ' +
              'amount for every customer. Point the rule at a value, or remove it.',
          },
        ];
      });
  },
};

export const PUBLISH_VALIDATORS: readonly PublishValidator[] = [
  setHasContent,
  optionsHaveValues,
  rulesHaveTargets,
  ruleTargetsAreInThisSet,
  rulesHaveNoCycles,
  setPriceDoesNotFightOptionPricing,
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
