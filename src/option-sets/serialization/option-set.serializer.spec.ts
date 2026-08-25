import { OptionGroup } from '../entities/option-group.entity';
import { OptionSet } from '../entities/option-set.entity';
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

function tree(overrides: Partial<OptionSetTree> = {}): OptionSetTree {
  return {
    set: set(),
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
     */
    it('does not leak the soft-delete sentinel', () => {
      expect(JSON.stringify(serializer.toAuthoring(tree()))).not.toContain('1970');
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
      ['the soft-delete sentinel', '1970'],
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

      const fromJson = serializer.toPublished(
        tree({
          groups: [
            {
              group: group(),
              items: [],
              options: [
                {
                  option: option(),
                  values: [value({ priceConfig: { type: 'percentage', basis_points: 250 } })],
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
