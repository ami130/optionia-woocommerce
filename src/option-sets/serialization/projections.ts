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
  /** `<optgroup>` heading. `null` means the value is not grouped. */
  readonly groupLabel: string | null;
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
  /**
   * Who published, as a user id.
   *
   * The editor shows "published by X at Y" and had only the timestamp. It stays
   * out of the **published** projection — the plugin has no use for a user id,
   * and a storefront document naming a merchant's staff is needless exposure.
   */
  readonly publishedBy: string | null;
  readonly publishedConfigVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly groups: readonly AuthoringGroup[];
  /**
   * The set's conditional rules, for the rule builder (M17.6).
   *
   * ✏️ **The tree loaded these from M17.5 and this projection discarded them** —
   * a fifth query on every dashboard render whose result was thrown away, while
   * the plan recorded that the authoring view carried them. Both halves were
   * wrong, in opposite directions.
   *
   * ⚠️ **camelCase, and it keeps `isEnabled` and `disabledReason`** — the
   * opposite of the published projection, deliberately. A merchant needs to see
   * a rule the cascade switched off *and why*; a storefront never receives one
   * at all, so the flag has nothing to say there.
   */
  readonly rules: readonly AuthoringRule[];
}

/**
 * One rule, as the editor sees it.
 *
 * `conditions` and `actionValue` are passed through as stored: the dashboard
 * authored them in this shape and reads them back in it. The **published**
 * projection is where they are rewritten for a PHP reader, and doing it in one
 * place is what stops the two conventions leaking into each other.
 */
export interface AuthoringRule {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly action: string;
  readonly matchType: string;
  readonly conditions: readonly unknown[];
  readonly actionValue: Record<string, unknown> | null;
  readonly sortOrder: number;
  readonly isEnabled: boolean;
  /** Why the *system* switched it off, or null when the merchant did. */
  readonly disabledReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  /** `<optgroup>` heading. Absent when the value is not grouped. */
  readonly group_label?: string;
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

/**
 * Where a set applies, in the document's shape (M7.5).
 *
 * Assignment CRUD is Phase 13, so this is always empty today. It is **present
 * and empty rather than absent**, because 7k freezes this document for v1 and a
 * plugin written against a shape without the key would need a `schema_version`
 * bump to gain it. An empty array is a shape a reader can handle from the first
 * release; a missing key is one it has to learn.
 */
export interface PublishedAssignment {
  /**
   * How the set is assigned: `all`, `manual` or `conditional`.
   *
   * **Without this the shape cannot express its own data.** An `ALL` assignment
   * has no target — it applies to every product in the store — so `target_type`
   * and `target_ref` are meaningless for it, and a reader given only those two
   * fields cannot tell "applies to everything" from "applies to nothing". A
   * storefront index built on that distinction would be wrong in the most
   * common case a merchant configures.
   *
   * Added in Phase 9 rather than Phase 13, deliberately. Assignment CRUD lands
   * in Phase 13 and the index that consumes this in Phase 10, so the gap would
   * not have surfaced until something was already being built against the wrong
   * shape. Additive keys do not bump `schema_version` — a reader that ignores
   * one it does not know is unaffected — which is the same reasoning that put
   * `assignments` in the envelope before anything filled it.
   */
  readonly mode: string;

  /**
   * What the set is assigned to, when it is assigned to something.
   *
   * Null for `all`, which has no target. One of `product`, `category`, `tag`,
   * `attribute` or `price_range` otherwise.
   */
  readonly target_type: string | null;

  /** The id, slug or range expression `target_type` names. Null for `all`. */
  readonly target_ref: string | null;

  /** Resolution order when a product matches several sets. */
  readonly priority: number;
}

/**
 * Conditional rules, in the document's shape (M7.5).
 *
 * The evaluation engine is Phase 17 and rule CRUD with it, so this is always
 * empty today — and present for the same reason as `assignments`.
 */
export interface PublishedRule {
  readonly id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly action: string;
  readonly match_type: string;
  /**
   * What the action acts **with** — `{ amount_minor }` for `set_price`,
   * `{ value_key }` for `set_default`, and **absent** for the four that act on
   * their own (M17.4).
   *
   * ✏️ **Missing until M17.5.** M17.4 gave `OptionRule` the column because three
   * of six actions could not otherwise be expressed, and it reached the entity,
   * the DTOs, the service and the evaluator — and stopped short of the wire. A
   * merchant could author "set price to 5.00", have it validate, store and
   * publish, and the document the plugin received could not carry the amount.
   *
   * Optional rather than nullable: a key always present and usually null teaches
   * a reader to ignore it.
   */
  readonly action_value?: Record<string, unknown>;
  readonly conditions: readonly Record<string, unknown>[];
  readonly sort_order: number;
}

export interface PublishedOptionSet {
  readonly id: string;
  readonly version: number;
  readonly assignments: readonly PublishedAssignment[];
  readonly groups: readonly PublishedGroup[];
  readonly rules: readonly PublishedRule[];
}

/**
 * The config document a storefront fetches (M7.5).
 *
 * **The single most important interface in the system.** It is read by a
 * WordPress plugin that cannot be redeployed across thousands of merchant sites,
 * so its shape is frozen at `schema_version: 1` and documented in
 * `docs/CONFIG-CONTRACT.md`.
 *
 * Assembled from **published snapshots**, never from live rows: the live rows
 * are the merchant's working draft, and a document built from them would ship
 * edits nobody published.
 */
export interface ConfigDocument {
  /**
   * The document's shape, not its content.
   *
   * Separate from `config_version` so a plugin too old to understand a document
   * can refuse it and keep its last good copy — which the shipped plugin
   * already does. Bumped only for a breaking change to this shape.
   */
  readonly schema_version: number;

  /** The store's content revision. Advances on every publish and rollback. */
  readonly config_version: number;

  readonly store_id: string;

  /** When this document was assembled, not when it was published. */
  readonly generated_at: string;

  readonly option_sets: readonly PublishedOptionSet[];
}
