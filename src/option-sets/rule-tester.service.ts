import { Injectable } from '@nestjs/common';

import { evaluateRules, type EvaluableRule } from '../common/rules/rule-evaluator';
import { OptionSetTreeLoader } from './serialization/option-set-tree.loader';
import type { OptionSetTree } from './serialization/option-set.serializer';

/** What the tester answers, keyed by option id. */
export interface RuleTestResult {
  /** Option ids a rule has hidden, in the tree's own order. */
  readonly hiddenOptionIds: readonly string[];
  /** Group ids a rule has hidden. */
  readonly hiddenGroupIds: readonly string[];
  /** Value ids a rule has hidden — a removed choice, not a removed question. */
  readonly hiddenValueIds: readonly string[];
  /** Option ids a rule has made required, and ones it has made optional. */
  readonly requiredOptionIds: readonly string[];
  readonly optionalOptionIds: readonly string[];
  /** How many passes the evaluation took. */
  readonly passes: number;
  /** Set when evaluation refused; the caller must not read the lists. */
  readonly refused: string | null;
}

/**
 * "What would a customer see, given these answers?" (M17.6).
 *
 * 🔴 **This is the TypeScript evaluator's first production caller**, and the
 * reason ADR-053 put the tester on the server rather than in the dashboard. The
 * question a merchant is asking is *"what will the storefront do?"*, and the
 * honest way to answer it is to ask the thing that decides — not a fourth
 * implementation that is correct only for as long as it agrees.
 *
 * ⚠️ **It reads the merchant's DRAFT, not the published snapshot.** A rule
 * being tested has usually not been published yet, and a tester that could not
 * see it would answer a question nobody asked. The config document is assembled
 * from published snapshots precisely so it cannot ship unpublished edits; this
 * is the deliberate opposite.
 *
 * 🔴 **It reports visibility and required, never a price.** AC4 makes price
 * server-authoritative at add-to-cart, and what a `set_price` rule does to a
 * quoted total is the question M17.9 left open for 17-11. A tester that answered
 * it would settle it by accident.
 */
@Injectable()
export class RuleTesterService {
  constructor(private readonly trees: OptionSetTreeLoader) {}

  /**
   * Evaluate a set's live rules against supplied answers.
   *
   * @param optionSetId The set to test.
   * @param answers     Option id -> what a customer answered.
   */
  async test(optionSetId: string, answers: Record<string, unknown>): Promise<RuleTestResult> {
    const tree = await this.trees.load(optionSetId);

    const outcome = evaluateRules(
      tree.rules.filter((rule) => rule.isEnabled).map((rule) => this.evaluable(rule)),
      answers,
      this.containment(tree),
    );

    if (outcome.refused !== null) {
      /*
       * ADR-050: a refusal carries no partial state, and neither does this.
       * Returning the lists reached would let a merchant tune a rule against a
       * picture the storefront will never show.
       */
      return {
        hiddenOptionIds: [],
        hiddenGroupIds: [],
        hiddenValueIds: [],
        requiredOptionIds: [],
        optionalOptionIds: [],
        passes: outcome.passes,
        refused: outcome.refused,
      };
    }

    const kinds = this.kindsIn(tree);
    const hiddenOptionIds: string[] = [];
    const hiddenGroupIds: string[] = [];
    const hiddenValueIds: string[] = [];
    const requiredOptionIds: string[] = [];
    const optionalOptionIds: string[] = [];

    outcome.states.forEach((state, targetId) => {
      if (state.hidden) {
        const into =
          kinds.get(targetId) === 'group'
            ? hiddenGroupIds
            : kinds.get(targetId) === 'value'
              ? hiddenValueIds
              : hiddenOptionIds;

        into.push(targetId);
      }

      /*
       * `required` is per target, and only an option can be answered — so a
       * `require` on a group is reported against every option inside it, which
       * is what a merchant means by requiring a group.
       */
      if (state.required !== null) {
        const affected = this.containment(tree).get(targetId) ?? [];
        const into = state.required ? requiredOptionIds : optionalOptionIds;

        affected.forEach((optionId) => into.push(optionId));
      }
    });

    return {
      hiddenOptionIds,
      hiddenGroupIds,
      hiddenValueIds,
      requiredOptionIds,
      optionalOptionIds,
      passes: outcome.passes,
      refused: null,
    };
  }

  /**
   * Which options each target controls — *"whose answer disappears?"*.
   *
   * 🔴 **A value maps to NOTHING, and that is not an oversight.** Hiding one
   * colour of five removes a **choice**, not the question, so the option stays
   * answerable with its others. `publish-check.ts` keeps the opposite mapping
   * deliberately, because its cycle detector asks what a target can *reach* —
   * two questions, two maps. Conflating them deleted a customer's answer once
   * already (M17.8's audit), and the plugin's `index_containment()` carries the
   * same note.
   */
  private containment(tree: OptionSetTree): Map<string, readonly string[]> {
    const under = new Map<string, readonly string[]>();

    tree.groups.forEach(({ group, options }) => {
      under.set(
        group.id,
        options.map(({ option }) => option.id),
      );

      options.forEach(({ option, values }) => {
        under.set(option.id, [option.id]);
        values.forEach((value) => under.set(value.id, []));
      });
    });

    return under;
  }

  /**
   * What kind of thing each id names.
   *
   * The evaluator keys its states by `targetId` and carries no `targetType` —
   * deliberately, because conflict resolution is per target and the type never
   * enters it. The caller needs the type to report against, so it is recovered
   * from the tree rather than trusted from the rule.
   */
  private kindsIn(tree: OptionSetTree): Map<string, 'group' | 'option' | 'value'> {
    const kinds = new Map<string, 'group' | 'option' | 'value'>();

    tree.groups.forEach(({ group, options }) => {
      kinds.set(group.id, 'group');

      options.forEach(({ option, values }) => {
        kinds.set(option.id, 'option');
        values.forEach((value) => kinds.set(value.id, 'value'));
      });
    });

    return kinds;
  }

  /** One stored rule, in the shape the evaluator reads. */
  private evaluable(rule: OptionSetTree['rules'][number]): EvaluableRule {
    return {
      id: rule.id,
      targetType: rule.targetType,
      targetId: rule.targetId,
      action: rule.action,
      matchType: rule.matchType,
      /*
       * ⚠️ **Cast through `unknown`, because the column is typed loosely and the
       * evaluator is not.**
       *
       * `OptionRule.conditions` is `Record<string, unknown>[]` — the shape a
       * JSON column has before anything validates it. What is *stored* is
       * narrower: `ruleConditionsSchema` is `.strict()` and every write goes
       * through it, so a row's conditions are `{ optionId, operator, value? }`
       * by construction.
       *
       * 🔴 **The evaluator must not trust that anyway**, and does not: an
       * unknown operator is `false` and a malformed condition never fires (AC4
       * — the document is input, not authority). So the cast asserts a shape the
       * schema guarantees, into a function that survives it being wrong.
       *
       * The honest fix is typing the column, which M17.10 does for the authoring
       * projection the dashboard reads. The entity is a wider change with its
       * own migration questions, and is not this stage's.
       */
      conditions: Array.isArray(rule.conditions)
        ? (rule.conditions as unknown as EvaluableRule['conditions'])
        : [],
      actionValue: rule.actionValue,
    };
  }
}
