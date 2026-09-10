/**
 * Enumerated values stored as `VARCHAR`, not MySQL `ENUM`.
 *
 * Adding a value to a MySQL `ENUM` is an `ALTER TABLE` on a live table — which
 * for `option_values.price_type` would mean a schema migration every time a
 * pricing model is added. `VARCHAR` plus application validation moves that cost
 * to a deploy, and the database is not the right place to enforce a product
 * decision that changes with the roadmap.
 *
 * Declared as const objects rather than TypeScript `enum`, so the values are
 * plain strings at runtime and can be compared against database rows without
 * conversion.
 */

/* -------------------------------------------------------------------------
 * Tenancy
 * ---------------------------------------------------------------------- */

export const TenantStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

/**
 * Tenant roles. See M6.5 for the capability matrix.
 *
 * The distinction that matters: `editor` can build option sets but cannot
 * publish. Editing is safe; publishing changes a live storefront and what
 * customers are charged, so an agency contractor should be able to do the first
 * without the second.
 */
export const TenantRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  EDITOR: 'editor',
  VIEWER: 'viewer',
  BILLING: 'billing',
} as const;
export type TenantRole = (typeof TenantRole)[keyof typeof TenantRole];

/**
 * Platform staff roles — a separate realm from tenant roles.
 *
 * Stored in their own table so no row shape can express "merchant who is also
 * super_admin". Note that **no** platform role may edit merchant configuration:
 * staff diagnose and advise, and a genuine change goes through consented,
 * audit-logged impersonation.
 */
export const StaffRole = {
  SUPER_ADMIN: 'super_admin',
  SUPPORT: 'support',
  BILLING_OPS: 'billing_ops',
  READ_ONLY: 'read_only',
} as const;
export type StaffRole = (typeof StaffRole)[keyof typeof StaffRole];

/* -------------------------------------------------------------------------
 * Stores
 * ---------------------------------------------------------------------- */

export const StorePlatform = {
  WOOCOMMERCE: 'woocommerce',
  SHOPIFY: 'shopify',
} as const;
export type StorePlatform = (typeof StorePlatform)[keyof typeof StorePlatform];

/**
 * Connection state machine. See M8.1b.
 *
 * `ERROR` and `REVOKED` never stop a storefront — the plugin keeps serving its
 * cached configuration. They mean new configuration cannot be published, not
 * that selling stops.
 */
export const StoreStatus = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
  REVOKED: 'revoked',
} as const;
export type StoreStatus = (typeof StoreStatus)[keyof typeof StoreStatus];

/* -------------------------------------------------------------------------
 * Option domain
 * ---------------------------------------------------------------------- */

export const OptionSetStatus = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
} as const;
export type OptionSetStatus = (typeof OptionSetStatus)[keyof typeof OptionSetStatus];

/**
 * What sort of value an option produces.
 *
 * One of three orthogonal axes — see M5.4b. Modelling type as a single enum
 * would make a single-select and a multi-select colour swatch two separate
 * types, duplicating the renderer, validator and pricing path.
 */
export const ValueKind = {
  NONE: 'none',
  TEXT: 'text',
  NUMBER: 'number',
  DATE: 'date',
  FILE: 'file',
  CHOICE: 'choice',
} as const;
export type ValueKind = (typeof ValueKind)[keyof typeof ValueKind];

/** How many values may be selected. Only meaningful for `choice` kinds. */
export const Cardinality = {
  NONE: 'none',
  ONE: 'one',
  MANY: 'many',
} as const;
export type Cardinality = (typeof Cardinality)[keyof typeof Cardinality];

/** How an option is drawn. Independent of kind and cardinality. */
export const Presentation = {
  TEXT_FIELD: 'text_field',
  TEXTAREA: 'textarea',
  NUMBER_FIELD: 'number_field',
  DATE_PICKER: 'date_picker',
  TIME_PICKER: 'time_picker',
  DATETIME_PICKER: 'datetime_picker',
  FILE_INPUT: 'file_input',
  RADIO: 'radio',
  DROPDOWN: 'dropdown',
  CHECKBOX: 'checkbox',
  COLOR_SWATCH: 'color_swatch',
  IMAGE_SWATCH: 'image_swatch',
  RANGE: 'range',
  QUANTITY: 'quantity',
  HIDDEN: 'hidden',
} as const;
export type Presentation = (typeof Presentation)[keyof typeof Presentation];

export const GroupDisplayType = {
  INLINE: 'inline',
  ACCORDION: 'accordion',
  TABS: 'tabs',
  STEPPED: 'stepped',
} as const;
export type GroupDisplayType = (typeof GroupDisplayType)[keyof typeof GroupDisplayType];

/**
 * Presentational item kinds.
 *
 * These are not options: no value, no validation, no pricing, no cart data.
 * `RICH_TEXT` is merchant-authored markup rendered on a public storefront, so it
 * is sanitised at publish and at render, and plan-gated.
 */
export const PresentationalKind = {
  HEADING: 'heading',
  PARAGRAPH: 'paragraph',
  DIVIDER: 'divider',
  RICH_TEXT: 'rich_text',
} as const;
export type PresentationalKind =
  (typeof PresentationalKind)[keyof typeof PresentationalKind];

