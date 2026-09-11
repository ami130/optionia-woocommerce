import { RuleTesterService } from './rule-tester.service';
import type { OptionSetTreeLoader } from './serialization/option-set-tree.loader';
import type { OptionSetTree } from './serialization/option-set.serializer';

/**
 * The rule tester (M17.6, ADR-053).
 *
 * 🔴 **These assert what a MERCHANT would be shown, not what the evaluator
 * returned.** `rule-fixtures.spec.ts` already proves the evaluator decides
 * correctly against 46 shared cases; repeating that here would test the same
 * logic twice and this service's own job — turning target ids into the three
 * kinds a merchant reads — not at all.
 */

type Rule = OptionSetTree['rules'][number];

/** One rule, in the shape the loader returns. */
function rule(over: Partial<Rule>): Rule {
  return {
    id: 'r1',
    targetType: 'option',
    targetId: 'opt-b',
    action: 'hide',
    matchType: 'all',
    conditions: [{ optionId: 'opt-a', operator: 'equals', value: 'yes' }],
    actionValue: null,
    sortOrder: 10,
    isEnabled: true,
    ...over,
  } as Rule;
}

/**
 * Two groups: `group-a` holds `opt-a` (two values), `group-b` holds `opt-b`.
 *
 * Shaped like a real tree rather than a bare map, because the service's job is
 * reading structure out of one — a fake that flattened it would let a bug in
 * that reading pass.
 */
function tree(rules: Rule[]): OptionSetTree {
  return {
    set: { id: 'set-1' },
    rules,
    groups: [
      {
        group: { id: 'group-a' },
        items: [],
        options: [
          {
            option: { id: 'opt-a' },
            values: [{ id: 'val-yes' }, { id: 'val-no' }],
          },
        ],
      },
      {
        group: { id: 'group-b' },
        items: [],
        options: [{ option: { id: 'opt-b' }, values: [{ id: 'val-extra' }] }],
      },
    ],
  } as unknown as OptionSetTree;
}

function testerFor(rules: Rule[]): RuleTesterService {
  const loader = { load: async () => tree(rules) } as unknown as OptionSetTreeLoader;

  return new RuleTesterService(loader);
}

