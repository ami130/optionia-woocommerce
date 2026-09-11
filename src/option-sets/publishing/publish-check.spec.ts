import { OptionGroup } from '../entities/option-group.entity';
import { OptionSet } from '../entities/option-set.entity';
import { OptionValue } from '../entities/option-value.entity';
import { Option } from '../entities/option.entity';
import type { OptionSetTree } from '../serialization/option-set.serializer';
import {
  hasBlockers,
  PUBLISH_VALIDATORS,
  PublishSeverity,
  runPublishChecks,
  ruleTargetsAreInThisSet,
  rulesHaveNoCycles,
  ruleConditionsAreAList,
  rulePayloadsDoNotConflict,
  setPriceDoesNotFightOptionPricing,
  type PublishContext,
  patternsAreSafe,
} from './publish-check';

const LIVE = new Date(1970, 0, 1);

function set(): OptionSet {
  return Object.assign(new OptionSet(), {
    id: 'set-1',
    name: 'Customisation',
    version: 0,
    isEnabled: true,
    deletedAt: LIVE,
  });
}

function group(overrides: Partial<OptionGroup> = {}): OptionGroup {
  return Object.assign(new OptionGroup(), {
    id: 'group-1',
    label: 'Group',
    isEnabled: true,
    deletedAt: LIVE,
    ...overrides,
  });
}

function option(overrides: Partial<Option> = {}): Option {
  return Object.assign(new Option(), {
    id: 'option-1',
    key: 'placement',
    label: 'Placement',
    presentation: 'radio',
    isEnabled: true,
    deletedAt: LIVE,
    ...overrides,
  });
}

function value(overrides: Partial<OptionValue> = {}): OptionValue {
  return Object.assign(new OptionValue(), {
    id: 'value-1',
    valueKey: 'front',
    label: 'Front',
    isEnabled: true,
    deletedAt: LIVE,
    ...overrides,
  });
}

/**
 * One rule, in the shape `PublishContext` carries.
 *
 * Defaults to a rule that is **valid and creates no edge**: enabled, targeting
 * `option-1` — which the default tree contains — on a condition naming that same
 * option. Every cycle test therefore states only the edges it is about, and a
 * test that forgets to is inert rather than accidentally cyclic.
 */
function rule(overrides: Partial<PublishContext['rules'][number]> = {}) {
  return {
    id: 'rule-1',
    targetType: 'option',
    targetId: 'option-1',
    isEnabled: true,
    disabledReason: null,
    conditions: [{ optionId: 'option-1', operator: 'is_not_empty' }],
    matchType: 'all',
    /* `show` is answer-affecting, so a test wanting an edge gets one by default. */
    action: 'show',
    /* No payload: `show` is one of the four actions that act on their own. */
    actionValue: null,
    ...overrides,
  };
}

function context(overrides: Partial<PublishContext> = {}): PublishContext {
  const tree: OptionSetTree = {
    set: set(),
    rules: [],
    groups: [{ group: group(), items: [], options: [{ option: option(), values: [value()] }] }],
  };

  return { tree, rules: [], assignments: [{ id: 'assignment-1' }], ...overrides };
}

