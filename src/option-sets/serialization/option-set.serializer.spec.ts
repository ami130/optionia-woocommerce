import { OptionGroup } from '../entities/option-group.entity';
import { OptionSet } from '../entities/option-set.entity';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OptionRule } from '../entities/option-rule.entity';
import { OptionValue } from '../entities/option-value.entity';
import { Option } from '../entities/option.entity';
import { PresentationalItem } from '../entities/presentational-item.entity';
import { OptionSetSerializer, type OptionSetTree } from './option-set.serializer';

const AT = new Date('2026-01-02T03:04:05.678Z');

function set(overrides: Partial<OptionSet> = {}): OptionSet {
  return Object.assign(new OptionSet(), {
    id: 'set-1',
    tenantId: 'tenant-secret',
    storeId: 'store-1',
    name: 'Set',
    status: 'draft',
    version: 3,
    rowVersion: 7,
    publishedAt: null,
    publishedBy: null,
    publishedConfigVersion: 0,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: new Date(1970, 0, 1),
    ...overrides,
  });
}

function group(overrides: Partial<OptionGroup> = {}): OptionGroup {
  return Object.assign(new OptionGroup(), {
    id: 'group-1',
    optionSetId: 'set-1',
    label: 'Customization',
    description: null,
    displayType: 'inline',
    sortOrder: 10,
    isCollapsible: false,
    isEnabled: true,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: new Date(1970, 0, 1),
    ...overrides,
  });
}

function option(overrides: Partial<Option> = {}): Option {
  return Object.assign(new Option(), {
    id: 'option-1',
    optionGroupId: 'group-1',
    key: 'print_placement',
    valueKind: 'choice',
    cardinality: 'one',
    presentation: 'radio',
    label: 'Print',
    description: null,
    placeholder: null,
    helpText: null,
    isRequired: true,
    isEnabled: true,
    sortOrder: 10,
    defaultValue: null,
    validation: null,
    pricing: null,
    display: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: new Date(1970, 0, 1),
    ...overrides,
  });
}

function value(overrides: Partial<OptionValue> = {}): OptionValue {
  return Object.assign(new OptionValue(), {
    id: 'value-1',
    optionId: 'option-1',
    valueKey: 'front',
    label: 'Front',
    sortOrder: 10,
    priceType: 'fixed',
    priceAmountMinor: 1000,
    priceConfig: null,
    imageUrl: null,
    colorHex: null,
    skuSuffix: null,
    weightDeltaGrams: null,
    isDefault: false,
    isEnabled: true,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: new Date(1970, 0, 1),
    ...overrides,
  });
}

function item(overrides: Partial<PresentationalItem> = {}): PresentationalItem {
  return Object.assign(new PresentationalItem(), {
    id: 'item-1',
    optionGroupId: 'group-1',
    kind: 'heading',
    content: 'Make it yours',
    sortOrder: 5,
    display: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: new Date(1970, 0, 1),
    ...overrides,
  });
}

const OPTION_ID = '0199b8c2-0000-7000-8000-000000000001';

function rule(overrides: Partial<OptionRule> = {}): OptionRule {
  return Object.assign(new OptionRule(), {
    id: 'rule-1',
    optionSetId: 'set-1',
    targetType: 'option',
    targetId: OPTION_ID,
    action: 'hide',
    matchType: 'all',
    conditions: [{ optionId: OPTION_ID, operator: 'is_empty' }],
    actionValue: null,
    sortOrder: 10,
    isEnabled: true,
    disabledReason: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: new Date(1970, 0, 1),
    ...overrides,
  });
}

function tree(overrides: Partial<OptionSetTree> = {}): OptionSetTree {
  return {
    set: set(),
    rules: [],
    groups: [{ group: group(), items: [item()], options: [{ option: option(), values: [value()] }] }],
    ...overrides,
  };
}

