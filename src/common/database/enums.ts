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
  /*
   * ✏️ **A seventh action was here and is withdrawn (ADR-056)**, alongside the
   * sixth below. It read as `hide`'s obvious opposite and was not: nothing is
   * hidden by default for it to reveal, and where something *is* hidden,
   * ADR-052 gives `hide` the win. Measured in all three evaluators — it changed
   * nothing in every path it could take.
   *
   * `hide X when NOT Y` says everything it said, using the operators' negative
   * forms. Its name is deliberately unquoted here: the vocabulary parity gate
   * reads this object by grepping for quoted values.
   */
  HIDE: 'hide',
  REQUIRE: 'require',
  UNREQUIRE: 'unrequire',
  SET_PRICE: 'set_price',
  /*
   * ✏️ **A sixth action was here and is withdrawn (ADR-055).**
   *
   * ⚠️ Its name is deliberately not spelled out below: `check-rule-vocabulary-parity.sh`
   * reads this object by grepping for quoted values, and a mention inside a
   * comment is indistinguishable from a member. Measured — the gate reported the
   * two repositories disagreeing because this note quoted the string.
   *
   * It was specified in M17.1, evaluated by all three engines, and applied by
   * nothing. Removing it rather than leaving it unbuilt, because the blocker is
   * a **decision** and not effort: a rule-set default pre-selects a value the
   * customer did not choose, and a value carries a price — which is the shape
   * ADR-051 §3 refuses for a re-shown field. Measured: a pre-selected 40.00
   * option is charged.
   *
   * An existing row degrades to a rule that does nothing, which is what it did
   * before — both evaluators ignore an action they do not know (AC4).
   */
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

/*
 * The operators grouped by the **shape of operand** each one takes.
 *
 * 🔴 **These are the single source, and the schema builds its unions from them.**
 * The first version of this file declared the sets and then the schema listed the
 * same operators again as literals — two copies of one truth, in the same commit
 * that added the constant meant to prevent exactly that. The PHP evaluator
 * (M17.2) needs the same partition, so a third copy was already queued.
 *
 * ⚠️ **Typed as tuples, not `readonly RuleOperator[]`.** `z.enum()` needs the
 * literal members to narrow, and a widened array makes every branch of the
 * condition union accept every operator — which would silently undo the
 * separation these sets exist to express.
 */

/**
 * The operators that take no operand.
 *
 * `is_empty` and `is_not_empty` ask about the answer alone. A schema accepting a
 * `value` alongside them would let a merchant save a condition half of which is
 * silently ignored — the `freeUnits: 5` shape Phase 16's audit found, where a
 * setting saved successfully and did nothing.
 */
export const UNARY_RULE_OPERATORS = [
  RuleOperator.IS_EMPTY,
  RuleOperator.IS_NOT_EMPTY,
] as const;

/**
 * The operators whose operand is a **list** rather than a single value.
 *
 * Separated for the same reason as the unary set: `in` with a scalar operand is
 * a merchant meaning `equals` and getting silence.
 */
export const LIST_RULE_OPERATORS = [RuleOperator.IN, RuleOperator.NOT_IN] as const;

/**
 * The operators that compare **magnitude**, and therefore need a number.
 *
 * 🔴 **There is no defined ordering for text, and inventing one is how two
 * languages begin to disagree.** Is `"Blue" > "apple"`? Byte order says yes,
 * case-insensitive alphabetical says no, and a locale-aware collation says it
 * depends on the locale. PHP's `>` on strings and JavaScript's are already
 * different functions.
 *
 * `option_delta()` gives this exact reasoning for refusing `fixed` at the option
 * level: *"inventing one independently in two languages is how they begin to
 * disagree"*. So the operand must be a number, and a merchant wanting "is this
 * text one of these" has `in`.
 */
export const ORDERING_RULE_OPERATORS = [
  RuleOperator.GREATER_THAN,
  RuleOperator.LESS_THAN,
] as const;

/**
 * The operator that asks whether one string occurs inside another.
 *
 * `contains 42` is a merchant asking a question about text using a number. It
 * has an obvious-looking answer — stringify and search — and that is the trap:
 * `contains 1` would match the answer `"10"`, and `contains false` would match
 * the engraving `"falsely modest"`. A string operand says what was meant.
 */
