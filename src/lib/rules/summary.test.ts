import { describe, expect, it } from 'vitest';

import type { AuthoringRule, AuthoringSet } from '@/lib/option-sets/api';

import { conditionSentence, labelsIn, ruleSentence } from './summary';
import { OPERATOR_PHRASING, RULE_OPERATORS } from './vocabulary';

/**
 * Rules, as sentences (M17.6).
 *
 * 🔴 **These assert the SENTENCE, not that a function ran.** *"Merchants can
 * author rules without documentation"* is a Phase 17 exit criterion, and it is
 * met or missed in exactly these strings — a test checking only that something
 * non-empty came back would pass on a UUID.
 */

const set = {
  id: 'set-1',
  groups: [
    {
      id: 'group-a',
      label: 'Customisation',
      options: [
        {
          id: 'opt-a',
          label: 'Engraving',
          values: [
            { id: 'val-yes', label: 'Yes' },
            { id: 'val-no', label: 'No' },
          ],
        },
        { id: 'opt-b', label: 'Engraving Text', values: [] },
      ],
    },
  ],
} as unknown as AuthoringSet;

const labels = labelsIn(set);

function rule(over: Partial<AuthoringRule>): AuthoringRule {
  return {
    id: 'r1',
    targetType: 'option',
    targetId: 'opt-b',
    action: 'hide',
    matchType: 'all',
    conditions: [{ optionId: 'opt-a', operator: 'equals', value: 'Yes' }],
    actionValue: null,
    sortOrder: 10,
    isEnabled: true,
    disabledReason: null,
    ...over,
  } as AuthoringRule;
}

describe('rule summaries', () => {
  /**
   * ⚠️ **M17.6's example reads "Show Engraving Text when Engraving = Yes".**
   * `show` was withdrawn by ADR-056 — nothing is hidden for it to reveal — so
   * the same configuration is now written the other way round. The sentence
   * shape the milestone asked for is what this pins, not the verb.
   */
  it('reads as the sentence M17.6 asks for', () => {
    expect(ruleSentence(rule({ action: 'hide' }), labels)).toBe(
      'Hide Engraving Text when Engraving is Yes',
    );
  });

  it('joins several conditions with the connective the rule carries', () => {
    const two = rule({
      matchType: 'any',
      conditions: [
        { optionId: 'opt-a', operator: 'equals', value: 'Yes' },
        { optionId: 'opt-b', operator: 'is_not_empty' },
      ],
    });

    expect(ruleSentence(two, labels)).toBe(
      'Hide Engraving Text when any of: Engraving is Yes, Engraving Text is answered',
    );
  });

  /**
   * ⚠️ A value reads as "Option: Value", because a bare "Large" is ambiguous in
   * a set with two size options — which is exactly where a value-targeted rule
   * is used.
   */
  it('names a value target by its option as well as itself', () => {
    expect(ruleSentence(rule({ targetType: 'value', targetId: 'val-no' }), labels)).toBe(
      'Hide Engraving: No when Engraving is Yes',
    );
  });

  /**
   * 🔴 A deleted target must not print a UUID.
   *
   * The cascade disables such a rule rather than removing it, so it still
   * renders — and a merchant who cannot read it cannot find the rule to delete.
   */
  it('says a target was deleted rather than printing its id', () => {
    const orphan = rule({ targetId: '01a08c2b-0000-7000-8000-000000000000' });

    expect(ruleSentence(orphan, labels)).toBe('Hide a deleted option when Engraving is Yes');
  });

  it('lists the members of an `in` condition', () => {
    const listed = rule({
      conditions: [{ optionId: 'opt-a', operator: 'in', value: ['Yes', 'Maybe'] }],
    });

    expect(ruleSentence(listed, labels)).toBe(
      'Hide Engraving Text when Engraving is one of Yes, Maybe',
    );
  });

  /**
   * ⚠️ A rule with no conditions **never fires**, in both evaluators. The schema
   * refuses one, so this is a row predating that check — and describing it as
   * unconditional would be the opposite of what happens.
   */
  it('says a rule with no conditions never fires', () => {
    expect(ruleSentence(rule({ conditions: [] }), labels)).toBe(
      'Hide Engraving Text — never, because this rule has no conditions',
    );
  });

  /**
   * 🔴 **Every operator must read as words, and none may leak its raw value.**
   *
   * A summary printing `not_in` would be the documentation this criterion exists
   * to make unnecessary. Driven off the vocabulary list so a tenth operator
   * cannot be added without phrasing — the cross-repo gate checks the same fact
   * from the other side.
   */
  it('renders every operator in words, never as its raw value', () => {
    RULE_OPERATORS.forEach((operator) => {
      const sentence = conditionSentence({ optionId: 'opt-a', operator, value: 'Yes' }, labels);

      expect(sentence).toContain(OPERATOR_PHRASING[operator]);

      /*
       * ⚠️ **Only the underscored values are checked for**, because `contains`
       * is legitimately both an operator and its own phrasing. Asserting the
       * absence of every raw value would fail on a correct sentence — measured
       * while writing this. `not_in` leaking is the failure that matters:
       * underscores are what make a string look like machine output.
       */
      if (operator.includes('_')) {
        expect(sentence).not.toContain(operator);
      }
    });
  });
});