/* -------------------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------------------- */

export const RuleTargetType = {
  OPTION: 'option',
  GROUP: 'group',
  VALUE: 'value',
} as const;
export type RuleTargetType = (typeof RuleTargetType)[keyof typeof RuleTargetType];

/**
 * Why the system disabled a rule.
 *
 * `null` means the merchant disabled it themselves. Stored rather than derived
 * because the target is already gone by the time anyone asks, so the reason
 * cannot be reconstructed from the rule alone.
 */
export const RuleDisabledReason = {
  /** The group, option or value the rule targets was deleted. */
  TARGET_DELETED: 'target_deleted',
} as const;
export type RuleDisabledReason =
  (typeof RuleDisabledReason)[keyof typeof RuleDisabledReason];

export const RuleAction = {
  SHOW: 'show',
  HIDE: 'hide',
  REQUIRE: 'require',
  UNREQUIRE: 'unrequire',
  SET_PRICE: 'set_price',
  SET_DEFAULT: 'set_default',
} as const;
export type RuleAction = (typeof RuleAction)[keyof typeof RuleAction];

export const RuleMatchType = {
  ALL: 'all',
  ANY: 'any',
} as const;
export type RuleMatchType = (typeof RuleMatchType)[keyof typeof RuleMatchType];

/**
 * How one condition compares an option's answer against the merchant's operand.
 *
 * The nine M17.1 names. Stored as strings rather than symbols so the published
 * document reads as English — a plugin author debugging a rule sees
 * `greater_than`, not `gt`.
 *
 * ⚠️ **Comparison semantics belong to the evaluator, not to this list.**
 * `GREATER_THAN` on a number field compares numbers; on a text field there is no
 * defined ordering, and inventing one independently in two languages is how they
 * begin to disagree — the reasoning `option_delta()` already gives for refusing
 * `fixed` at the option level. Which operators are legal against which option
 * type is a schema question (M17.1) and a fixture question (M17.2), settled in
 * one place each.
 */
export const RuleOperator = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  CONTAINS: 'contains',
  GREATER_THAN: 'greater_than',
  LESS_THAN: 'less_than',
  IS_EMPTY: 'is_empty',
  IS_NOT_EMPTY: 'is_not_empty',
  IN: 'in',
  NOT_IN: 'not_in',
} as const;
export type RuleOperator = (typeof RuleOperator)[keyof typeof RuleOperator];

/**
 * The operators that take no operand.
 *
 * `is_empty` and `is_not_empty` ask about the answer alone. A schema accepting a
 * `value` alongside them would let a merchant save a condition half of which is
 * silently ignored — the `freeUnits: 5` shape Phase 16's audit found, where a
 * setting saved successfully and did nothing.
 */
export const UNARY_RULE_OPERATORS: readonly RuleOperator[] = [
  RuleOperator.IS_EMPTY,
  RuleOperator.IS_NOT_EMPTY,
];

/**
 * The operators whose operand is a **list** rather than a single value.
 *
 * Separated for the same reason as the unary set: `in` with a scalar operand is
 * a merchant meaning `equals` and getting silence.
 */
export const LIST_RULE_OPERATORS: readonly RuleOperator[] = [
  RuleOperator.IN,
  RuleOperator.NOT_IN,
];

/* -------------------------------------------------------------------------
 * Assignment
 * ---------------------------------------------------------------------- */

/**
 * How an option set reaches products.
 *
 * `CONDITIONAL` is materially different from `MANUAL`: a product created next
 * month that matches the rule inherits the set with no merchant action, whereas
 * a manual list silently goes stale.
 */
export const AssignmentMode = {
  ALL: 'all',
  MANUAL: 'manual',
  CONDITIONAL: 'conditional',
} as const;
export type AssignmentMode = (typeof AssignmentMode)[keyof typeof AssignmentMode];

export const AssignmentTargetType = {
  PRODUCT: 'product',
  CATEGORY: 'category',
  TAG: 'tag',
  ATTRIBUTE: 'attribute',
  PRICE_RANGE: 'price_range',
} as const;
export type AssignmentTargetType =
  (typeof AssignmentTargetType)[keyof typeof AssignmentTargetType];

/* -------------------------------------------------------------------------
 * Pricing
 * ---------------------------------------------------------------------- */

export const PriceType = {
  FIXED: 'fixed',
  PERCENTAGE: 'percentage',
  PER_UNIT: 'per_unit',
  PER_CHAR: 'per_char',
  TIERED: 'tiered',
} as const;
export type PriceType = (typeof PriceType)[keyof typeof PriceType];

/* -------------------------------------------------------------------------
 * Billing
 * ---------------------------------------------------------------------- */

export const SubscriptionStatus = {
  TRIALING: 'trialing',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  GRACE: 'grace',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const;
export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/* -------------------------------------------------------------------------
 * Operational
 * ---------------------------------------------------------------------- */

export const WebhookDirection = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
} as const;
export type WebhookDirection = (typeof WebhookDirection)[keyof typeof WebhookDirection];

export const DeliveryStatus = {
  PENDING: 'pending',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  ABANDONED: 'abandoned',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const JobStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];
