import {
  conditionHolds,
  evaluateRules,
  MAX_RULE_PASSES,
  ruleFires,
  type Answers,
  type EvaluableRule,
} from './rule-evaluator';

const A = '0199b8c2-0000-7000-8000-00000000000a';
const B = '0199b8c2-0000-7000-8000-00000000000b';
const C = '0199b8c2-0000-7000-8000-00000000000c';

function rule(overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  return {
    id: 'r1',
    targetType: 'option',
    targetId: A,
    action: 'hide',
    matchType: 'all',
    conditions: [{ optionId: B, operator: 'is_empty' }],
    ...overrides,
  };
}

/** Each option controls its own answer. Groups and values are the caller's job. */
const selfMap = new Map([
  [A, [A]],
  [B, [B]],
  [C, [C]],
]);

describe('conditionHolds', () => {
  describe('presence', () => {
    it.each([
      ['undefined', {}],
      ['null', { [B]: null }],
      ['empty string', { [B]: '' }],
    ])('treats %s as unanswered', (_label, answers) => {
      expect(conditionHolds({ optionId: B, operator: 'is_empty' }, answers as Answers)).toBe(true);
      expect(conditionHolds({ optionId: B, operator: 'is_not_empty' }, answers as Answers)).toBe(
        false,
      );
    });

    it('treats zero as answered, because 0 is a number a customer chose', () => {
      expect(conditionHolds({ optionId: B, operator: 'is_not_empty' }, { [B]: 0 })).toBe(true);
    });
  });

  describe('equality across the form boundary', () => {
    /**
     * 🔴 A customer's answer arrives from a form as a string; a merchant's
     * operand is typed in JSON. `"2" === 2` is false in both languages and the
     * merchant meant yes.
     */
    it('matches a string answer against a numeric operand', () => {
      expect(conditionHolds({ optionId: B, operator: 'equals', value: 2 }, { [B]: '2' })).toBe(true);
    });

    it('matches a boolean operand against its string form', () => {
      expect(conditionHolds({ optionId: B, operator: 'equals', value: true }, { [B]: 'true' })).toBe(
        true,
      );
    });

    /**
     * ⚠️ `"0e0" == "0"` is true under PHP's loose comparison and false in
     * JavaScript. Comparing as strings is what keeps the two languages agreeing.
     */
    it('does not treat "0e0" as zero', () => {
      expect(conditionHolds({ optionId: B, operator: 'equals', value: '0' }, { [B]: '0e0' })).toBe(
        false,
      );
    });
  });

  describe('not_equals', () => {
    it('holds when the answer differs', () => {
      expect(
        conditionHolds({ optionId: B, operator: 'not_equals', value: 'red' }, { [B]: 'blue' }),
      ).toBe(true);
    });

    /**
     * 🔴 **An unanswered option does not satisfy `not_equals`.** "Colour is not
     * red" asks about a colour that was chosen; treating a blank as a match
     * would fire the rule on a form the customer has not begun.
     */
    it('does not hold when nothing was answered', () => {
      expect(conditionHolds({ optionId: B, operator: 'not_equals', value: 'red' }, {})).toBe(false);
    });
  });

  describe('magnitude', () => {
    it('compares numbers', () => {
      expect(conditionHolds({ optionId: B, operator: 'greater_than', value: 5 }, { [B]: '7' })).toBe(
        true,
      );
      expect(conditionHolds({ optionId: B, operator: 'less_than', value: 5 }, { [B]: '7' })).toBe(
        false,
      );
    });

    /** The schema refuses a text operand; a stale document may still carry one. */
    it('answers false rather than guessing an ordering for text', () => {
      expect(
        conditionHolds({ optionId: B, operator: 'greater_than', value: 'apple' }, { [B]: 'blue' }),
      ).toBe(false);
    });

    it('answers false for an unanswered option', () => {
      expect(conditionHolds({ optionId: B, operator: 'greater_than', value: 5 }, {})).toBe(false);
    });
  });

  describe('lists', () => {
    it('matches in and not_in', () => {
      const condition = { optionId: B, operator: 'in', value: ['red', 'blue'] };

      expect(conditionHolds(condition, { [B]: 'blue' })).toBe(true);
      expect(conditionHolds({ ...condition, operator: 'not_in' }, { [B]: 'blue' })).toBe(false);
    });

    it('answers false when the operand is not a list', () => {
      expect(conditionHolds({ optionId: B, operator: 'in', value: 'red' }, { [B]: 'red' })).toBe(
        false,
      );
    });
  });

  /**
   * ⚠️ AC4: the document is input, not authority. A plugin older than the
   * operator reaching it must render the product rather than refuse it.
   */
  it('answers false for an operator it does not know', () => {
    expect(conditionHolds({ optionId: B, operator: 'starts_with', value: 'A' }, { [B]: 'A' })).toBe(
      false,
    );
  });
});

