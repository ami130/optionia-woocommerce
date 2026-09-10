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

function context(overrides: Partial<PublishContext> = {}): PublishContext {
  const tree: OptionSetTree = {
    set: set(),
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
        context({ tree: { set: set(), groups: [] } }),
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
          tree: { set: set(), groups: [{ group: group(), items: [], options: [] }] },
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
            { id: 'rule-1', targetType: 'option', targetId: 'gone', isEnabled: false, disabledReason: 'target_deleted' },
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
            { id: 'rule-1', targetType: 'option', targetId: 'x', isEnabled: false, disabledReason: null },
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

  describe('the validator list', () => {
    it('runs every registered validator', () => {
      const names = PUBLISH_VALIDATORS.map((validator) => validator.name);

      expect(names).toEqual([
        'set-has-content',
        'options-have-values',
        'rules-have-targets',
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