export const SUBSTRING_RULE_OPERATORS = [RuleOperator.CONTAINS] as const;

/**
 * The operators that compare for **equality**, whatever the answer's type.
 *
 * Equality is the one comparison that is well defined across strings, numbers
 * and booleans in both languages, so these keep a permissive operand.
 */
export const EQUALITY_RULE_OPERATORS = [
  RuleOperator.EQUALS,
  RuleOperator.NOT_EQUALS,
] as const;

/**
 * Every operator taking exactly one operand.
 *
 * Retained as a named set because the *arity* split (one operand, a list, none)
 * is a different question from the *type* split above, and the rule builder
 * (M17.6) needs the first to decide how many inputs to draw.
 */
export const BINARY_RULE_OPERATORS = [
  ...EQUALITY_RULE_OPERATORS,
  ...SUBSTRING_RULE_OPERATORS,
  ...ORDERING_RULE_OPERATORS,
] as const;

/* -------------------------------------------------------------------------
 * Assignment
 * ---------------------------------------------------------------------- */

/**
 * Why an address is suppressed, and therefore whether it may still be mailed.
 *
 * 🔴 **The distinction is load-bearing, and `MailService` did not draw it.**
 * Every mail was refused for a suppressed address, transactional included — so a
 * merchant who opted out of onboarding email would also stop receiving **password
 * resets and verification links**, locking themselves out of their own account by
 * clicking unsubscribe in a marketing message.
 *
 * `HARD_BOUNCE` and `COMPLAINT` are facts about **deliverability**: the address
 * does not work, or the provider has been told this sender is spam. Mailing
 * either degrades delivery for every merchant who *is* reachable, so nothing may
 * be sent — a password reset included, because it would not arrive anyway.
 *
 * `UNSUBSCRIBE` is a preference about **content**. The address works and its
 * owner is happy to hear from us about their own account; they do not want
 * onboarding nudges. See `MailKind`.
 */
export const SuppressionReason = {
  HARD_BOUNCE: 'hard_bounce',
  COMPLAINT: 'complaint',
  UNSUBSCRIBE: 'unsubscribe',
  MANUAL: 'manual',
} as const;
export type SuppressionReason = (typeof SuppressionReason)[keyof typeof SuppressionReason];

/**
 * What a message is for, which decides whether an unsubscribe silences it.
 *
 * ⚠️ **Declared per message rather than inferred from the template name.** A
 * rule that pattern-matched `nudge-*` would silence a transactional mail the day
 * someone named one badly, and the failure would be a merchant unable to reset
 * their password — invisible until they complained.
 */
export const MailKind = {
  /**
   * Something the merchant asked for, or needs to use their account: verifying
   * an address, resetting a password, being told their password changed.
   *
   * **Never silenced by an unsubscribe**, only by undeliverability.
   */
  TRANSACTIONAL: 'transactional',

  /**
   * Onboarding nudges and anything else the merchant did not ask for
   * ([M20b.6](../../../developePlan.md)). Silenced by an unsubscribe.
   */
  LIFECYCLE: 'lifecycle',
} as const;
export type MailKind = (typeof MailKind)[keyof typeof MailKind];

/**
 * The templates allowed to call themselves transactional.
 *
 * 🔴 **`kind` is declared per call site, and nothing stopped a nudge claiming
 * `TRANSACTIONAL`** — which would make it ignore unsubscribes entirely, the exact
 * inverse of the defect `MailKind` was introduced to fix. Today all three
 * transactional mails are genuinely transactional, so the protection rested
 * entirely on a reviewer noticing.
 *
 * ⚠️ **An allow-list, not a naming convention.** A rule that pattern-matched
 * `nudge-*` would silence a real transactional mail the day someone named one
 * badly, and the failure would be a merchant unable to reset their password.
 * Naming a template here is a decision someone makes deliberately; forgetting to
 * is a loud error rather than a silent one.
 *
 * A message is transactional when the merchant **needs it to use their account**
 * — not when it is merely important. Onboarding, tips and announcements are
 * `LIFECYCLE` however urgent they feel.
 */
export const TRANSACTIONAL_TEMPLATES: readonly string[] = [
  'verify-email',
  'password-reset',
  'password-changed',
];

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
