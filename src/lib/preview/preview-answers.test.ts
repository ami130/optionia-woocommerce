import { describe, expect, it } from 'vitest';

import { evaluableAnswers, evaluableRules } from './preview-answers';
import { previewTree } from './preview-tree';
import type { AuthoringSet } from '@/lib/option-sets/api';

const tree = (options: unknown[], rules: unknown[] = []) =>
  previewTree({
    id: 's', storeId: 'x', name: 'n', status: 'draft', version: 1, rowVersion: 1,
    publishedAt: null, publishedConfigVersion: 0, rules,
    groups: [{
      id: 'g', label: 'G', description: null, sortOrder: 0, isEnabled: true,
      displayType: 'inline', isCollapsible: false, items: [], options,
    }],
  } as unknown as AuthoringSet);

const opt = (over: Record<string, unknown> = {}) => ({
  id: 'o1', key: 'k', label: 'L', presentation: 'dropdown',
  isRequired: false, sortOrder: 0, isEnabled: true, values: [], ...over,
});

describe('evaluableAnswers', () => {
  it('passes a customer’s own answers through', () => {
    expect(evaluableAnswers(tree([opt()]), { o1: 'gold' })).toEqual({ o1: 'gold' });
  });

  /**
   * 🔴 **A `hidden` option answers itself.** Its type gives a customer nothing
   * to type into, so the storefront substitutes `default_value` —
   * `SelectionResolver::rule_answers()`. A preview that left it unanswered would
   * fire every *"is empty"* rule the storefront does not.
   */
  it('answers a hidden option with its default value', () => {
    const answers = evaluableAnswers(tree([opt({ presentation: 'hidden', defaultValue: 'batch-77' })]), {});

    expect(answers.o1).toBe('batch-77');
  });

  /**
   * 🔴 **Removed, not emptied.** A rule reading *"is empty"* gets a different
   * answer from an absent key than from `''`, and the storefront removes it.
   */
  it('removes a hidden option that has no default at all', () => {
    const answers = evaluableAnswers(
      tree([opt({ presentation: 'hidden' })]),
      { o1: 'stale' },
    );

    expect('o1' in answers).toBe(false);
  });

  it('removes a hidden option whose default is only whitespace', () => {
    const answers = evaluableAnswers(
      tree([opt({ presentation: 'hidden', defaultValue: '   ' })]),
      { o1: 'stale' },
    );

    expect('o1' in answers).toBe(false);
  });

  /**
   * ⚠️ **The default WINS over anything already entered**, because a customer
   * cannot have entered it — the field is not rendered.
   */
  it('overrides a stale entry for a hidden option', () => {
    const answers = evaluableAnswers(
      tree([opt({ presentation: 'hidden', defaultValue: 'batch-77' })]),
      { o1: 'typed-somehow' },
    );

    expect(answers.o1).toBe('batch-77');
  });

  /** A visible option's default is NOT substituted: the customer answers it. */
  it('leaves a visible option’s default alone', () => {
    const answers = evaluableAnswers(tree([opt({ defaultValue: 'gold' })]), {});

    expect('o1' in answers).toBe(false);
  });
});

describe('evaluableRules', () => {
  /**
   * The rules keep the authoring spelling (ADR-103) because `rule-evaluator`
   * reads `targetType` and `matchType`. Asserted so a future "tidy-up" that
   * converts them fails here rather than in a preview that quietly stops firing.
   */
  it('hands rules over in the dialect the evaluator reads', () => {
    const rules = evaluableRules(
      tree([opt()], [{
        id: 'r1', targetType: 'option', targetId: 'o1', action: 'hide',
        matchType: 'all', conditions: [], actionValue: null, sortOrder: 0,
        isEnabled: true, disabledReason: null,
      }]),
    );

    expect(rules[0]).toMatchObject({ targetType: 'option', matchType: 'all' });
  });

  it('drops a disabled rule, because previewTree already has', () => {
    const rules = evaluableRules(
      tree([opt()], [{
        id: 'r1', targetType: 'option', targetId: 'o1', action: 'hide',
        matchType: 'all', conditions: [], actionValue: null, sortOrder: 0,
        isEnabled: false, disabledReason: null,
      }]),
    );

    expect(rules).toHaveLength(0);
  });
});