describe('OptionSetSerializer', () => {
  const serializer = new OptionSetSerializer();

  describe('authoring projection', () => {
    it('carries the fields the editor needs', () => {
      const result = serializer.toAuthoring(tree());

      expect(result).toMatchObject({
        id: 'set-1',
        storeId: 'store-1',
        name: 'Set',
        status: 'draft',
        version: 3,
        rowVersion: 7,
      });
      expect(result.groups[0].options[0].values[0].valueKey).toBe('front');
      expect(result.groups[0].items[0].kind).toBe('heading');
    });

    /** Tenancy is the API's concern, never a payload's. */
    it('never exposes the tenant', () => {
      expect(JSON.stringify(serializer.toAuthoring(tree()))).not.toContain('tenant-secret');
    });

    /**
     * The sentinel is an implementation detail of soft deletion (ADR-014).
     * A client seeing `deletedAt: 1970-01-01` on every live row learns nothing.
     *
     * Matched as `1970-01-01`, not `1970`: a UUIDv7 contains the four digits
     * `1970` roughly once in 3,400, so the looser assertion failed at random —
     * about a 0.3% chance per document — and looked like a serialization bug.
     */
    it('does not leak the soft-delete sentinel', () => {
      expect(JSON.stringify(serializer.toAuthoring(tree()))).not.toContain('1970-01-01');
    });

    it('keeps disabled things, because the editor must show them', () => {
      const disabled = tree({
        groups: [
          {
            group: group({ isEnabled: false }),
            items: [],
            options: [{ option: option({ isEnabled: false }), values: [value({ isEnabled: false })] }],
          },
        ],
      });

      const result = serializer.toAuthoring(disabled);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].isEnabled).toBe(false);
      expect(result.groups[0].options[0].values[0].isEnabled).toBe(false);
    });

    it('renders timestamps as ISO strings', () => {
      expect(serializer.toAuthoring(tree()).createdAt).toBe('2026-01-02T03:04:05.678Z');
    });

    it('keeps publishedAt null on an unpublished set', () => {
      expect(serializer.toAuthoring(tree()).publishedAt).toBeNull();
    });

    /**
     * The editor shows "published by X at Y" and had only the timestamp.
     * Deliberately absent from the published projection: the plugin has no use
     * for a user id, and naming a merchant's staff in a document that sits on
     * their storefront is needless exposure.
     */
    it('carries who published, and keeps it out of the document', () => {
      const published = tree({
        set: set({ publishedBy: 'user-42', publishedAt: AT, status: 'published' }),
      });

      expect(serializer.toAuthoring(published).publishedBy).toBe('user-42');
      expect(JSON.stringify(serializer.toPublished(published))).not.toContain('user-42');
    });
  });

  /**
   * Rules in the document (M17.5).
   *
   * 🔴 **The keys are the whole risk.** `check-wire-keys.sh` exists because this
   * defect has shipped twice — `price_config` emitted `amountMinor` on one path,
   * and `validation`/`display` were published verbatim so a merchant's
   * `maxLength` arrived spelled in a way `SelectionResolver` never looks for:
   * *present in the document, enforced nowhere.*
   */
  /**
   * Rules in the authoring view (M17.5, corrected by its own audit).
   *
   * ✏️ **The tree loaded rules and this projection discarded them** — a fifth
   * query on every dashboard render whose result was thrown away, while the plan
   * recorded that the authoring view carried them. Both halves were wrong, in
   * opposite directions, and the audit found them by reading the projection
   * rather than the claim.
   */
  describe('rules in the authoring view', () => {
    it('carries the rule the editor has to draw', () => {
      const [authored] = serializer.toAuthoring(tree({ rules: [rule()] })).rules;

      expect(authored).toEqual({
        id: 'rule-1',
        targetType: 'option',
        targetId: OPTION_ID,
        action: 'hide',
        matchType: 'all',
        conditions: [{ optionId: OPTION_ID, operator: 'is_empty' }],
        actionValue: null,
        sortOrder: 10,
        isEnabled: true,
        disabledReason: null,
        createdAt: AT.toISOString(),
        updatedAt: AT.toISOString(),
      });
    });

    /**
     * 🔴 **The opposite of the published projection, deliberately.** A merchant
     * must see a rule the cascade switched off *and why*; a storefront never
     * receives one, so there the flag has nothing to say.
     */
    it('keeps a disabled rule, with the reason it was disabled for', () => {
      const [authored] = serializer.toAuthoring(
        tree({ rules: [rule({ isEnabled: false, disabledReason: 'target_deleted' })] }),
      ).rules;

      expect(authored?.isEnabled).toBe(false);
      expect(authored?.disabledReason).toBe('target_deleted');
    });

    /**
     * ⚠️ **camelCase, passed through as stored.** The dashboard authored these
     * in this shape and reads them back in it; the published projection is the
     * one place they are rewritten for a PHP reader.
     */
    it('leaves conditions in the shape the dashboard authored', () => {
      const [authored] = serializer.toAuthoring(
        tree({ rules: [rule({ conditions: [{ optionId: OPTION_ID, operator: 'equals', value: 'x' }] })] }),
      ).rules;

      expect(authored?.conditions).toEqual([
        { optionId: OPTION_ID, operator: 'equals', value: 'x' },
      ]);
    });

    it('carries a payload without renaming it', () => {
      const [authored] = serializer.toAuthoring(
        tree({ rules: [rule({ action: 'set_price', actionValue: { amountMinor: 500 } })] }),
      ).rules;

      expect(authored?.actionValue).toEqual({ amountMinor: 500 });
    });

    it('survives a stored shape that is not a list', () => {
      const [authored] = serializer.toAuthoring(
        tree({ rules: [rule({ conditions: null as never })] }),
      ).rules;

      expect(authored?.conditions).toEqual([]);
    });

    it('carries no rules when a set has none', () => {
      expect(serializer.toAuthoring(tree()).rules).toEqual([]);
    });
  });

  describe('rules in the published document', () => {
    it('emits every key in the document’s snake_case convention', () => {
      const [published] = serializer.toPublished(tree({ rules: [rule()] })).rules;

      expect(published).toEqual({
        id: 'rule-1',
        target_type: 'option',
        target_id: OPTION_ID,
        action: 'hide',
        match_type: 'all',
        conditions: [{ option_id: OPTION_ID, operator: 'is_empty' }],
        sort_order: 10,
      });
    });

    it('carries a condition’s operand when it has one', () => {
      const [published] = serializer.toPublished(
        tree({
          rules: [rule({ conditions: [{ optionId: OPTION_ID, operator: 'equals', value: 'yes' }] })],
        }),
      ).rules;

      expect(published?.conditions).toEqual([
        { option_id: OPTION_ID, operator: 'equals', value: 'yes' },
      ]);
    });

    /**
     * ⚠️ `is_empty` carries no operand and the schema refuses one. Emitting
     * `value: undefined` would put a key in the document a PHP reader sees as
     * `null` — a third state where there are two.
     */
    it('omits the operand entirely when the operator takes none', () => {
      const [published] = serializer.toPublished(tree({ rules: [rule()] })).rules;

      expect(published?.conditions[0]).not.toHaveProperty('value');
    });

    describe('the payload an action acts with', () => {
      it('renames set_price’s amount', () => {
        const [published] = serializer.toPublished(
          tree({ rules: [rule({ action: 'set_price', actionValue: { amountMinor: 500 } })] }),
        ).rules;

        expect(published?.action_value).toEqual({ amount_minor: 500 });
      });

      it('renames set_default’s value key', () => {
        const [published] = serializer.toPublished(
          tree({ rules: [rule({ action: 'set_default', actionValue: { valueKey: 'large' } })] }),
        ).rules;

        expect(published?.action_value).toEqual({ value_key: 'large' });
      });

      /**
       * Omitted rather than null: a key always present and usually null teaches
       * a reader to ignore it.
       */
      it('omits the payload for an action that acts on its own', () => {
        const [published] = serializer.toPublished(tree({ rules: [rule()] })).rules;

        expect(published).not.toHaveProperty('action_value');
      });

      /**
       * ⚠️ A payload on a `hide` rule is a row written before M17.4's
       * per-action validation. Dropping it is right — nothing reads it, and
       * carrying it forward preserves a merchant's mistaken belief that they
       * configured something.
       */
      it('drops a payload the action cannot use', () => {
        const [published] = serializer.toPublished(
          tree({ rules: [rule({ action: 'hide', actionValue: { amountMinor: 500 } })] }),
        ).rules;

        expect(published).not.toHaveProperty('action_value');
      });
    });

    /**
     * 🔴 **A disabled rule is absent entirely**, exactly as a disabled group,
     * option or value is. M17.3's `RULE_TARGET_NOT_PUBLISHED` warning depends on
     * this: it warns that a rule pointing at a disabled *target* will not fire,
     * which would be incoherent if disabled rules shipped anyway.
     */
    it('leaves a disabled rule out of the document', () => {
      const published = serializer.toPublished(
        tree({ rules: [rule({ isEnabled: false })] }),
      );

      expect(published.rules).toEqual([]);
    });

    it('leaves out a rule the cascade disabled, whose target is gone', () => {
      const published = serializer.toPublished(
        tree({ rules: [rule({ isEnabled: false, disabledReason: 'target_deleted' })] }),
      );

      expect(published.rules).toEqual([]);
    });

    /**
     * ⚠️ `is_enabled` and `disabled_reason` are absent by construction: a rule
     * that is not published has nothing to say about why, and the merchant is
     * told at publish by `rulesHaveTargets` instead.
     */
    it('never carries the enabled flag or its reason', () => {
      const [published] = serializer.toPublished(tree({ rules: [rule()] })).rules;

      expect(published).not.toHaveProperty('is_enabled');
      expect(published).not.toHaveProperty('disabled_reason');
    });

    it('carries no rules when a set has none', () => {
      expect(serializer.toPublished(tree()).rules).toEqual([]);
    });

    /**
     * 🔴 **The serializer and the shared fixture describe one wire shape, and
     * nothing tied them together until this.**
     *
     * The fixture is what M17.6's PHP evaluator is built against; the serializer
     * is what actually reaches a storefront. Measured before this test: the
     * serializer emitted `sort_order` and the fixture omitted it, so the PHP
     * evaluator would have been written against a shape **missing a key the real
     * document always carries**.
     *
     * That is `assignment-wire.json`'s lesson one artifact over — that fixture
     * exists because a hand-written shape is a guess, and the Phase 8 envelope
     * defect was two internally consistent halves that disagreed. The fixture was
     * built in M17.4 from what the evaluator needed and the serializer in M17.5
     * from what the document needs, and neither was compared to the other.
     *
     * Compares **key sets**, not values: the fixture's ids and amounts are its
     * own, and pinning those here would make every fixture edit fail a
     * serializer test for no reason.
     */
    it('emits exactly the keys the shared rule fixture declares', () => {
      const fixture = JSON.parse(
        readFileSync(join(__dirname, '..', '..', '..', 'test', 'fixtures', 'shared', 'rule-fixtures.json'), 'utf8'),
      ) as { rule_cases: ReadonlyArray<{ rules: ReadonlyArray<Record<string, unknown>> }> };

      const fixtureKeys = new Set<string>();

      fixture.rule_cases.forEach((testCase) => {
        testCase.rules.forEach((raw) => {
          Object.keys(raw).forEach((key) => fixtureKeys.add(key));
        });
      });

      /* A rule carrying a payload, so `action_value` is in the produced set. */
      const produced = serializer.toPublished(
        tree({ rules: [rule({ action: 'set_price', actionValue: { amountMinor: 500 } })] }),
      ).rules[0] as unknown as Record<string, unknown>;

      expect(new Set(Object.keys(produced))).toEqual(fixtureKeys);
    });
  });

  describe('published projection', () => {
    it('uses the config document’s shape', () => {
      const result = serializer.toPublished(tree());

      expect(result).toMatchObject({ id: 'set-1', version: 3 });
      expect(result.groups[0]).toMatchObject({
        label: 'Customization',
        display_type: 'inline',
        sort_order: 10,
      });
      expect(result.groups[0].options[0]).toMatchObject({
        key: 'print_placement',
        type: 'radio',
        is_required: true,
      });
      expect(result.groups[0].options[0].values[0]).toMatchObject({
        value_key: 'front',
        label: 'Front',
      });
    });

    /**
     * The config document sits on merchant servers, so anything unnecessary is
     * needless exposure.
     */
    it.each([
      ['the tenant', 'tenant-secret'],
      ['the row version', 'rowVersion'],
      ['audit timestamps', 'createdAt'],
      ['the enable flag', 'isEnabled'],
      ['parent ids', 'optionGroupId'],
      ['the soft-delete sentinel', '1970-01-01'],
    ])('omits %s', (_label, needle) => {
      expect(JSON.stringify(serializer.toPublished(tree()))).not.toContain(needle);
    });

    /**
     * Dropped, not flagged. A flag makes every consumer responsible for
     * remembering to check it, and one of them will forget.
     */
    it('drops a disabled group entirely', () => {
      const result = serializer.toPublished(
        tree({
          groups: [
            { group: group({ isEnabled: false }), items: [], options: [] },
            { group: group({ id: 'group-2', isEnabled: true }), items: [], options: [] },
          ],
        }),
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].id).toBe('group-2');
    });

    it('drops a disabled option and a disabled value', () => {
      const result = serializer.toPublished(
        tree({
          groups: [
            {
              group: group(),
              items: [],
              options: [
                { option: option({ isEnabled: false }), values: [] },
                {
                  option: option({ id: 'option-2', key: 'kept' }),
                  values: [value({ isEnabled: false }), value({ id: 'value-2', valueKey: 'kept' })],
                },
              ],
            },
          ],
        }),
      );

      expect(result.groups[0].options).toHaveLength(1);
      expect(result.groups[0].options[0].key).toBe('kept');
      expect(result.groups[0].options[0].values).toHaveLength(1);
      expect(result.groups[0].options[0].values[0].value_key).toBe('kept');
    });

    /** Two ways to express a price is two ways for two evaluators to disagree. */
    it('always emits one price shape', () => {
      const fromColumns = serializer.toPublished(tree());

      expect(fromColumns.groups[0].options[0].values[0].price_config).toEqual({
        type: 'fixed',
        amount_minor: 1000,
      });

      // The stored JSON is camelCase — its schema is TypeScript. The document is
      // snake_case, whichever path produced the value.
      const fromJson = serializer.toPublished(
        tree({
          groups: [
            {
              group: group(),
              items: [],
              options: [
                {
                  option: option(),
                  values: [value({ priceConfig: { type: 'percentage', basisPoints: 250 } })],
                },
              ],
            },
          ],
        }),
      );

      expect(fromJson.groups[0].options[0].values[0].price_config).toEqual({
        type: 'percentage',
        basis_points: 250,
      });
    });

    /**
     * The defect this replaced: a value priced through `price_config` emitted
     * `amountMinor` while one priced through the columns emitted `amount_minor`,
     * so the same document carried two spellings of one field and a PHP
     * evaluator reading `amount_minor` got null for half its values.
     */
    it('uses one spelling for every price, whichever path produced it', () => {
      const both = serializer.toPublished(
        tree({
          groups: [
            {
              group: group(),
              items: [],
              options: [
                {
                  option: option(),
                  values: [
                    value({ id: 'from-columns', valueKey: 'columns' }),
                    value({
                      id: 'from-json',
                      valueKey: 'json',
                      priceConfig: { type: 'fixed', amountMinor: 250 },
                    }),
                  ],
                },
              ],
            },
          ],
        }),
      );

      const configs = both.groups[0].options[0].values.map((v) => v.price_config);

      configs.forEach((config) => {
        expect(config).toHaveProperty('amount_minor');
        expect(config).not.toHaveProperty('amountMinor');
      });
      expect(configs[0].amount_minor).toBe(1000);
      expect(configs[1].amount_minor).toBe(250);
    });

    /** Money is an integer in minor units on the wire (ADR-013). */
    it('keeps money an integer', () => {
      const amount = serializer.toPublished(tree()).groups[0].options[0].values[0].price_config
        .amount_minor;

      expect(Number.isInteger(amount)).toBe(true);
    });

    it('omits unset optionals rather than sending null', () => {
      const json = serializer.toPublished(tree());

      expect(json.groups[0].options[0]).not.toHaveProperty('description');
      expect(json.groups[0].options[0]).not.toHaveProperty('validation');
      expect(json.groups[0].options[0].values[0]).not.toHaveProperty('image_url');
    });

    it('includes optionals that are set', () => {
      const result = serializer.toPublished(
        tree({
          groups: [
            {
              group: group({ description: 'Pick one' }),
              items: [],
              options: [
                {
                  option: option({ validation: { required: true }, helpText: 'Choose' }),
                  values: [value({ imageUrl: 'https://x.test/a.png', isDefault: true })],
                },
              ],
            },
          ],
        }),
      );

      expect(result.groups[0].description).toBe('Pick one');
      expect(result.groups[0].options[0].validation).toEqual({ required: true });
      expect(result.groups[0].options[0].help_text).toBe('Choose');
      expect(result.groups[0].options[0].values[0].image_url).toBe('https://x.test/a.png');
    });

    /**
     * 🔴 The serializer must CONVERT option-level pricing, not pass it through.
     *
     * `option-config.spec.ts` proves the converter is right. It cannot prove the
     * serializer calls it — measured: reverting this line to
     * `optional('pricing', option.pricing)` left all 33 serialization tests
     * green, because every one of them tested the converter in isolation.
     *
     * That is the same "correct by inheritance rather than by test" gap that let
     * `pricing` drift from `price_config` in the first place, so the assertion
     * runs through `toPublished()` on a real tree.
     */
    it('converts option-level pricing rather than publishing it verbatim', () => {
      const published = serializer.toPublished(
        tree({
          groups: [
            {
              group: group(),
              items: [],
              options: [
                {
                  option: option({
                    pricing: { type: 'per_char', amountMinor: 25, freeCharacters: 10 },
                  }),
                  values: [value()],
                },
              ],
            },
          ],
        }),
      );

      expect(published.groups[0].options[0].pricing).toEqual({
        type: 'per_char',
        amount_minor: 25,
        free_characters: 10,
      });
    });

    /**
     * 🔴 Every optional value field reaches the document when it is set.
     *
     * Measured: deleting `sku_suffix`, `weight_delta_grams`, `color_hex` or
     * `group_label` from the serializer left **all 60 serialization tests
     * green**. Only `image_url` was protected, by a test that happened to assert
     * it for another reason.
     *
     * The plugin reads all of them — `weight_delta_grams` sets the shipping
     * weight and `sku_suffix` reaches the order line — both M16.8 — so a
     * field silently dropped here is a merchant's configuration doing nothing,
     * with no error anywhere because nothing failed. That is the exact shape of
     * gap both of those milestones existed to close, reopened one repository
     * over.
     *
     * Asserted as a set rather than one test each, so a **new** optional field
     * added to `valueToPublished` without a line here shows up as a missing key
     * rather than as a silently unprotected one.
     */
    it('publishes every optional value field that is set', () => {
      const published = serializer.toPublished(
        tree({
          groups: [
            {
              group: group(),
              items: [],
              options: [
                {
                  option: option(),
                  values: [
                    value({
                      imageUrl: 'https://x.test/a.png',
                      colorHex: '#ff0000',
                      groupLabel: 'Woods',
                      skuSuffix: '-OAK',
                      weightDeltaGrams: 8000,
                    }),
                  ],
                },
              ],
            },
          ],
        }),
      );

      expect(published.groups[0].options[0].values[0]).toMatchObject({
        image_url: 'https://x.test/a.png',
        color_hex: '#ff0000',
        group_label: 'Woods',
        sku_suffix: '-OAK',
        weight_delta_grams: 8000,
      });
    });

    /**
     * And omitted when unset, which is what `optional()` is for.
     *
     * A document carrying `"sku_suffix": null` on every value would be larger
     * for no reason and would make "no suffix" indistinguishable from "the
     * merchant cleared it" for a reader that checks key presence.
     */
    it('omits every optional value field that is unset', () => {
      const published = serializer.toPublished(tree());
      const first = published.groups[0].options[0].values[0];

      ['image_url', 'color_hex', 'group_label', 'sku_suffix', 'weight_delta_grams'].forEach(
        (key) => {
          expect(first).not.toHaveProperty(key);
        },
      );
    });

    /** A renderer asks which value is default; the rest is noise on every fetch. */
    it('marks the default value only when it is one', () => {
      const plain = serializer.toPublished(tree());
      expect(plain.groups[0].options[0].values[0]).not.toHaveProperty('is_default');

      const withDefault = serializer.toPublished(
        tree({
          groups: [
            {
              group: group(),
              items: [],
              options: [{ option: option(), values: [value({ isDefault: true })] }],
            },
          ],
        }),
      );
      expect(withDefault.groups[0].options[0].values[0].is_default).toBe(true);
    });

    it('carries presentational items', () => {
      const result = serializer.toPublished(tree());

      expect(result.groups[0].items[0]).toEqual({
        kind: 'heading',
        content: 'Make it yours',
        sort_order: 5,
      });
    });

    it('serializes an empty set without children', () => {
      const result = serializer.toPublished(tree({ groups: [] }));

      expect(result.groups).toEqual([]);
    });
  });

  /**
   * The acceptance M7.2b asks for. Both projections must survive JSON: the
   * authoring shape crosses HTTP to the dashboard, and the published shape is
   * stored as an immutable snapshot ([7i]) and posted to a plugin.
   */
  describe('round trip', () => {
    it('survives JSON unchanged, in both projections', () => {
      const authoring = serializer.toAuthoring(tree());
      const published = serializer.toPublished(tree());

      expect(JSON.parse(JSON.stringify(authoring))).toEqual(authoring);
      expect(JSON.parse(JSON.stringify(published))).toEqual(published);
    });

    /** A snapshot that differs between two builds of unchanged data is useless. */
    it('is deterministic for the same input', () => {
      expect(JSON.stringify(serializer.toPublished(tree()))).toBe(
        JSON.stringify(serializer.toPublished(tree())),
      );
    });
  });
});
