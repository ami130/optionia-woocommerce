/**
 * The two projections of the option model (M7.2b).
 *
 * One canonical serializer produces both, so no two surfaces can disagree about
 * what an option is: the dashboard editor, the live preview, the store config,
 * the pricing evaluator and validation all read the same shapes.
 *
 * ## Why two, and only two
 *
 * **Authoring** is what a merchant edits: drafts, internal ids, audit fields,
 * everything. **Published** is the config document the plugin consumes — no
 * drafts, no tenant data, money as integer minor units.
 *
 * A field appears in the published projection only if the plugin genuinely
 * needs it. The config document sits on merchant servers and is public-ish
 * data, so anything unnecessary is needless exposure.
 *
 * ## Why the shapes differ in case
 *
 * Authoring is `camelCase` because it is consumed by the dashboard, which is
 * TypeScript. Published is `snake_case` because it is consumed by a WordPress
 * plugin, and PHP convention is snake_case — the config contract (M7.5) fixes
 * that shape and the plugin already ships a reader for it.
 */

/* -------------------------------------------------------------------------
 * Authoring — the dashboard's view
 * ---------------------------------------------------------------------- */

export interface AuthoringOptionValue {
  readonly id: string;
  readonly valueKey: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly priceType: string;
  readonly priceAmountMinor: number;
  readonly priceConfig: Record<string, unknown> | null;
  readonly imageUrl: string | null;
  readonly colorHex: string | null;
  readonly skuSuffix: string | null;
  readonly weightDeltaGrams: number | null;
  readonly isDefault: boolean;
  readonly isEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthoringOption {
  readonly id: string;
  readonly key: string;
  readonly valueKind: string;
  readonly cardinality: string;
  readonly presentation: string;
  readonly label: string;
  readonly description: string | null;
  readonly placeholder: string | null;
  readonly helpText: string | null;
  readonly isRequired: boolean;
  readonly isEnabled: boolean;
  readonly sortOrder: number;
  readonly defaultValue: string | null;
  readonly validation: Record<string, unknown> | null;
  readonly pricing: Record<string, unknown> | null;
  readonly display: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly values: readonly AuthoringOptionValue[];
}

/**
 * ⚠️ No `isEnabled`. `presentational_items` is the one authorable table without
 * the enable/disable toggle 7c added to groups, options and values — a known gap
 * deferred to Phase 14. It is absent here rather than defaulted to `true`,
 * because inventing a field the table cannot store would make this projection
 * lie about what a merchant can control.
 */
export interface AuthoringPresentationalItem {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly sortOrder: number;
  readonly display: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthoringGroup {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly displayType: string;
  readonly sortOrder: number;
  readonly isCollapsible: boolean;
  readonly isEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly options: readonly AuthoringOption[];
  readonly items: readonly AuthoringPresentationalItem[];
}

export interface AuthoringOptionSet {
  readonly id: string;
  readonly storeId: string;
  readonly name: string;
  readonly status: string;
  readonly version: number;
  /** The optimistic lock a client echoes back on a write ([7j]). */
  readonly rowVersion: number;
  readonly publishedAt: string | null;
  readonly publishedConfigVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly groups: readonly AuthoringGroup[];
}

/* -------------------------------------------------------------------------
 * Published — the config document the plugin reads (M7.5)
 * ---------------------------------------------------------------------- */

export interface PublishedValue {
  readonly value_key: string;
  readonly label: string;
  readonly sort_order: number;
  readonly price_config: Record<string, unknown>;
  readonly image_url?: string;
  readonly color_hex?: string;
  readonly sku_suffix?: string;
  readonly weight_delta_grams?: number;
  readonly is_default?: true;
}

export interface PublishedOption {
  readonly id: string;
  readonly key: string;
  readonly type: string;
  readonly value_kind: string;
  readonly cardinality: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly help_text?: string;
  readonly is_required: boolean;
  readonly sort_order: number;
  readonly default_value?: string;
  readonly validation?: Record<string, unknown>;
  readonly pricing?: Record<string, unknown>;
  readonly display?: Record<string, unknown>;
  readonly values: readonly PublishedValue[];
}

export interface PublishedItem {
  readonly kind: string;
  readonly content: string;
  readonly sort_order: number;
  readonly display?: Record<string, unknown>;
}

export interface PublishedGroup {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly display_type: string;
  readonly sort_order: number;
  readonly is_collapsible: boolean;
  readonly options: readonly PublishedOption[];
  readonly items: readonly PublishedItem[];
}

export interface PublishedOptionSet {
  readonly id: string;
  readonly version: number;
  readonly groups: readonly PublishedGroup[];
}