describe('pre-publish checks', () => {
  it('passes a set that is ready', () => {
    const findings = runPublishChecks(context());

    expect(findings.filter((f) => f.severity === PublishSeverity.BLOCKER)).toEqual([]);
  });

  describe('options with no values', () => {
    /** A choice option with no values renders as an empty control. */
    it('blocks a radio with no values', () => {
      const findings = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [{ group: group(), items: [], options: [{ option: option(), values: [] }] }],
          },
        }),
      );

      expect(findings.some((f) => f.code === 'OPTION_HAS_NO_VALUES')).toBe(true);
      expect(hasBlockers(findings)).toBe(true);
    });

    /** A disabled value is not published, so it cannot satisfy the check. */
    it('blocks when every value is disabled', () => {
      const findings = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [
              {
                group: group(),
                items: [],
                options: [{ option: option(), values: [value({ isEnabled: false })] }],
              },
            ],
          },
        }),
      );

      expect(findings.some((f) => f.code === 'OPTION_HAS_NO_VALUES')).toBe(true);
    });

    /** A disabled option is not published either, so it cannot block one. */
    it('ignores a disabled option', () => {
      const findings = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [
              {
                group: group(),
                items: [],
                options: [
                  { option: option({ isEnabled: false }), values: [] },
                  { option: option({ id: 'option-2', key: 'ok' }), values: [value()] },
                ],
              },
            ],
          },
        }),
      );

      expect(findings.some((f) => f.code === 'OPTION_HAS_NO_VALUES')).toBe(false);
    });

    it('ignores options inside a disabled group', () => {
      const findings = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [
              { group: group({ isEnabled: false }), items: [], options: [{ option: option(), values: [] }] },
              {
                group: group({ id: 'group-2' }),
                items: [],
                options: [{ option: option({ id: 'option-2' }), values: [value()] }],
              },
            ],
          },
        }),
      );

      expect(findings.some((f) => f.code === 'OPTION_HAS_NO_VALUES')).toBe(false);
    });

    /** A text field legitimately has no values; the registry says which do. */
    it('ignores a type that takes no values', () => {
      const findings = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [
              {
                group: group(),
                items: [],
                options: [{ option: option({ presentation: 'text_field' }), values: [] }],
              },
            ],
          },
        }),
      );

      expect(findings.some((f) => f.code === 'OPTION_HAS_NO_VALUES')).toBe(false);
    });

    it('names the option rather than its id', () => {
      const finding = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [
              {
                group: group(),
                items: [],
                options: [{ option: option({ label: 'Print placement' }), values: [] }],
              },
            ],
          },
        }),
      ).find((f) => f.code === 'OPTION_HAS_NO_VALUES');

      expect(finding?.message).toContain('Print placement');
    });
  });

  describe('an empty set', () => {
    it('blocks a set with no enabled options', () => {
      const findings = runPublishChecks(
        context({ tree: { set: set(), rules: [], groups: [] } }),
      );

      expect(findings.some((f) => f.code === 'SET_HAS_NO_OPTIONS')).toBe(true);
      expect(hasBlockers(findings)).toBe(true);
    });

    /**
     * ✏️ **Presentational items count as content (M5.4c).**
     *
     * This check once counted enabled options alone, which was right while
     * nothing could create an item. A set of pure explanatory copy — care
     * instructions, a sizing note — is legitimate, and the plugin's renderer
     * already draws a group holding only items. Blocking the publish left the
     * two disagreeing about the same set.
     */
    it('allows a set whose only content is presentational', () => {
      const findings = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [
              {
                group: group(),
                items: [{ id: 'item-1', kind: 'heading', content: 'Care' } as never],
                options: [],
              },
            ],
          },
        }),
      );

      expect(findings.some((f) => f.code === 'SET_HAS_NO_OPTIONS')).toBe(false);
    });

    /**
     * ⚠️ A disabled group hides its items too.
     *
     * `presentational_items` has no `isEnabled` of its own — it is the one
     * authorable table without one — so the group's flag is the only thing that
     * can hide an item, and a set whose every group is disabled still has
     * nothing to show.
     */
    it('still blocks when the only items sit in a disabled group', () => {
      const findings = runPublishChecks(
        context({
          tree: {
            set: set(),
            rules: [],
            groups: [
              {
                group: group({ isEnabled: false }),
                items: [{ id: 'item-1', kind: 'heading', content: 'Care' } as never],
                options: [],
              },
            ],
          },
        }),
      );

      expect(findings.some((f) => f.code === 'SET_HAS_NO_OPTIONS')).toBe(true);
    });

    /** An empty `items` array is not content. */
    it('blocks a group with neither options nor items', () => {
      const findings = runPublishChecks(
        context({
          tree: { set: set(), rules: [], groups: [{ group: group(), items: [], options: [] }] },
        }),
      );

      expect(findings.some((f) => f.code === 'SET_HAS_NO_OPTIONS')).toBe(true);
    });
  });

  describe('rules pointing at deleted targets', () => {
    /** Already disabled by the cascade, so the storefront is consistent. */
    it('warns rather than blocks', () => {
      const findings = runPublishChecks(
        context({
          rules: [
            rule({ targetId: 'gone', isEnabled: false, disabledReason: 'target_deleted' }),
          ],
        }),
      );

      const finding = findings.find((f) => f.code === 'RULE_TARGET_DELETED');

      expect(finding?.severity).toBe(PublishSeverity.WARNING);
      expect(hasBlockers(findings)).toBe(false);
    });

    /** A rule the merchant switched off themselves is not a finding. */
    it('ignores a rule disabled by the merchant', () => {
      const findings = runPublishChecks(
        context({
          rules: [
            rule({ targetId: 'x', isEnabled: false, disabledReason: null }),
          ],
        }),
      );

      expect(findings.some((f) => f.code === 'RULE_TARGET_DELETED')).toBe(false);
    });
  });

  describe('a set with no assignment', () => {
    /**
     * A warning, not a blocker: build, publish, then assign is a natural order
     * of work, and blocking would make it an error.
     */
    it('warns that publishing changes no storefront', () => {
      const findings = runPublishChecks(context({ assignments: [] }));
      const finding = findings.find((f) => f.code === 'SET_HAS_NO_ASSIGNMENT');

      expect(finding?.severity).toBe(PublishSeverity.WARNING);
      expect(hasBlockers(findings)).toBe(false);
    });

    it('says nothing when the set is assigned', () => {
      expect(runPublishChecks(context()).some((f) => f.code === 'SET_HAS_NO_ASSIGNMENT')).toBe(
        false,
      );
    });
  });

  /**
   * The property M7.4's deferred validators depend on: Phase 14 and Phase 17 add
   * a validator to a list rather than reopening the publish transaction.
   */
  /**
   * A context whose single option carries the given validation.
   *
   * Built on `context()` rather than a parallel fixture, so a change to the
   * shared tree reaches these tests too.
   */
  function withValidation(
    validation: Record<string, unknown> | null,
    optionOverrides: Partial<Option> = {},
  ): PublishContext {
    return context({
      tree: {
        set: set(),
        rules: [],
        groups: [
          {
            group: group(),
            items: [],
            options: [
              {
                option: option({ validation, ...optionOverrides } as Partial<Option>),
                values: [value()],
              },
            ],
          },
        ],
      },
    });
  }

  describe('patterns are safe', () => {
    /**
     * 🔴 **M14.4 requires this at publish, not at customer request time.**
     *
     * A catastrophically backtracking pattern runs on every add-to-cart. The
     * plugin defends itself — it caps length and treats a backtrack bailout as
     * "rule could not be applied" — but that leaves the merchant's intended
     * validation silently not happening. This is what stops one being published.
     */
    it.each([
      ['(a+)+', 'a repetition inside a repetition'],
      ['(a*)*', 'star inside star'],
      ['([a-z]+)+', 'a character class repeated twice'],
      ['(ab+)*', 'plus inside star'],
    ])('blocks %s — %s', (pattern) => {
      const findings = patternsAreSafe.validate(withValidation({ pattern }));

      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe('PATTERN_UNSAFE');
      expect(findings[0].severity).toBe(PublishSeverity.BLOCKER);
    });

    /**
     * ⚠️ **A blocker, not a warning.** A warning would let it publish, and the
     * cost would land on the merchant's customers rather than on the merchant.
     */
    it('blocks an invalid pattern rather than letting it silently do nothing', () => {
      const findings = patternsAreSafe.validate(withValidation({ pattern: '[unclosed' }));

      expect(findings[0].code).toBe('PATTERN_INVALID');
      expect(findings[0].severity).toBe(PublishSeverity.BLOCKER);
    });

    it('blocks a pattern past the length cap', () => {
      const findings = patternsAreSafe.validate(withValidation({ pattern: 'a'.repeat(300) }));

      expect(findings[0].code).toBe('PATTERN_TOO_LONG');
    });

    /** Patterns a merchant would actually write must publish. */
    it.each(['^[A-Z]{2}[0-9]{2}$', '^[0-9]{5}$', '^[A-Za-z ]+$', '^\\d{3}-\\d{4}$'])(
      'allows %s',
      (pattern) => {
        expect(patternsAreSafe.validate(withValidation({ pattern }))).toEqual([]);
      },
    );

    it('says nothing about an option with no pattern', () => {
      expect(patternsAreSafe.validate(withValidation(null))).toEqual([]);
      expect(patternsAreSafe.validate(withValidation({ maxLength: 20 }))).toEqual([]);
    });

    /** A disabled option cannot reach a customer, so its pattern is not checked. */
    it('ignores a disabled option', () => {
      expect(
        patternsAreSafe.validate(withValidation({ pattern: '(a+)+' }, { isEnabled: false })),
      ).toEqual([]);
    });
  });

  /**
   * A set holding two groups, so a test can put an option in the "other" one.
   *
   * `option-1` sits in `group-1`; `option-2` in `group-2` with `value-2`.
   */
  function twoGroupTree(): OptionSetTree {
    return {
      set: set(),
      rules: [],
      groups: [
        { group: group(), items: [], options: [{ option: option(), values: [value()] }] },
        {
          group: group({ id: 'group-2', label: 'Second' }),
          items: [],
          options: [
            {
              option: option({ id: 'option-2', key: 'colour', label: 'Colour' }),
              values: [value({ id: 'value-2', valueKey: 'red', label: 'Red' })],
            },
          ],
        },
      ],
    };
  }

  describe('rule targets outside this set', () => {
    /**
     * 🔴 The case nothing else catches.
     *
     * M17.1's CRUD proves the target row **exists and is the kind claimed**, but
     * not that it belongs to this set. Nothing sweeps a cross-set target either:
     * `CascadeService` sweeps within the deleted row's own set, so the other
     * set's delete never reaches this rule.
     */
    it('blocks a rule whose target belongs to another set', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({ rules: [rule({ targetId: 'option-in-another-set' })] }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('RULE_TARGET_NOT_IN_SET');
      expect(findings[0]?.severity).toBe(PublishSeverity.BLOCKER);
    });

    it('blocks a condition testing an option from another set', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({
          rules: [rule({ conditions: [{ optionId: 'elsewhere', operator: 'is_empty' }] })],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_CONDITION_NOT_IN_SET']);
    });

    it('accepts a rule pointing entirely within this set', () => {
      expect(ruleTargetsAreInThisSet.validate(context({ rules: [rule()] }))).toEqual([]);
    });

    /** A target may be a group or a value, not only an option. */
    it('resolves all three target kinds', () => {
      const withTree = { tree: twoGroupTree() };

      expect(
        ruleTargetsAreInThisSet.validate(
          context({ ...withTree, rules: [rule({ targetType: 'group', targetId: 'group-2' })] }),
        ),
      ).toEqual([]);
      expect(
        ruleTargetsAreInThisSet.validate(
          context({ ...withTree, rules: [rule({ targetType: 'value', targetId: 'value-2' })] }),
        ),
      ).toEqual([]);
    });

    /**
     * 🔴 An id that is real, but of the wrong kind, must not pass.
     *
     * `CascadeService` matches `targetType` and `targetId` **together**, so a
     * mismatched pair is swept by neither branch and never flagged
     * `TARGET_DELETED`. M17.1's CRUD refuses this at the door; this is the
     * second line, because a document can carry a row written before that check.
     */
    it('blocks a group id offered as an option target', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({ rules: [rule({ targetType: 'option', targetId: 'group-1' })] }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_TARGET_NOT_IN_SET']);
    });

    it('blocks a target type nobody defined rather than throwing', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({ rules: [rule({ targetType: 'gadget' })] }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_TARGET_NOT_IN_SET']);
    });

    /**
     * ⚠️ `rulesHaveTargets` owns the already-disabled case and makes it a
     * WARNING, because a disabled rule cannot reach a storefront. Blocking it
     * here would silently reverse that.
     */
    it('leaves a cascade-disabled rule to the validator that warns about it', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({
          rules: [rule({ targetId: 'gone', isEnabled: false, disabledReason: 'target_deleted' })],
        }),
      );

      expect(findings).toEqual([]);
    });

    /** A rule the merchant switched off is one they intend to switch back on. */
    it('still checks a rule the merchant disabled', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({
          rules: [rule({ targetId: 'elsewhere', isEnabled: false, disabledReason: null })],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_TARGET_NOT_IN_SET']);
    });

    /** A `json` column may hold anything; a publish must not 500 over it. */
    it('survives conditions that are not the shape today\'s schema writes', () => {
      expect(() =>
        ruleTargetsAreInThisSet.validate(
          context({ rules: [rule({ conditions: ['nonsense', null, 42, {}] })] }),
        ),
      ).not.toThrow();
    });
  });

  /**
   * 🔴 **"In the set" and "in the document" are different questions.**
   *
   * `OptionSetSerializer` drops a disabled thing entirely — its docblock says
   * *"a disabled thing is absent from the document entirely"*. So a rule can
   * name something genuinely in the set and genuinely absent from what
   * publishes. Measured before this check: a 201 with **no finding at all**.
   *
   * Nothing else catches it: `CascadeService` fires on delete, never on disable.
   */
  describe('rule targets that will not be published', () => {
    it('warns when the target option is disabled', () => {
      const tree = twoGroupTree();
      tree.groups[1]!.options[0]!.option.isEnabled = false;

      const findings = ruleTargetsAreInThisSet.validate(
        context({ tree, rules: [rule({ targetId: 'option-2' })] }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('RULE_TARGET_NOT_PUBLISHED');
      expect(findings[0]?.severity).toBe(PublishSeverity.WARNING);
    });

    /**
     * An option inside a disabled group does not publish either, however enabled
     * it is itself — the serializer drops the whole group.
     */
    it('warns when the target sits inside a disabled group', () => {
      const tree = twoGroupTree();
      tree.groups[1]!.group.isEnabled = false;

      const findings = ruleTargetsAreInThisSet.validate(
        context({ tree, rules: [rule({ targetId: 'option-2' })] }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_TARGET_NOT_PUBLISHED']);
    });

    it('warns for a disabled group target', () => {
      const tree = twoGroupTree();
      tree.groups[1]!.group.isEnabled = false;

      const findings = ruleTargetsAreInThisSet.validate(
        context({ tree, rules: [rule({ targetType: 'group', targetId: 'group-2' })] }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_TARGET_NOT_PUBLISHED']);
    });

    it('warns for a disabled value target', () => {
      const tree = twoGroupTree();
      tree.groups[1]!.options[0]!.values[0]!.isEnabled = false;

      const findings = ruleTargetsAreInThisSet.validate(
        context({ tree, rules: [rule({ targetType: 'value', targetId: 'value-2' })] }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_TARGET_NOT_PUBLISHED']);
    });

    /**
     * ⚠️ **A warning, not a blocker, and the difference from a cross-set target
     * is real.** Disabling is reversible and routinely deliberate mid-edit;
     * blocking would make "turn it off, publish, turn it back on" an error.
     */
    it('does not stop the publish', () => {
      const tree = twoGroupTree();
      tree.groups[1]!.options[0]!.option.isEnabled = false;

      const findings = ruleTargetsAreInThisSet.validate(
        context({ tree, rules: [rule({ targetId: 'option-2' })] }),
      );

      expect(hasBlockers(findings)).toBe(false);
    });

    it('says nothing when everything the rule names is enabled', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({ tree: twoGroupTree(), rules: [rule({ targetId: 'option-2' })] }),
      );

      expect(findings).toEqual([]);
    });

    /**
     * 🔴 A cross-set target is absent from both sets, so it would trip this
     * warning too — and a second finding about the same rule would bury the
     * blocker that actually stops the publish.
     */
    it('reports a cross-set target once, as the blocker', () => {
      const findings = ruleTargetsAreInThisSet.validate(
        context({ rules: [rule({ targetId: 'somewhere-else' })] }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_TARGET_NOT_IN_SET']);
    });

    it('says nothing about a rule the merchant disabled', () => {
      const tree = twoGroupTree();
      tree.groups[1]!.options[0]!.option.isEnabled = false;

      const findings = ruleTargetsAreInThisSet.validate(
        context({ tree, rules: [rule({ targetId: 'option-2', isEnabled: false })] }),
      );

      expect(findings).toEqual([]);
    });

    /** `rulesHaveTargets` owns the cascade-disabled case, and warns about it. */
    it('leaves a cascade-disabled rule to the validator that owns it', () => {
      const tree = twoGroupTree();
      tree.groups[1]!.options[0]!.option.isEnabled = false;

      const findings = ruleTargetsAreInThisSet.validate(
        context({
          tree,
          rules: [
            rule({ targetId: 'option-2', isEnabled: false, disabledReason: 'target_deleted' }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });
  });

  describe('rules whose conditions are the wrong shape (K3)', () => {
    /**
     * 🔴 **Safe, silent, and invisible for three stages.**
     *
     * `conditions` is a JSON column, and a row written before M17.1 settled its
     * shape may hold an object where a list belongs. Every reader guards with
     * `Array.isArray` and falls back to `[]`, so the set publishes cleanly and
     * the rule simply never applies. Nothing failed, and nothing said so —
     * which is what a warning is for.
     */
    it('warns about a rule whose conditions are not a list', () => {
      const findings = ruleConditionsAreAList.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              conditions: { optionId: 'option-1', operator: 'is_empty' } as never,
            }),
          ],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_CONDITIONS_MALFORMED']);
      expect(findings[0]!.severity).toBe(PublishSeverity.WARNING);
    });

    /**
     * 🔴 **A list containing junk is the subtler half, and it was missed.**
     *
     * K3 was first closed by checking `!Array.isArray` alone — so a rule with
     * one good condition and one broken one published with **no finding**.
     * `conditionOptionIds()` skips a non-object entry silently, which is safe
     * and says nothing.
     *
     * The shared fixture pins the evaluator's behaviour here in all three
     * languages (four cases). What was missing was telling the merchant.
     */
    it('warns about a list that contains an unreadable condition', () => {
      const findings = ruleConditionsAreAList.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              conditions: [
                { optionId: 'option-1', operator: 'is_empty' },
                'garbage',
              ] as never,
            }),
          ],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_CONDITIONS_MALFORMED']);
    });

    /**
     * 🔴 An **array** carrying the right fields is still not a condition.
     *
     * Exotic, and reachable: `conditions` is a JSON column, so nothing at the
     * database layer refuses `[["x"], …]` with properties attached. The field
     * checks alone would call it usable — `optionId` and `operator` are both
     * strings on it.
     *
     * ⚠️ **Written because mutation showed the shape guards were unproven.**
     * Loosening `typeof condition === 'object'` failed no test, because every
     * case then covered was rejected by the `optionId` check instead. Two guards
     * with no input between them is the redundancy this codebase keeps paying
     * for — except here there *is* an input between them, and this is it.
     */
    it('warns about a condition that is an array wearing the right fields', () => {
      const arrayish = Object.assign(['x'], { optionId: 'option-1', operator: 'is_empty' });

      const findings = ruleConditionsAreAList.validate(
        context({
          tree: twoGroupTree(),
          rules: [rule({ conditions: [arrayish] as never })],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_CONDITIONS_MALFORMED']);
    });

    /**
     * ⚠️ A condition missing `optionId` reads as junk too. It names nothing, so
     * no evaluator can look an answer up for it.
     */
    it('warns about a condition with no optionId', () => {
      const findings = ruleConditionsAreAList.validate(
        context({
          tree: twoGroupTree(),
          rules: [rule({ conditions: [{ operator: 'is_empty' }] as never })],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_CONDITIONS_MALFORMED']);
    });

    /**
     * ⚠️ A `null` entry is not a condition either.
     *
     * `null` survives JSON perfectly well, and `null?.optionId` is `undefined`
     * rather than a throw — so without the explicit guard it would read as a
     * condition merely *missing* its fields. True, and a worse explanation than
     * "this is not a condition".
     */
    it('warns about a null condition', () => {
      const findings = ruleConditionsAreAList.validate(
        context({
          tree: twoGroupTree(),
          rules: [rule({ conditions: [null] as never })],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_CONDITIONS_MALFORMED']);
    });

    /**
     * ⚠️ A condition with no `operator` names a subject and asks nothing of it.
     *
     * The mirror of the missing-`optionId` case, and needed for the same reason:
     * every evaluator dispatches on the operator, so one that is absent takes
     * the default branch and the condition never holds.
     */
    it('warns about a condition with no operator', () => {
      const findings = ruleConditionsAreAList.validate(
        context({
          tree: twoGroupTree(),
          rules: [rule({ conditions: [{ optionId: 'option-1' }] as never })],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULE_CONDITIONS_MALFORMED']);
    });

    /**
     * The control. Without it, a validator that warned about every rule would
     * satisfy the test above.
     */
    it('says nothing about a well-formed rule', () => {
      const findings = ruleConditionsAreAList.validate(
        context({ tree: twoGroupTree(), rules: [rule({})] }),
      );

      expect(findings).toEqual([]);
    });

    /**
     * ⚠️ A disabled rule is not published, so its shape cannot matter — and
     * warning about one would tell a merchant to repair something that already
     * affects nothing.
     */
    it('says nothing about a disabled rule', () => {
      const findings = ruleConditionsAreAList.validate(
        context({
          tree: twoGroupTree(),
          rules: [rule({ isEnabled: false, conditions: {} as never })],
        }),
      );

      expect(findings).toEqual([]);
    });
  });

  describe('rules that form a cycle', () => {
    it('accepts a single rule', () => {
      expect(rulesHaveNoCycles.validate(context({ rules: [rule()] }))).toEqual([]);
    });

    /**
     * 🔴 The two-rule loop, which is what M17.3 exists to refuse.
     *
     * ADR-050: the evaluator refuses rather than accepting a truncated pass, so
     * a published cycle is a line a customer cannot buy.
     */
    it('blocks A depending on B while B depends on A', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              id: 'r1',
              targetId: 'option-1',
              conditions: [{ optionId: 'option-2', operator: 'is_empty' }],
            }),
            rule({
              id: 'r2',
              targetId: 'option-2',
              conditions: [{ optionId: 'option-1', operator: 'is_empty' }],
            }),
          ],
        }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('RULES_FORM_A_CYCLE');
      expect(findings[0]?.severity).toBe(PublishSeverity.BLOCKER);
    });

    /**
     * 🔴 **The cycle that is invisible without resolving containment.**
     *
     * A condition always names an OPTION; a target may name a GROUP. So this
     * loop only closes once a group target is expanded to the options inside it:
     *
     *   r1: hide GROUP group-2   when option-1 is empty
     *   r2: show option-1        when option-2 is empty   (option-2 lives in group-2)
     */
    it('blocks a loop that closes only through a group target', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              id: 'r1',
              action: 'hide',
              targetType: 'group',
              targetId: 'group-2',
              conditions: [{ optionId: 'option-1', operator: 'is_empty' }],
            }),
            rule({
              id: 'r2',
              targetId: 'option-1',
              conditions: [{ optionId: 'option-2', operator: 'is_empty' }],
            }),
          ],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULES_FORM_A_CYCLE']);
    });

    /** The same, through a value target resolved to its owning option. */
    it('blocks a loop that closes only through a value target', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              id: 'r1',
              targetType: 'value',
              targetId: 'value-2',
              conditions: [{ optionId: 'option-1', operator: 'is_empty' }],
            }),
            rule({
              id: 'r2',
              targetId: 'option-1',
              conditions: [{ optionId: 'option-2', operator: 'is_empty' }],
            }),
          ],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULES_FORM_A_CYCLE']);
    });

    /**
     * ⚠️ **A self-loop is legitimate**, verified accepted by the 17-2 audit.
     * "Hide A when A is empty" is a one-step rule a merchant may reasonably
     * write; only a loop THROUGH another rule cannot settle.
     */
    it('accepts a rule that reads the option it acts on', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          rules: [
            rule({ targetId: 'option-1', conditions: [{ optionId: 'option-1', operator: 'is_empty' }] }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    /**
     * 🔴 **Not every action is an edge**, and treating all six as edges would
     * refuse publishes that are perfectly sound.
     *
     * `set_price` is the most consequential action in the vocabulary — ADR-049
     * lets it replace a value's delta — and it still cannot feed a condition,
     * because money is an output of evaluation rather than an input to it.
     */
    it('accepts a price loop, because a price is not an answer', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              id: 'r1',
              action: 'set_price',
              targetId: 'option-1',
              conditions: [{ optionId: 'option-2', operator: 'is_empty' }],
            }),
            rule({
              id: 'r2',
              action: 'set_price',
              targetId: 'option-2',
              conditions: [{ optionId: 'option-1', operator: 'is_empty' }],
            }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    it('accepts a require/unrequire loop, which changes validation not answers', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              id: 'r1',
              action: 'require',
              targetId: 'option-1',
              conditions: [{ optionId: 'option-2', operator: 'is_empty' }],
            }),
            rule({
              id: 'r2',
              action: 'unrequire',
              targetId: 'option-2',
              conditions: [{ optionId: 'option-1', operator: 'is_empty' }],
            }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    /**
     * ✏️ **This test asserted that `set_default` forms an edge.** It did, and
     * correctly — it was the one action besides show and hide that *writes* an
     * answer a later condition reads.
     *
     * ADR-055 withdrew the action, so it no longer affects any answer and is no
     * longer an edge. Kept as the inverse rather than deleted: a withdrawn
     * action quietly becoming an edge again is exactly the drift worth catching.
     */
    it('treats a withdrawn action as no edge at all', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              id: 'r1',
              action: 'set_default' as never,
              targetId: 'option-1',
              conditions: [{ optionId: 'option-2', operator: 'is_empty' }],
            }),
            rule({
              id: 'r2',
              action: 'set_default' as never,
              targetId: 'option-2',
              conditions: [{ optionId: 'option-1', operator: 'is_empty' }],
            }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    /**
     * ⚠️ Disabled rules are excluded HERE, unlike the target check — a cycle
     * among rules that never run is not a cycle a storefront can reach.
     */
    it('ignores a cycle whose rules are all disabled', () => {
      const findings = rulesHaveNoCycles.validate(
        context({
          tree: twoGroupTree(),
          rules: [
            rule({
              id: 'r1',
              isEnabled: false,
              targetId: 'option-1',
              conditions: [{ optionId: 'option-2', operator: 'is_empty' }],
            }),
            rule({
              id: 'r2',
              isEnabled: false,
              targetId: 'option-2',
              conditions: [{ optionId: 'option-1', operator: 'is_empty' }],
            }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    /** A three-rule loop, to prove the search is not special-cased to two. */
    it('blocks a loop that closes through a third rule', () => {
      const tree: OptionSetTree = {
        set: set(),
        rules: [],
        groups: [
          {
            group: group(),
            items: [],
            options: [
              { option: option(), values: [value()] },
              { option: option({ id: 'option-2', key: 'b', label: 'B' }), values: [value({ id: 'value-2', valueKey: 'b' })] },
              { option: option({ id: 'option-3', key: 'c', label: 'C' }), values: [value({ id: 'value-3', valueKey: 'c' })] },
            ],
          },
        ],
      };

      const findings = rulesHaveNoCycles.validate(
        context({
          tree,
          rules: [
            rule({ id: 'r1', targetId: 'option-1', conditions: [{ optionId: 'option-2', operator: 'is_empty' }] }),
            rule({ id: 'r2', targetId: 'option-2', conditions: [{ optionId: 'option-3', operator: 'is_empty' }] }),
            rule({ id: 'r3', targetId: 'option-3', conditions: [{ optionId: 'option-1', operator: 'is_empty' }] }),
          ],
        }),
      );

      expect(findings.map((finding) => finding.code)).toEqual(['RULES_FORM_A_CYCLE']);
    });

    /** A chain is not a loop: A affects B affects C, and nothing returns. */
    it('accepts a long chain that never closes', () => {
      const tree: OptionSetTree = {
        set: set(),
        rules: [],
        groups: [
          {
            group: group(),
            items: [],
            options: [
              { option: option(), values: [value()] },
              { option: option({ id: 'option-2', key: 'b', label: 'B' }), values: [value({ id: 'value-2', valueKey: 'b' })] },
              { option: option({ id: 'option-3', key: 'c', label: 'C' }), values: [value({ id: 'value-3', valueKey: 'c' })] },
            ],
          },
        ],
      };

      const findings = rulesHaveNoCycles.validate(
        context({
          tree,
          rules: [
            rule({ id: 'r1', targetId: 'option-2', conditions: [{ optionId: 'option-1', operator: 'is_empty' }] }),
            rule({ id: 'r2', targetId: 'option-3', conditions: [{ optionId: 'option-2', operator: 'is_empty' }] }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });
  });

  /**
   * 🔴 ADR-049 said this in 17-0 and nothing implemented it until 17-4. The
   * decision fell between stages — too pricing-specific for 17-3's cycle work,
   * assumed already done by the time 17-4 planned to consume it.
   */
  describe('set_price against an option that prices itself', () => {
    function pricedTree(type: string): OptionSetTree {
      const tree = twoGroupTree();
      tree.groups[0]!.options[0]!.option.pricing = { type, amountMinor: 50 };

      return tree;
    }

    it.each(['per_char', 'per_unit', 'tiered'])(
      'blocks a flat price on an option priced by %s',
      (type) => {
        const findings = setPriceDoesNotFightOptionPricing.validate(
          context({ tree: pricedTree(type), rules: [rule({ action: 'set_price' })] }),
        );

        expect(findings).toHaveLength(1);
        expect(findings[0]?.code).toBe('SET_PRICE_OVERRIDES_OPTION_PRICING');
        expect(findings[0]?.severity).toBe(PublishSeverity.BLOCKER);
      },
    );

    /** `fixed` and `percentage` price a VALUE; there is nothing to fight. */
    it('allows a flat price on an option with no option-level pricing', () => {
      expect(
        setPriceDoesNotFightOptionPricing.validate(
          context({ tree: twoGroupTree(), rules: [rule({ action: 'set_price' })] }),
        ),
      ).toEqual([]);
    });

    /**
     * ⚠️ The two never collide at the value level: an option-level type prices
     * what the customer *supplied*, and an option supplying a quantity or a
     * string has no values to target.
     */
    /**
     * ✏️ **The first version of this test proved nothing.** It targeted
     * `value-1` while `pricedTree` prices `option-1` — two different ids, so the
     * lookup missed whatever the guard did, and a mutation removing the
     * `targetType !== 'option'` check survived it.
     *
     * The id must be one the pricing map actually holds. Targeting the priced
     * OPTION's id under `targetType: 'value'` is the case that separates "is
     * this id priced" from "is this rule aimed at an option" — the two questions
     * the guard exists to keep apart.
     */
    it('allows a value-targeted rule even when that id names a priced option', () => {
      expect(
        setPriceDoesNotFightOptionPricing.validate(
          context({
            tree: pricedTree('per_unit'),
            rules: [rule({ action: 'set_price', targetType: 'value', targetId: 'option-1' })],
          }),
        ),
      ).toEqual([]);
    });

    it('says nothing about actions other than set_price', () => {
      expect(
        setPriceDoesNotFightOptionPricing.validate(
          context({ tree: pricedTree('tiered'), rules: [rule({ action: 'hide' })] }),
        ),
      ).toEqual([]);
    });

    it('says nothing about a disabled rule', () => {
      expect(
        setPriceDoesNotFightOptionPricing.validate(
          context({
            tree: pricedTree('per_char'),
            rules: [rule({ action: 'set_price', isEnabled: false })],
          }),
        ),
      ).toEqual([]);
    });
  });

  /**
   * 🔴 **Without this, `sortOrder` decides a price** (M17.4a, ADR-052).
   *
   * Measured in both languages identically before this check existed: two
   * `set_price` rules of 500 and 700 on one target charged **700** in document
   * order `[500, 700]` and **500** in `[700, 500]` — last-wins.
   *
   * That contradicts M17.2's order-independence, ADR-052's *"`sortOrder` is
   * never consulted"*, and the service, controller and API contract, all of
   * which call it *"presentation, not precedence"*.
   *
   * ⚠️ **The shared fixture is structurally unable to catch it**: the two
   * evaluators agree precisely, on the wrong thing.
   */
  describe('rules that set different payloads on one target', () => {
    const priced = (id: string, amountMinor: number) =>
      rule({ id, action: 'set_price', actionValue: { amountMinor } });

    it('blocks two set_price rules that disagree about the amount', () => {
      const findings = rulePayloadsDoNotConflict.validate(
        context({ rules: [priced('r1', 500), priced('r2', 700)] }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('RULE_PAYLOADS_CONFLICT');
      expect(findings[0]?.severity).toBe(PublishSeverity.BLOCKER);
    });

    it('names both rules, so a merchant knows what disagrees', () => {
      const findings = rulePayloadsDoNotConflict.validate(
        context({ rules: [priced('r1', 500), priced('r2', 700)] }),
      );

      expect(findings[0]?.message).toContain('r1');
      expect(findings[0]?.message).toContain('r2');
    });

    /**
     * ⚠️ Two rules setting the **same** amount agree. Refusing them would fail a
     * merchant whose duplicate rules are harmless.
     */
    it('allows two rules that set the same amount', () => {
      expect(
        rulePayloadsDoNotConflict.validate(
          context({ rules: [priced('r1', 500), priced('r2', 500)] }),
        ),
      ).toEqual([]);
    });

    /**
     * ✏️ **This asserted that two disagreeing `set_default` rules were blocked.**
     * They were, and rightly: `large` versus `small` has no principled winner,
     * the same reasoning ADR-052 gives for `set_price`.
     *
     * ADR-055 withdrew the action, so nothing can author such a pair and a
     * stored one publishes a rule that does nothing. Inverted rather than
     * deleted, so a withdrawn action quietly regaining a payload is caught.
     */
    it('says nothing about a withdrawn action, whatever its stored payload', () => {
      const findings = rulePayloadsDoNotConflict.validate(
        context({
          rules: [
            rule({ id: 'r1', action: 'set_default' as never, actionValue: { valueKey: 'large' } }),
            rule({ id: 'r2', action: 'set_default' as never, actionValue: { valueKey: 'small' } }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    /**
     * Different **targets** do not conflict — each is decided on its own, which
     * is the whole point of keying by target rather than by action alone.
     */
    it('allows different amounts on different targets', () => {
      const findings = rulePayloadsDoNotConflict.validate(
        context({
          rules: [
            priced('r1', 500),
            rule({ id: 'r2', targetId: 'option-2', action: 'set_price', actionValue: { amountMinor: 700 } }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    /**
     * A price and a default are different questions about one option, and
     * answering both is ordinary — only two answers to the *same* question
     * conflict.
     */
    it('allows a price and a default on one target', () => {
      const findings = rulePayloadsDoNotConflict.validate(
        context({
          rules: [
            priced('r1', 500),
            rule({ id: 'r2', action: 'set_default', actionValue: { valueKey: 'large' } }),
          ],
        }),
      );

      expect(findings).toEqual([]);
    });

    /** A conflict between rules that never run is not one a storefront reaches. */
    it('ignores a conflict whose rules are disabled', () => {
      const findings = rulePayloadsDoNotConflict.validate(
        context({
          rules: [priced('r1', 500), rule({ id: 'r2', action: 'set_price', actionValue: { amountMinor: 700 }, isEnabled: false })],
        }),
      );

      expect(findings).toEqual([]);
    });

    it('says nothing about actions that carry no payload', () => {
      expect(
        rulePayloadsDoNotConflict.validate(
          context({ rules: [rule({ id: 'r1', action: 'hide' }), rule({ id: 'r2', action: 'show' })] }),
        ),
      ).toEqual([]);
    });
  });

  describe('the validator list', () => {
    it('runs every registered validator', () => {
      const names = PUBLISH_VALIDATORS.map((validator) => validator.name);

      expect(names).toEqual([
        'set-has-content',
        'options-have-values',
        'rules-have-targets',
        'rule-targets-are-in-this-set',
        'rules-have-no-cycles',
        'set-price-does-not-fight-option-pricing',
        'rule-payloads-do-not-conflict',
        'rule-conditions-are-a-list',
        'set-has-assignments',
        'patterns-are-safe',
      ]);
    });

    it('accepts a validator appended without touching publish', () => {
      const findings = runPublishChecks(context(), [
        ...PUBLISH_VALIDATORS,
        {
          name: 'phase-17-cycle-detection',
          validate: () => [
            {
              severity: PublishSeverity.BLOCKER,
              code: 'RULE_CYCLE',
              subject: 'set:set-1',
              message: 'Rules form a cycle.',
            },
          ],
        },
      ]);

      expect(findings.some((f) => f.code === 'RULE_CYCLE')).toBe(true);
      expect(hasBlockers(findings)).toBe(true);
    });
  });
});
