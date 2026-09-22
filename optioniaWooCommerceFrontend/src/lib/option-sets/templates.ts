import { PORTABLE_VERSION, type PortableSet } from './portable';

/**
 * Starter templates (M20.7) — "the fastest path to a merchant's first success".
 *
 * ## Why a template rather than a blank canvas
 *
 * 🔴 **Phase 20b states it directly**: *"A merchant's first option set should be
 * a template they adapt, never a blank canvas. Blank-canvas first runs are where
 * builders lose people: the merchant does not yet know what 'option group' means,
 * and an empty screen does not teach them."*
 *
 * ## Why they are portable documents
 *
 * 📌 **A template goes through the same path a merchant's own file does** —
 * `parsePortable`, then `POST /v1/option-sets/import`, one transaction. So there
 * is one way to build a set from a description rather than two, every rule the
 * import enforces applies to a template automatically, and a template that would
 * be refused fails a test here rather than a merchant's first click.
 *
 * ## About the numbers
 *
 * ⚠️ **These are defaults to edit, not recommendations.** A merchant's first act
 * is usually changing the price. What a template teaches is the **shape** — that
 * engraving prices per character and needs a length limit, that gift wrap is a
 * choice with a message attached, that made-to-order prices by the unit.
 */

export interface StarterTemplate {
  readonly id: string;
  readonly name: string;
  /** One line, shown beside the name when a merchant chooses. */
  readonly description: string;
  readonly build: () => PortableSet['groups'];
}

/** Sort orders in tens, matching what the API assigns on create. */
const at = (index: number): number => (index + 1) * 10;

/**
 * T-shirt printing — the one that teaches **per-value** pricing and swatches.
 *
 * Size is free; colour carries a small premium on two of four, which is what
 * makes the price column mean something on first sight.
 */
const tshirt = (): PortableSet['groups'] => [
  {
    label: 'Size and colour',
    description: 'What the customer chooses before printing.',
    displayType: 'inline',
    isCollapsible: false,
    isEnabled: true,
    sortOrder: at(0),
    options: [
      {
        key: 'size',
        label: 'Size',
        presentation: 'dropdown',
        isRequired: true,
        isEnabled: true,
        sortOrder: at(0),
        helpText: 'Chest measurements are on the size guide.',
        values: [
          { valueKey: 's', label: 'Small', sortOrder: at(0), priceType: 'fixed', priceAmountMinor: 0 },
          { valueKey: 'm', label: 'Medium', sortOrder: at(1), priceType: 'fixed', priceAmountMinor: 0 },
          { valueKey: 'l', label: 'Large', sortOrder: at(2), priceType: 'fixed', priceAmountMinor: 0 },
          {
            valueKey: 'xl',
            label: 'Extra large',
            sortOrder: at(3),
            priceType: 'fixed',
            /* Larger sizes cost more fabric — the commonest reason a size is priced. */
            priceAmountMinor: 200,
            skuSuffix: '-XL',
          },
        ],
      },
      {
        key: 'colour',
        label: 'Colour',
        presentation: 'color_swatch',
        isRequired: true,
        isEnabled: true,
        sortOrder: at(1),
        values: [
          {
            valueKey: 'white',
            label: 'White',
            sortOrder: at(0),
            priceType: 'fixed',
            priceAmountMinor: 0,
            colorHex: '#ffffff',
            isDefault: true,
          },
          {
            valueKey: 'black',
            label: 'Black',
            sortOrder: at(1),
            priceType: 'fixed',
            priceAmountMinor: 0,
            colorHex: '#111111',
          },
          {
            valueKey: 'navy',
            label: 'Navy',
            sortOrder: at(2),
            priceType: 'fixed',
            priceAmountMinor: 150,
            colorHex: '#1b2a4a',
          },
          {
            valueKey: 'forest',
            label: 'Forest green',
            sortOrder: at(3),
            priceType: 'fixed',
            priceAmountMinor: 150,
            colorHex: '#2c4f3a',
          },
        ],
      },
    ],
    items: [{ kind: 'heading', content: 'Choose your shirt', sortOrder: at(0) }],
  },
];

/**
 * Engraving — the one that teaches **per-character** pricing.
 *
 * 🔴 **The richest single template**: a text field, an option-level price, a
 * length limit, the counter derived from it, and a charset rule. It is the
 * example that shows a merchant the product prices things they type, not only
 * things they pick.
 */
const engraving = (): PortableSet['groups'] => [
  {
    label: 'Engraving',
    description: 'Added to the piece before it ships.',
    displayType: 'inline',
    isCollapsible: false,
    isEnabled: true,
    sortOrder: at(0),
    options: [
      {
        key: 'engraving_text',
        label: 'Engraving text',
        presentation: 'text_field',
        isRequired: false,
        isEnabled: true,
        sortOrder: at(0),
        placeholder: 'e.g. With love, 2026',
        /* ⚠️ The number here must match `maxLength` below — a help text that
         * promises a limit the rule does not enforce is the defect M14.4b names. */
        helpText: 'Up to 30 characters. The first 5 are free.',
        validation: { maxLength: 30, allowedCharset: 'latin' },
        /* The counter the plugin derives from `maxLength`. */
        display: { characterCounter: true },
        pricing: { type: 'per_char', amountMinor: 50, freeCharacters: 5 },
        values: [],
      },
      {
        key: 'engraving_font',
        label: 'Font',
        presentation: 'radio',
        isRequired: false,
        isEnabled: true,
        sortOrder: at(1),
        values: [
          {
            valueKey: 'script',
            label: 'Script',
            sortOrder: at(0),
            priceType: 'fixed',
            priceAmountMinor: 0,
            isDefault: true,
          },
          { valueKey: 'block', label: 'Block capitals', sortOrder: at(1), priceType: 'fixed', priceAmountMinor: 0 },
        ],
      },
    ],
    items: [],
  },
];

