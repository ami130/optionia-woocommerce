/**
 * The billing intervals this product sells, named once.
 *
 * 🔴 **WooCommerce is YEARLY ONLY, and that is a product decision, not a
 * limitation.** The Shopify app sells monthly and yearly; this one sells yearly.
 * Both read from the same `plan_prices` table, whose row-per-interval shape
 * supports either — so nothing here is a schema change, only a decision about
 * which rows a merchant may buy.
 *
 * ⚠️ **`month` is still a legal STORED value, and deliberately so.** Rows may
 * exist from an earlier seed, and a subscription already pinned to one must keep
 * resolving — a merchant's invoice history cannot be rewritten by a change in
 * what we sell today. What changes is what may be *bought*: {@link SELLABLE_INTERVALS}
 * is the gate, and {@link isSellableInterval} is the one function that answers it.
 *
 * 📌 **Three spellings collapsed into one.** Before this, `'month' | 'year'`
 * appeared as an `@ApiProperty` enum, an `@IsIn` validator and a hand-written
 * `if` in `plans-admin.service.ts` — three copies held together by nothing,
 * which is the same defect class as the Design Lab's `1.25` line-height. A
 * fourth spelling would have been the one that disagreed.
 */

/**
 * Every interval that may appear in `plan_prices.interval`.
 *
 * ⚠️ Includes `month` because historical rows and pinned subscriptions carry it.
 * This is the READ vocabulary, not the SELL vocabulary.
 */
export const BILLING_INTERVALS = ['month', 'year'] as const;

/**
 * 📌 `typeof [...][number]` rather than a hand-written union, so adding a value
 * to the array and forgetting the type is a compile error instead of a runtime
 * surprise.
 */
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/**
 * The intervals a merchant may actually subscribe to on WooCommerce.
 *
 * 🔴 **This is the yearly-only decision, expressed once.** Every refusal —
 * checkout, plan change, admin price creation — reads this array rather than
 * spelling the rule again.
 */
export const SELLABLE_INTERVALS = ['year'] as const satisfies readonly BillingInterval[];

export type SellableInterval = (typeof SELLABLE_INTERVALS)[number];

/** Whether `value` is an interval this system recognises at all (read side). */
export function isBillingInterval(value: unknown): value is BillingInterval {
  return (
    typeof value === 'string' &&
    (BILLING_INTERVALS as readonly string[]).includes(value)
  );
}

/**
 * Whether `value` is an interval a merchant may buy (sell side).
 *
 * 🔴 **The one gate.** A price row that fails this may still be read, reported
 * and pinned to an existing subscription; it may not be sold.
 */
export function isSellableInterval(value: unknown): value is SellableInterval {
  return (
    typeof value === 'string' &&
    (SELLABLE_INTERVALS as readonly string[]).includes(value)
  );
}

/**
 * The single interval a new subscription is created at.
 *
 * ⚠️ **Derived from {@link SELLABLE_INTERVALS}, never written out again.** If
 * this product ever sells a second interval, the assertion below fails at
 * startup rather than this constant quietly meaning something different from the
 * array it claims to summarise.
 */
export const DEFAULT_SELLABLE_INTERVAL: SellableInterval = SELLABLE_INTERVALS[0];

/**
 * 🔴 **A compile-time assertion that "the default" is unambiguous.** With more
 * than one sellable interval, "the" interval a tenant is provisioned at stops
 * being a well-defined idea, and every caller of
 * {@link DEFAULT_SELLABLE_INTERVAL} would need to choose instead. This makes
 * that a build failure, not a judgement call made silently at each call site.
 */
type _AssertSingleSellableInterval = typeof SELLABLE_INTERVALS extends
  readonly [SellableInterval]
  ? true
  : ['MORE THAN ONE SELLABLE INTERVAL — DEFAULT_SELLABLE_INTERVAL is now ambiguous'];
const _assertSingleSellableInterval: _AssertSingleSellableInterval = true;
void _assertSingleSellableInterval;