describe('RuleTesterService', () => {
  it('reports a hidden option under hiddenOptionIds', async () => {
    const result = await testerFor([rule({})]).test('set-1', { 'opt-a': 'yes' });

    expect(result.hiddenOptionIds).toEqual(['opt-b']);
    expect(result.hiddenGroupIds).toEqual([]);
    expect(result.refused).toBeNull();
  });

  it('reports nothing when the rule does not fire', async () => {
    const result = await testerFor([rule({})]).test('set-1', { 'opt-a': 'no' });

    expect(result.hiddenOptionIds).toEqual([]);
  });

  /**
   * 🔴 The three kinds are reported separately, because they mean different
   * things to a merchant: a hidden group removes a section, a hidden option
   * removes a question, a hidden value removes one choice from a question that
   * stays.
   */
  it('separates a hidden group from a hidden option', async () => {
    const result = await testerFor([rule({ targetType: 'group', targetId: 'group-b' })]).test(
      'set-1',
      { 'opt-a': 'yes' },
    );

    expect(result.hiddenGroupIds).toEqual(['group-b']);
    expect(result.hiddenOptionIds).toEqual([]);
  });

  it('separates a hidden value from the option that owns it', async () => {
    const result = await testerFor([rule({ targetType: 'value', targetId: 'val-extra' })]).test(
      'set-1',
      { 'opt-a': 'yes' },
    );

    expect(result.hiddenValueIds).toEqual(['val-extra']);
    expect(result.hiddenOptionIds).toEqual([]);
  });

  /**
   * 🔴 Hiding a value must not erase the answer another rule reads.
   *
   * `containment()` maps a value to **nothing**, because hiding one choice
   * removes a choice and not the question. Mapping it to its owning option — the
   * shape `publish-check.ts` keeps for cycle detection, correctly — would clear
   * the answer of a merchant who tested with a *different* value chosen, and any
   * rule reading that option would then fire on a blank.
   *
   * ⚠️ **The assertion is on the SECOND rule's target**, not on the value's own
   * option. Reporting the kinds correctly is not enough: the corruption happens
   * a layer below, in what the evaluator is fed. M17.8's audit found exactly
   * this in the plugin, and the first mutation run here showed the guard
   * surviving because nothing read an erased answer.
   */
  it('hiding a value does not erase the answer a second rule reads', async () => {
    const rules = [
      rule({ targetType: 'value', targetId: 'val-extra' }),
      rule({
        id: 'r2',
        targetId: 'opt-a',
        conditions: [{ optionId: 'opt-b', operator: 'is_empty' }],
      }),
    ];

    // `opt-b` IS answered, so r2 must not fire.
    const result = await testerFor(rules).test('set-1', { 'opt-a': 'yes', 'opt-b': 'extra' });

    expect(result.hiddenValueIds).toEqual(['val-extra']);
    expect(result.hiddenOptionIds).toEqual([]);
  });

  /**
   * ⚠️ **The kind comes from the TREE, not from the rule.** A rule claiming
   * `targetType: 'group'` for an option id would otherwise be reported as a
   * hidden group that does not exist, and a merchant would hunt for a section
   * that never rendered.
   */
  it('trusts the tree over a rule that misdescribes its own target', async () => {
    const result = await testerFor([rule({ targetType: 'group', targetId: 'opt-b' })]).test(
      'set-1',
      { 'opt-a': 'yes' },
    );

    expect(result.hiddenOptionIds).toEqual(['opt-b']);
    expect(result.hiddenGroupIds).toEqual([]);
  });

  /** A disabled rule is not part of the configuration, so it is not tested. */
  it('ignores a disabled rule', async () => {
    const result = await testerFor([rule({ isEnabled: false })]).test('set-1', { 'opt-a': 'yes' });

    expect(result.hiddenOptionIds).toEqual([]);
  });

  /**
   * 🔴 `require` on a group reports every option inside it.
   *
   * Only an option can be answered, so "this group is required" means "each of
   * these questions is". Reporting the group id would name something a merchant
   * cannot fill in.
   */
  it('reports a required group as its options', async () => {
    const result = await testerFor([
      rule({ action: 'require', targetType: 'group', targetId: 'group-b' }),
    ]).test('set-1', { 'opt-a': 'yes' });

    expect(result.requiredOptionIds).toEqual(['opt-b']);
  });

  it('reports unrequire separately from require', async () => {
    const result = await testerFor([rule({ action: 'unrequire' })]).test('set-1', {
      'opt-a': 'yes',
    });

    expect(result.optionalOptionIds).toEqual(['opt-b']);
    expect(result.requiredOptionIds).toEqual([]);
  });

  /**
   * 🔴 A refusal carries no partial state (ADR-050).
   *
   * Returning the lists reached would let a merchant tune a rule against a
   * picture the storefront will never show — it refuses that configuration
   * outright.
   */
  it('returns empty lists and a reason when evaluation refuses', async () => {
    /*
     * ⚠️ **The chain's options must be IN the tree**, or containment maps them
     * to nothing, no answer is ever cleared and the cascade settles on pass one.
     * Measured while writing this: a chain of rules over options the tree did
     * not contain refused nothing at all.
     */
    const chain: Rule[] = [];
    const answers: Record<string, unknown> = {};
    const options: Array<{ option: { id: string }; values: never[] }> = [];

    for (let i = 0; i <= 12; i += 1) {
      options.push({ option: { id: `chain-${i}` }, values: [] });
      answers[`chain-${i}`] = 'x';

      if (i > 0) {
        chain.push(
          rule({
            id: `r${i}`,
            targetId: `chain-${i}`,
            conditions: [
              { optionId: `chain-${i - 1}`, operator: i === 1 ? 'is_not_empty' : 'is_empty' },
            ],
          }),
        );
      }
    }

    const deep = {
      set: { id: 'set-1' },
      rules: chain,
      groups: [{ group: { id: 'group-a' }, items: [], options }],
    } as unknown as OptionSetTree;

    const loader = { load: async () => deep } as unknown as OptionSetTreeLoader;
    const result = await new RuleTesterService(loader).test('set-1', answers);

    expect(result.refused).not.toBeNull();
    expect(result.hiddenOptionIds).toEqual([]);
    expect(result.passes).toBe(10);
  });

  /**
   * 🔴 **The tester never reports a price.**
   *
   * ADR-053: what a `set_price` rule does to a quoted total is the question
   * M17.9 left for 17-11, and a tester that answered it would settle it by
   * accident. Asserted on the result's shape so adding a price field is a
   * deliberate act rather than a quiet one.
   */
  it('reports no price for a set_price rule', async () => {
    const result = await testerFor([
      rule({ action: 'set_price', actionValue: { amountMinor: 900 } }),
    ]).test('set-1', { 'opt-a': 'yes' });

    expect(Object.keys(result).sort()).toEqual([
      'hiddenGroupIds',
      'hiddenOptionIds',
      'hiddenValueIds',
      'optionalOptionIds',
      'passes',
      'refused',
      'requiredOptionIds',
    ]);
  });
});