/**
 * Gift wrap — the simplest template, and the one most merchants want first.
 *
 * A priced choice plus an optional message, which together show that one group
 * can mix a paid option with a free one.
 */
const giftWrap = (): PortableSet['groups'] => [
  {
    label: 'Gift options',
    description: 'Offered at checkout.',
    displayType: 'inline',
    isCollapsible: true,
    isEnabled: true,
    sortOrder: at(0),
    options: [
      {
        key: 'gift_wrap',
        label: 'Gift wrapping',
        presentation: 'radio',
        isRequired: false,
        isEnabled: true,
        sortOrder: at(0),
        values: [
          {
            valueKey: 'none',
            label: 'No wrapping',
            sortOrder: at(0),
            priceType: 'fixed',
            priceAmountMinor: 0,
            isDefault: true,
          },
          {
            valueKey: 'standard',
            label: 'Gift wrapped',
            sortOrder: at(1),
            priceType: 'fixed',
            priceAmountMinor: 350,
            skuSuffix: '-GW',
            /* Paper and ribbon weigh something; shipping should know. */
            weightDeltaGrams: 40,
          },
        ],
      },
      {
        key: 'gift_message',
        label: 'Gift message',
        presentation: 'textarea',
        isRequired: false,
        isEnabled: true,
        sortOrder: at(1),
        placeholder: 'Written on the card, not the invoice.',
        helpText: 'Up to 200 characters.',
        validation: { maxLength: 200 },
        display: { characterCounter: true },
        values: [],
      },
    ],
    items: [],
  },
];

/**
 * Made-to-order dimensions — the one that teaches **per-unit** pricing.
 *
 * ⚠️ **Bounded on both sides.** A width with no maximum is an order nobody can
 * fulfil, and the validation rule is what makes the price safe to leave open.
 */
const dimensions = (): PortableSet['groups'] => [
  {
    label: 'Made to measure',
    description: 'Priced by the centimetre.',
    displayType: 'inline',
    isCollapsible: false,
    isEnabled: true,
    sortOrder: at(0),
    options: [
      {
        key: 'width_cm',
        label: 'Width (cm)',
        presentation: 'number_field',
        isRequired: true,
        isEnabled: true,
        sortOrder: at(0),
        helpText: 'Between 20 cm and 300 cm.',
        defaultValue: '100',
        validation: { min: 20, max: 300, integerOnly: true },
        pricing: { type: 'per_unit', amountMinor: 25 },
        values: [],
      },
      {
        key: 'drop_cm',
        label: 'Drop (cm)',
        presentation: 'number_field',
        isRequired: true,
        isEnabled: true,
        sortOrder: at(1),
        helpText: 'Between 20 cm and 300 cm.',
        defaultValue: '150',
        validation: { min: 20, max: 300, integerOnly: true },
        pricing: { type: 'per_unit', amountMinor: 25 },
        values: [],
      },
      {
        key: 'lining',
        label: 'Lining',
        presentation: 'dropdown',
        isRequired: true,
        isEnabled: true,
        sortOrder: at(2),
        values: [
          {
            valueKey: 'unlined',
            label: 'Unlined',
            sortOrder: at(0),
            priceType: 'fixed',
            priceAmountMinor: 0,
            isDefault: true,
          },
          {
            valueKey: 'blackout',
            label: 'Blackout',
            sortOrder: at(1),
            priceType: 'percentage',
            priceAmountMinor: 0,
            /* A percentage, because lining scales with the size ordered. */
            priceConfig: { type: 'percentage', basisPoints: 1500 },
          },
        ],
      },
    ],
    items: [
      { kind: 'paragraph', content: 'Measure the recess, not the existing blind.', sortOrder: at(0) },
    ],
  },
];

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: 'tshirt',
    name: 'T-shirt printing',
    description: 'Size and colour, with a premium on larger sizes and richer dyes.',
    build: tshirt,
  },
  {
    id: 'engraving',
    name: 'Engraving',
    description: 'Text priced per character, with a free allowance and a length limit.',
    build: engraving,
  },
  {
    id: 'gift-wrap',
    name: 'Gift wrap',
    description: 'A priced wrapping choice and an optional message.',
    build: giftWrap,
  },
  {
    id: 'dimensions',
    name: 'Made-to-order dimensions',
    description: 'Width and drop priced by the centimetre, with a lining choice.',
    build: dimensions,
  },
];

/**
 * A template as the document the importer takes.
 *
 * 📌 **Built fresh each call**, because the importer receives it and a shared
 * object would let one merchant's edit reach another's template.
 */
export function templateDocument(template: StarterTemplate): PortableSet {
  return {
    version: PORTABLE_VERSION,
    name: template.name,
    groups: template.build(),
    rules: [],
  };
}