describe('ruleFires', () => {
  it('requires every condition under `all`', () => {
    const r = rule({
      conditions: [
        { optionId: B, operator: 'is_not_empty' },
        { optionId: C, operator: 'is_not_empty' },
      ],
    });

    expect(ruleFires(r, { [B]: 'x' })).toBe(false);
    expect(ruleFires(r, { [B]: 'x', [C]: 'y' })).toBe(true);
  });

  it('requires one condition under `any`', () => {
    const r = rule({
      matchType: 'any',
      conditions: [
        { optionId: B, operator: 'is_not_empty' },
        { optionId: C, operator: 'is_not_empty' },
      ],
    });

    expect(ruleFires(r, { [B]: 'x' })).toBe(true);
  });

  /** The schema refuses one; only a stale document can carry it. */
  it('never fires with no conditions, rather than always firing', () => {
    expect(ruleFires(rule({ conditions: [] }), {})).toBe(false);
  });
});

describe('evaluateRules', () => {
  describe('ADR-052 precedence', () => {
    /**
     * 🔴 **`hide` wins, whatever order the rules arrive in.** This is what makes
     * the result order-independent, and what makes `hide` safe to combine with
     * ADR-051: if `show` could win, a rule meaning to hide an option could be
     * overridden and the customer charged for a field their configuration
     * removed.
     */
    it('resolves show against hide in favour of hide, either order', () => {
      const hide = rule({ id: 'r-hide', action: 'hide' });
      const show = rule({ id: 'r-show', action: 'show' });

      for (const rules of [[hide, show], [show, hide]]) {
        const outcome = evaluateRules(rules, {}, selfMap);

        expect(outcome.states.get(A)?.hidden).toBe(true);
      }
    });

    it('resolves require against unrequire in favour of require, either order', () => {
      const req = rule({ id: 'r-req', action: 'require' });
      const unreq = rule({ id: 'r-unreq', action: 'unrequire' });

      for (const rules of [[req, unreq], [unreq, req]]) {
        expect(evaluateRules(rules, {}, selfMap).states.get(A)?.required).toBe(true);
      }
    });

    it('never consults sortOrder, because the document does not carry one', () => {
      /* The shape has no sortOrder at all — the strongest form of "not consulted". */
      expect(Object.keys(rule())).not.toContain('sortOrder');
    });
  });

  describe('payloads', () => {
    it('carries the amount a set_price rule acts with', () => {
      const outcome = evaluateRules(
        [rule({ action: 'set_price', actionValue: { amountMinor: 500 } })],
        {},
        selfMap,
      );

      expect(outcome.states.get(A)?.priceMinor).toBe(500);
    });

    /**
     * ✏️ **This asserted that `set_default` carried its value key.** It did.
     *
     * ADR-055 withdrew the action: it was evaluated by all three engines and
     * applied by nothing, and it could not be applied without contradicting
     * ADR-051 §3 — a pre-selected value carries a price the customer never
     * confirmed. Inverted rather than deleted, because a stored row still
     * reaches storefronts and must resolve to *nothing at all*.
     */
    it('resolves a withdrawn action to no state whatever', () => {
      const outcome = evaluateRules(
        [rule({ action: 'set_default' as never, actionValue: { valueKey: 'large' } })],
        {},
        selfMap,
      );

      expect(outcome.states.get(A)).toBeUndefined();
    });

    /**
     * 🔴 Before M17.4 the entity had no payload column at all, so `set_price`
     * had no amount to set. A rule arriving without one is a stale document, and
     * ignoring it leaves the price the merchant authored.
     */
    it('ignores a set_price rule with no amount rather than charging zero', () => {
      const outcome = evaluateRules([rule({ action: 'set_price' })], {}, selfMap);

      /*
       * No state at all, not a state carrying `priceMinor: null`. The
       * difference matters: "no rule said anything about this target" is what a
       * caller needs, and a seeded state would claim a rule spoke.
       */
      expect(outcome.states.get(A)?.priceMinor ?? null).toBeNull();
    });

    it('ignores a non-integer amount', () => {
      const outcome = evaluateRules(
        [rule({ action: 'set_price', actionValue: { amountMinor: 5.5 } })],
        {},
        selfMap,
      );

      expect(outcome.states.get(A)?.priceMinor ?? null).toBeNull();
    });
  });

  describe('cascading', () => {
    /**
     * Hiding an option clears its answer (ADR-051), and a cleared answer may
     * satisfy another rule's condition. That is what makes a fixed point
     * necessary rather than one pass.
     */
    it('lets a hide in one pass satisfy a condition in the next', () => {
      const rules = [
        rule({ id: 'r1', targetId: B, action: 'hide', conditions: [{ optionId: C, operator: 'is_not_empty' }] }),
        rule({ id: 'r2', targetId: A, action: 'hide', conditions: [{ optionId: B, operator: 'is_empty' }] }),
      ];

      const outcome = evaluateRules(rules, { [B]: 'answered', [C]: 'yes' }, selfMap);

      expect(outcome.refused).toBeNull();
      expect(outcome.states.get(B)?.hidden).toBe(true);
      /* B's answer was cleared, so r2's condition now holds. */
      expect(outcome.states.get(A)?.hidden).toBe(true);
      expect(outcome.passes).toBeGreaterThan(1);
    });

    it('settles in one pass when nothing cascades', () => {
      expect(evaluateRules([rule()], {}, selfMap).passes).toBe(1);
    });

    /**
     * ⚠️ Rebuilt from the original answers each pass rather than mutated, so a
     * value cleared by a rule that stops firing comes back. Mutating would make
     * the result depend on pass order.
     */
    it('does not accumulate clears across passes', () => {
      const outcome = evaluateRules(
        [rule({ targetId: B, conditions: [{ optionId: C, operator: 'is_not_empty' }] })],
        { [B]: 'kept', [C]: '' },
        selfMap,
      );

      expect(outcome.states.get(B)).toBeUndefined();
    });
  });

  describe('the pass cap', () => {
    /**
     * 🔴 **Refuses rather than returning what it reached** (ADR-050). A
     * truncated pass is a wrong price that looks right — 16c quoted 85.00 and
     * charged 130.00; 16d made an option silently free at a boundary. Both
     * passed their suites.
     */
    /**
     * 🔴 **The cap is reached by DEPTH now, not by oscillation.**
     *
     * Hides accumulate, so each pass can only add one — which is what makes the
     * fixed point monotone and stops an ordinary rule flipping for ever. A chain
     * longer than the cap is therefore the only way to exceed it, and it is a
     * real shape: each option's disappearance reveals the next.
     *
     * ✏️ **This test used to drive an oscillation** — "hide A when A is
     * answered" — which reached the cap because the answer was restored every
     * other pass. That was the H1 defect: M17.3 **publishes** that rule with a
     * 201, deliberately exempting a self-edge as a legitimate one-step rule, so
     * the evaluator refusing it made the product unbuyable on a document the
     * publish gate had approved.
     */
    it('refuses a cascade deeper than the pass limit', () => {
      const ids = Array.from({ length: MAX_RULE_PASSES + 3 }, (_, i) => `opt-${i}`);
      const under = new Map(ids.map((id) => [id, [id]] as const));

      /* Each option hides once the one before it has gone. */
      const rules = ids.slice(1).map((id, index) =>
        rule({
          id: `r${index}`,
          targetId: id,
          action: 'hide',
          conditions: [
            { optionId: ids[index] as string, operator: index === 0 ? 'is_not_empty' : 'is_empty' },
          ],
        }),
      );

      const answers = Object.fromEntries(ids.map((id) => [id, 'x']));
      const outcome = evaluateRules(rules, answers, under);

      expect(outcome.refused).not.toBeNull();
      expect(outcome.passes).toBe(MAX_RULE_PASSES);
    });

    /**
     * 🔴 **Empty, never partial** (ADR-050). Returning what the cap reached is a
     * field wrongly shown or hidden and a price computed from it — a wrong price
     * that looks right, which this project has shipped twice.
     */
    it('reports a refusal with an empty state, never a partial one', () => {
      const ids = Array.from({ length: MAX_RULE_PASSES + 3 }, (_, i) => `opt-${i}`);
      const under = new Map(ids.map((id) => [id, [id]] as const));

      const rules = ids.slice(1).map((id, index) =>
        rule({
          id: `r${index}`,
          targetId: id,
          action: 'hide',
          conditions: [
            { optionId: ids[index] as string, operator: index === 0 ? 'is_not_empty' : 'is_empty' },
          ],
        }),
      );

      const outcome = evaluateRules(rules, Object.fromEntries(ids.map((id) => [id, 'x'])), under);

      expect(outcome.refused).not.toBeNull();
      expect(outcome.states.size).toBe(0);
    });

    /**
     * 🔴 **The H1 regression, stated as its own case.**
     *
     * M17.3 publishes "hide A when A is answered" with a 201. An evaluator that
     * refused it would make the product unbuyable on a document the publish gate
     * had approved — the two halves contradicting each other, with the evaluator
     * in the wrong.
     */
    it('settles a rule that hides the option its own condition reads', () => {
      const outcome = evaluateRules(
        [rule({ targetId: A, action: 'hide', conditions: [{ optionId: A, operator: 'is_not_empty' }] })],
        { [A]: 'answered' },
        selfMap,
      );

      expect(outcome.refused).toBeNull();
      expect(outcome.states.get(A)?.hidden).toBe(true);
    });

    /**
     * ⚠️ **The same shape through containment, which is the half that is not
     * self-reference.** A group hiding the option its condition tests oscillated
     * for exactly the same reason — measured, while the same rule over a group
     * *not* containing that option settled in two passes.
     */
    it('settles a group rule whose target contains its condition option', () => {
      const group = 'group-1';
      const outcome = evaluateRules(
        [
          rule({
            targetType: 'group',
            targetId: group,
            action: 'hide',
            conditions: [{ optionId: B, operator: 'is_not_empty' }],
          }),
        ],
        { [A]: 'x', [B]: 'y' },
        new Map([
          [group, [A, B]],
          [A, [A]],
          [B, [B]],
        ]),
      );

      expect(outcome.refused).toBeNull();
      expect(outcome.states.get(group)?.hidden).toBe(true);
    });

    it('settles a rule set that does converge', () => {
      const outcome = evaluateRules([rule()], {}, selfMap);

      expect(outcome.refused).toBeNull();
      expect(outcome.passes).toBe(1);
    });

    it('caps at MAX_RULE_PASSES', () => {
      expect(MAX_RULE_PASSES).toBe(10);
    });
  });
});
