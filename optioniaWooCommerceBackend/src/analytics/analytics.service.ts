import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';

/** One option, and what it earned (M25.3). */
export interface OptionRevenue {
  readonly optionKey: string;
  /** The most recent label a customer saw for this key — see the F152 note. */
  readonly label: string;
  readonly revenueMinor: number;
  /** How many order lines named this option. */
  readonly orders: number;
}

/** One chosen value, and how often it was chosen (M25.3). */
export interface ValueRevenue {
  readonly optionKey: string;
  readonly valueKey: string;
  readonly label: string;
  readonly revenueMinor: number;
  readonly orders: number;
}

/**
 * An option a merchant is paying to maintain that nobody picks (M25.3).
 *
 * 🔴 **Not derivable from `order_selections`.** A dead option is one with *zero*
 * selections, so it is absent from the order tables by construction — this comes
 * from live configuration with a `NOT EXISTS` against the orders.
 */
export interface DeadOption {
  readonly optionSetId: string;
  readonly optionSetName: string;
  readonly optionKey: string;
  readonly label: string;
}

/**
 * How many orders carried options at all, and what they were worth (M25.3).
 *
 * ## What this is NOT
 *
 * 🔴 **This is not "conversion with vs. without options", and that clause of
 * M25.3 cannot be answered from any data this system holds** (F157). Conversion
 * needs a denominator of *visits* — of the customers who saw a product, what
 * fraction bought — and nothing records a view. `order_events` contains only
 * orders that completed.
 *
 * 📌 **`averageOrderValue…` is the honest substitute.** *"Orders using options
 * are worth 47.00 on average against 31.00 without"* is a real, defensible
 * sentence from data already present, and it answers the question the
 * conversion clause was reaching for — is it worth offering options — without
 * claiming a measurement nobody took.
 *
 * ⚠️ **The true conversion figure is owned by M25.1's view events**, which are
 * deferred. That deferral is therefore not free, and the Phase 25 section says
 * so rather than leaving it to be discovered at exit-criteria time.
 */
/**
 * What one option set earned (M25.3, F150).
 *
 * ⚠️ **A set's figure is "what we can attribute", never "what it earned".**
 * Orders placed before the plugin sent a per-option set id carry none, and
 * nothing can backfill them — the older per-line meta is a flat list of the sets
 * a line touched and cannot say which option belongs to which. A merchant
 * comparing two sets needs to know that one of them predates the data, which is
 * why `unattributedSelections` travels beside this.
 */
export interface OptionSetRevenue {
  readonly optionSetId: string;
  readonly name: string;
  readonly revenueMinor: number;
  /** Order lines naming an option from this set. */
  readonly orders: number;
}

export interface AttachRate {
  readonly orders: number;
  readonly ordersWithOptions: number;
  /** 0–1, or `null` when there are no orders to divide by. */
  readonly rate: number | null;
  readonly optionRevenueMinor: number;
  readonly totalRevenueMinor: number;
  /**
   * Mean order total for orders that used options, in minor units.
   *
   * `null` when there are none — an average of nothing is not zero, and showing
   * 0.00 would read as "options earn nothing" rather than "no data yet".
   */
  readonly averageOrderValueWithOptionsMinor: number | null;
  /** Mean order total for orders that used none. `null` when there are none. */
  readonly averageOrderValueWithoutOptionsMinor: number | null;
}

/**
 * A capped list, and how much of the truth it represents.
 *
 * 🔴 **A cap that is not reported is a wrong answer that looks right** (F156).
 * Fifty rows and "that is everything" are indistinguishable without `total`, so
 * a merchant with two hundred option values would read the top fifty as their
 * whole catalogue — and "least selected" would be a list of things that are not
 * least selected.
 */
/**
 * The same figures over two equal, adjacent windows (M25.4).
 *
 * ## Why a fixed comparison rather than a date picker
 *
 * 🔴 **M25.4 says "comparisons over time", and the roadmap's rule for this phase
 * is *"answer real merchant decisions … not vanity charts"*.** A date picker is a
 * tool for exploring; a merchant still has to choose two ranges and do the
 * subtraction themselves. The decision they actually face is *"is this working
 * better than it was?"*, and that is one number.
 *
 * ⚠️ **The windows are equal in LENGTH and adjacent in time**, because anything
 * else compares quantities that are not comparable: thirty days against seven
 * would show a fall that is an artefact of the window, not of the shop.
 *
 * 📌 **`previous` is `null` when the shop has no history that far back**, and
 * that is different from a previous window that earned nothing. A merchant
 * whose first order was last week has no "before" to compare against, and
 * showing them −100% would be a fact about their tenure, not their options.
 */
export interface RevenueTrend {
  /** How many days each window covers. */
  readonly windowDays: number;
  /** Option revenue in the window ending now, in minor units. */
  readonly currentMinor: number;
  /**
   * Option revenue in the window immediately before it, or `null` when no
   * order exists that early — "no history" is not "earned nothing".
   */
  readonly previousMinor: number | null;
  /** Orders carrying options in the current window. */
  readonly currentOrders: number;
  /** The same for the previous window, `null` under the same rule as above. */
  readonly previousOrders: number | null;
  /**
   * The change as a fraction (`0.25` is +25%), or `null` when it cannot be
   * stated.
   *
   * 🔴 **`null` when the previous window earned ZERO, not just when it is
   * absent.** Growth from nothing is division by zero; reporting it as
   * "+100%" or "+∞%" would be a number the data does not contain. The screen
   * says "no earnings to compare against" instead.
   */
  readonly changeFraction: number | null;
}

/**
 * What options earned on one product (M25.4, F151).
 *
 * 🔴 **`productRef` is the merchant's own WordPress id**, not ours — an
 * auto-increment integer, or a *variation* id for a variable product. It is
 * unique only **within a store**, which is why the name join is scoped by
 * `storeId` and not by `externalId` alone.
 *
 * ⚠️ **`name` is null when the catalogue has never been synced**, or when the
 * merchant deleted the product after the order. The id is still shown, because
 * a row that vanishes when a product is deleted would quietly understate what
 * the merchant earned.
 */
export interface ProductRevenue {
  readonly productRef: string;
  /** The product's name, or `null` when this store has no record of it. */
  readonly name: string | null;
  readonly revenueMinor: number;
  readonly orders: number;
}

/**
 * Of the customers who SAW an option, how many bought (M25.1, M25.3).
 *
 * 🔴 **The clause F157 recorded as unanswerable, now answerable.** Conversion
 * needs a denominator of views, and until M25.1 nothing recorded one — so the
 * screen shipped average order value as the honest substitute and never used the
 * word *conversion*. Views exist now, and this is the figure the milestone asked
 * for.
 *
 * ⚠️ **`rate` is null until views accumulate, and that is NOT zero.** A store
 * whose plugin predates M25.1 has orders and no views; dividing by nothing would
 * report either infinity or a silent zero, and both would read as a fact about
 * the shop rather than about the measurement.
 *
 * 📌 **Counted per option, not per order.** A page shows several options and a
 * customer may buy having chosen one — so "views" is how many times an option was
 * displayed, and "orders" is how many carried it. The two are commensurable
 * because both are per option.
 */
export interface OptionConversion {
  readonly optionKey: string;
  readonly label: string;
  readonly views: number;
  readonly orders: number;
  /** 0–1, or `null` when this option has no recorded views to divide by. */
  readonly rate: number | null;
}

export interface Capped<T> {
  readonly rows: T[];
  /** How many rows exist in total, before the cap. */
  readonly total: number;
  /** Whether `rows` is a subset. `total > rows.length`, stated rather than derived. */
  readonly truncated: boolean;
}

/** Everything the analytics screen renders in one call. */
export interface AnalyticsSummary {
  readonly attach: AttachRate;
  readonly topOptions: Capped<OptionRevenue>;
  /** Highest-earning values first. */
  readonly topValues: Capped<ValueRevenue>;
  /**
   * The least-chosen values, fewest orders first (M25.3).
   *
   * 🔴 **Not the tail of `topValues`.** That list is capped at the top, so its
   * last row is the fiftieth best — not the worst. M25.3 asks for *most AND
   * least* selected, and the second needs its own ordering.
   */
  readonly leastValues: Capped<ValueRevenue>;
  readonly deadOptions: Capped<DeadOption>;
  /**
   * Option revenue now against the window before it (M25.4).
   *
   * 🔴 **Every other figure here is all-time**, which cannot answer *"is this
   * better than it was?"* — the question a merchant asks after changing a price.
   */
  readonly trend: RevenueTrend;
  /**
   * What options earned on each product (M25.4, F151).
   *
   * ⚠️ **Empty until the plugin release that sends a product reference.** Older
   * orders carry a null and nothing can backfill them, so this table has its own
   * boundary date — `unattributedProductSelections` is what stops it reading as
   * complete.
   */
  /**
   * Of the customers who saw each option, how many bought (M25.1, M25.3).
   *
   * ⚠️ **Empty until a store runs the plugin release that sends views**, and an
   * entry with `rate: null` has orders and no views — a measurement gap rather
   * than a shop that never sells.
   */
  readonly conversion: Capped<OptionConversion>;
  readonly products: Capped<ProductRevenue>;
  /** Selections with no product reference, so the table above is not misread. */
  readonly unattributedProductSelections: number;
  /** Revenue per option set — M25.3's last clause (F150). */
  readonly optionSets: Capped<OptionSetRevenue>;
  /**
   * The currency every figure here is in, or `null` when it is not one currency.
   *
   * 🔴 **Minor units alone cannot be displayed.** `4700` is £47.00 or ¥4700
   * depending on the currency, and a dashboard guessing would misstate a
   * merchant's revenue by a factor of a hundred for a zero-decimal currency.
   *
   * ⚠️ **`null` when a tenant's orders span several currencies**, which two
   * stores in different countries produce. The totals here are sums of minor
   * units across those orders, so they are **not** a meaningful amount in any
   * single currency — and the honest answer is to say so rather than to pick
   * one and label the sum with it. A per-currency breakdown belongs with
   * M25.4's comparisons; this field is what stops the number being presented as
   * something it is not in the meantime.
   */
  readonly currency: string | null;
  /**
   * Selections carrying no set attribution.
   *
   * 🔴 **Reported rather than hidden.** These are orders from a plugin older
   * than F150, and their revenue is real but unattributable — a per-set total
   * presented without this number reads as complete when it is not.
   */
  readonly unattributedSelections: number;
}

/**
 * The most rows any one list returns.
 *
 * 📌 **A merchant reading a report does not scroll past fifty**, and an
 * unbounded `GROUP BY` over a year of orders is a response nobody renders. The
 * dead-option list is capped at the same figure for the same reason: a merchant
 * with two hundred unused options needs to know that, not to read all of them.
 */
const MAX_ROWS = 50;

/**
 * What a merchant's options actually earned (M25.3).
 *
 * ## Why this reads the order tables and never writes them
 *
 * 🔴 **`order_events` and `order_selections` are financial history.** They are
 * written once by the plugin's report and never revised — ADR-016 records that
 * an order is a fact and does not change because configuration later did. So
 * everything here is a read, and a rollup (M25.2) will read the same rows on a
 * schedule rather than this service caching anything.
 *
 * ## Why every query joins `stores`
 *
 * 🔴 **`order_selections` carries no tenant, and neither does `order_events`.**
 * Tenancy reaches them only through `order_events.storeId → stores.tenantId`, so
 * every query here must join `stores` to be scoped at all. That is a property
 * worth stating: a forgotten `WHERE` is a **join error**, not a silent
 * cross-tenant leak, because there is no tenant column to forget.
 *
 * ## Why revenue is not read from `optionRevenueMinor`
 *
 * ⚠️ **`order_events.optionRevenueMinor` is the line-level total; the per-option
 * split lives on `order_selections.priceDeltaMinor`.** Summing the former would
 * give a correct grand total that cannot be attributed to any option, which is
 * the one thing M25.3 asks for. The two are reconciled by construction: the
 * plugin computes the event total as the sum of the selection deltas.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Everything the screen needs, in one round trip per section. */
  async summary(tenantId: string): Promise<AnalyticsSummary> {
    const [
      attach,
      topOptions,
      topValues,
      leastValues,
      deadOptions,
      trend,
      conversion,
      products,
      unattributedProducts,
      optionSets,
      unattributed,
      currency,
    ] = await Promise.all([
        this.attachRate(tenantId),
        this.optionRevenue(tenantId),
        this.valueRevenue(tenantId, 'most'),
        this.valueRevenue(tenantId, 'least'),
        this.deadOptions(tenantId),
        this.revenueTrend(tenantId),
        this.optionConversion(tenantId),
        this.productRevenue(tenantId),
        this.unattributedProducts(tenantId),
        this.optionSetRevenue(tenantId),
        this.unattributedSelections(tenantId),
        this.currency(tenantId),
      ]);

    return {
      attach,
      topOptions,
      topValues,
      leastValues,
      deadOptions,
      trend,
      conversion,
      products,
      unattributedProductSelections: unattributedProducts,
      optionSets,
      unattributedSelections: unattributed,
      currency,
    };
  }

  /**
   * How many of this tenant's orders carried options at all.
   *
   * ✏️ **This needs no view events, and the Phase 25 deferral note first said it
   * did.** `OrderReporter::queue()` carries no options filter — every
   * `processing` and `completed` order is queued, and an order with none reports
   * with an empty selections array. So the denominator is already here.
   */
  async attachRate(tenantId: string): Promise<AttachRate> {
    const [row] = (await this.dataSource.query(
      `SELECT
         COUNT(*) AS orders,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM order_selections sel WHERE sel.orderEventId = e.id
         ) THEN 1 ELSE 0 END) AS ordersWithOptions,
         COALESCE(SUM(e.optionRevenueMinor), 0) AS optionRevenueMinor,
         COALESCE(SUM(e.orderTotalMinor), 0) AS totalRevenueMinor,
         AVG(CASE WHEN EXISTS (
           SELECT 1 FROM order_selections sel WHERE sel.orderEventId = e.id
         ) THEN e.orderTotalMinor END) AS aovWith,
         AVG(CASE WHEN NOT EXISTS (
           SELECT 1 FROM order_selections sel WHERE sel.orderEventId = e.id
         ) THEN e.orderTotalMinor END) AS aovWithout
       FROM order_events e
       JOIN stores s ON s.id = e.storeId
      WHERE s.tenantId = ?`,
      [tenantId],
    )) as {
      orders: number;
      ordersWithOptions: string | null;
      optionRevenueMinor: string | null;
      totalRevenueMinor: string | null;
      aovWith: string | null;
      aovWithout: string | null;
    }[];

    /*
     * ⚠️ **`COUNT(*)` arrives as a number and `SUM(...)` as a string.** The
     * mysql2 typing is not uniform, and F128 was measured proving it: reading a
     * SUM as a number yields string concatenation rather than arithmetic.
     */
    const orders = Number(row?.orders ?? 0);
    const ordersWithOptions = Number(row?.ordersWithOptions ?? 0);

    return {
      orders,
      ordersWithOptions,
      /* 🔴 `null`, never 0: a merchant with no orders has no attach rate, and
       * showing "0%" would read as a product failing rather than as no data. */
      rate: orders === 0 ? null : ordersWithOptions / orders,
      optionRevenueMinor: Number(row?.optionRevenueMinor ?? 0),
      totalRevenueMinor: Number(row?.totalRevenueMinor ?? 0),
      /*
       * 🔴 **`AVG` over a `CASE` with no `ELSE` skips the non-matching rows**
       * rather than counting them as zero, which is what makes these two
       * averages comparable. `SUM(...) / COUNT(*)` would divide each by the
       * whole population and understate both.
       *
       * ⚠️ **`null` when there is nothing to average, never 0.** An average of
       * no orders is not "these orders are worth nothing" — and a merchant who
       * has never sold without options must not read 0.00 as evidence that
       * options are what earns.
       */
      averageOrderValueWithOptionsMinor: this.averageOrNull(row?.aovWith),
      averageOrderValueWithoutOptionsMinor: this.averageOrNull(row?.aovWithout),
    };
  }

  /**
   * An average that is absent rather than zero when nothing matched.
   *
   * `AVG` returns SQL `NULL` over an empty set, which arrives here as `null`;
   * `Number(null)` is **0**, so the conversion has to happen after the check
   * and not before it.
   */
  private averageOrNull(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined) {
      return null;
    }

    return Math.round(Number(raw));
  }

  /**
   * Option revenue now against the window before it (M25.4).
   *
   * ## What this answers that nothing else does
   *
   * 🔴 **Every other figure on this screen is all-time**, and all-time cannot
   * answer *"is this better than it was?"*. A merchant who raised a price last
   * month sees the months before and after blended into one number, so the
   * change they made is invisible in the report built to show it.
   *
   * ## Why the previous window is read with its own COUNT
   *
   * ⚠️ **`SUM` over no rows is `NULL`, and so is `SUM` over rows that happen to
   * total zero** — the two are indistinguishable from the sum alone. A merchant
   * with no orders that far back and a merchant whose options earned nothing
   * are different situations with different advice, so the count decides which
   * it is and the sum only supplies the amount.
   *
   * ⚠️ **The boundary is `>= start AND < end`**, half-open at both ends, so an
   * order landing exactly on the boundary instant is counted once and not
   * twice. `BETWEEN` is inclusive at both ends and would double-count it.
   *
   * 📌 **Only orders carrying options are counted.** An order with no options
   * contributes nothing to option revenue, and including it in the order count
   * would make the two halves of this figure disagree about their own
   * denominator.
   */
  async revenueTrend(tenantId: string, windowDays = 30): Promise<RevenueTrend> {
    /*
     * 🔴 **The window length is interpolated, never parameterised — so it is
     * validated here.** `INTERVAL ? DAY` is not a placeholder MySQL accepts in
     * this position, and an unchecked number in a SQL string is an injection
     * even when every caller today passes a constant. Integer, positive, and
     * bounded at two years.
     */
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 730) {
      throw new Error(`revenueTrend: windowDays must be an integer in 1..730, got ${windowDays}`);
    }

    const [row] = (await this.dataSource.query(
      `SELECT
         COALESCE(SUM(CASE WHEN e.occurredAt >= NOW() - INTERVAL ${windowDays} DAY
                           THEN e.optionRevenueMinor END), 0) AS currentMinor,
         SUM(CASE WHEN e.occurredAt >= NOW() - INTERVAL ${windowDays} DAY
                  THEN 1 ELSE 0 END) AS currentOrders,
         COALESCE(SUM(CASE WHEN e.occurredAt >= NOW() - INTERVAL ${windowDays * 2} DAY
                            AND e.occurredAt <  NOW() - INTERVAL ${windowDays} DAY
                           THEN e.optionRevenueMinor END), 0) AS previousMinor,
         SUM(CASE WHEN e.occurredAt >= NOW() - INTERVAL ${windowDays * 2} DAY
                   AND e.occurredAt <  NOW() - INTERVAL ${windowDays} DAY
                  THEN 1 ELSE 0 END) AS previousOrders
       FROM order_events e
       JOIN stores s ON s.id = e.storeId
      WHERE s.tenantId = ?
        AND EXISTS (SELECT 1 FROM order_selections sel WHERE sel.orderEventId = e.id)`,
      [tenantId],
    )) as {
      currentMinor: string | null;
      currentOrders: string | number | null;
      previousMinor: string | null;
      previousOrders: string | number | null;
    }[];

    /*
     * ⚠️ **`SUM()` arrives as a string and `COUNT()` as a number** — mysql2 is
     * not uniform about this, and `CASE WHEN … THEN 1 ELSE 0 END` inside a
     * `SUM` is a sum, so it is a string here. `Number()` over both is the only
     * safe reading.
     */
    const currentOrders = Number(row?.currentOrders ?? 0);
    const previousOrders = Number(row?.previousOrders ?? 0);
    const currentMinor = Number(row?.currentMinor ?? 0);

    /* No order that far back at all: there is no "before" to compare against. */
    const hasPrevious = previousOrders > 0;
    const previousMinor = hasPrevious ? Number(row?.previousMinor ?? 0) : null;

    return {
      windowDays,
      currentMinor,
      previousMinor,
      currentOrders,
      previousOrders: hasPrevious ? previousOrders : null,
      /*
       * 🔴 **Division by zero is `null`, not `Infinity`.** Growth from nothing
       * is not a percentage, and `+∞%` or `+100%` would both be inventions.
       */
      changeFraction:
        previousMinor !== null && previousMinor !== 0
          ? (currentMinor - previousMinor) / previousMinor
          : null,
    };
  }

  /**
   * What each option earned, highest first.
   *
   * ## Why the label comes from a window function
   *
   * 🔴 **One `optionKey` can carry several `optionLabel`s.** Labels are
   * snapshotted at order time on purpose — a merchant renaming "Luxury" to
   * "Premium" must not rewrite what a past customer saw — so a year's grouping
   * can hold several names for one key. The most recent wins, because it is the
   * name the merchant last chose and therefore the one they will recognise.
   *
   * ⚠️ **`GROUP_CONCAT(... ORDER BY occurredAt DESC)` with `SUBSTRING_INDEX`
   * expresses that and is WRONG.** It silently truncates at
   * `group_concat_max_len` — 1024 by default, about five rows at a
   * 200-character label — and then picks whatever survived the cut, with
   * nothing to indicate it happened. `FIRST_VALUE` has no such cap.
   */
  async optionRevenue(tenantId: string): Promise<Capped<OptionRevenue>> {
    const rows = (await this.dataSource.query(
      `SELECT optionKey, label, revenueMinor, orders FROM (
         SELECT
           sel.optionKey AS optionKey,
           FIRST_VALUE(sel.optionLabel) OVER (
             PARTITION BY sel.optionKey ORDER BY e.occurredAt DESC, sel.id DESC
           ) AS label,
           SUM(sel.priceDeltaMinor) OVER (PARTITION BY sel.optionKey) AS revenueMinor,
           COUNT(*) OVER (PARTITION BY sel.optionKey) AS orders,
           ROW_NUMBER() OVER (
             PARTITION BY sel.optionKey ORDER BY e.occurredAt DESC, sel.id DESC
           ) AS rn
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ?
       ) ranked
       WHERE rn = 1
       ORDER BY revenueMinor DESC, orders DESC, optionKey ASC
       LIMIT ${MAX_ROWS}`,
      [tenantId],
    )) as { optionKey: string; label: string; revenueMinor: string; orders: number }[];

    const [count] = (await this.dataSource.query(
      `SELECT COUNT(DISTINCT sel.optionKey) AS total
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ?`,
      [tenantId],
    )) as { total: number }[];

    return this.capped(
      rows.map((row) => ({
        optionKey: row.optionKey,
        label: row.label,
        revenueMinor: Number(row.revenueMinor),
        orders: Number(row.orders),
      })),
      Number(count?.total ?? 0),
    );
  }

  /**
   * Which chosen values earn, and which are ignored.
   *
   * 🔒 **Keyed on `valueKey`, and free-text values are excluded entirely.** A
   * value key exists only where the merchant defined a choice; free text arrives
   * with `valueKey NULL` and its label is already `null` by the time it leaves
   * the shop. Grouping those together would produce one meaningless "everything
   * a customer typed" row — and the rule this phase is held to is that a rollup
   * carries `valueKey`, never `valueLabel`.
   */
  async valueRevenue(
    tenantId: string,
    direction: 'most' | 'least' = 'most',
  ): Promise<Capped<ValueRevenue>> {
    /*
     * 🔴 **`least` is ordered by ORDERS, not by revenue.** M25.3 asks for
     * most and least *selected*, which is a count — a value chosen twice at a
     * high price out-earns one chosen fifty times, and listing it as "least
     * selected" would answer a question nobody asked. The revenue travels with
     * the row either way, so a merchant can see both.
     */
    const order =
      direction === 'most'
        ? 'revenueMinor DESC, orders DESC, optionKey ASC, valueKey ASC'
        : 'orders ASC, revenueMinor ASC, optionKey ASC, valueKey ASC';

    const rows = (await this.dataSource.query(
      `SELECT optionKey, valueKey, label, revenueMinor, orders FROM (
         SELECT
           sel.optionKey AS optionKey,
           sel.valueKey AS valueKey,
           FIRST_VALUE(sel.optionLabel) OVER (
             PARTITION BY sel.optionKey, sel.valueKey ORDER BY e.occurredAt DESC, sel.id DESC
           ) AS label,
           SUM(sel.priceDeltaMinor) OVER (PARTITION BY sel.optionKey, sel.valueKey) AS revenueMinor,
           COUNT(*) OVER (PARTITION BY sel.optionKey, sel.valueKey) AS orders,
           ROW_NUMBER() OVER (
             PARTITION BY sel.optionKey, sel.valueKey ORDER BY e.occurredAt DESC, sel.id DESC
           ) AS rn
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ? AND sel.valueKey IS NOT NULL
       ) ranked
       WHERE rn = 1
       ORDER BY ${order}
       LIMIT ${MAX_ROWS}`,
      [tenantId],
    )) as {
      optionKey: string;
      valueKey: string;
      label: string;
      revenueMinor: string;
      orders: number;
    }[];

    const [count] = (await this.dataSource.query(
      `SELECT COUNT(DISTINCT sel.optionKey, sel.valueKey) AS total
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ? AND sel.valueKey IS NOT NULL`,
      /*
       * 📌 **The filter is redundant here and kept deliberately.**
       * `COUNT(DISTINCT a, b)` already skips any row where either column is
       * NULL, so removing it is an *equivalent mutation* — measured, not
       * assumed. It stays because the count must be readable as "the same
       * population the list above selected", and a reader checking that should
       * not have to know the NULL rule to confirm it.
       */
      [tenantId],
    )) as { total: number }[];

    return this.capped(
      rows.map((row) => ({
        optionKey: row.optionKey,
        valueKey: row.valueKey,
        label: row.label,
        revenueMinor: Number(row.revenueMinor),
        orders: Number(row.orders),
      })),
      Number(count?.total ?? 0),
    );
  }

  /**
   * Options a merchant maintains that no customer has ever chosen.
   *
   * 🔴 **This is the half of Phase 25's exit criterion that is not revenue** —
   * *"identify their highest-revenue options **and their dead ones**"* — and it
   * cannot come from the order tables, because an option with zero selections
   * has no rows there. It is live configuration minus what was ordered.
   *
   * ⚠️ **A soft-deleted option is not dead, it is gone.** Listing one would ask
   * a merchant to act on something they have already removed. Every join is
   * pinned to `LIVE_SENTINEL_SQL` for that reason — and because `deletedAt` is
   * `NOT NULL` with a sentinel default, so `IS NULL` would match nothing at all
   * and quietly report every option as dead.
   *
   * 📌 **Matched on the STORE, not only the tenant.** An option key is unique
   * within its group, not across a tenant's stores, so a tenant running two
   * shops could otherwise have one shop's sales mark the other's option alive.
   */
  async deadOptions(tenantId: string): Promise<Capped<DeadOption>> {
    const rows = (await this.dataSource.query(
      `SELECT
         os.id AS optionSetId,
         os.name AS optionSetName,
         o.\`key\` AS optionKey,
         o.label AS label
       FROM option_sets os
       JOIN option_groups g
         ON g.optionSetId = os.id AND g.deletedAt = '${LIVE_SENTINEL_SQL}'
       JOIN options o
         ON o.optionGroupId = g.id AND o.deletedAt = '${LIVE_SENTINEL_SQL}'
      WHERE os.tenantId = ?
        AND os.deletedAt = '${LIVE_SENTINEL_SQL}'
        AND NOT EXISTS (
          SELECT 1
            FROM order_selections sel
            JOIN order_events e ON e.id = sel.orderEventId
           WHERE sel.optionKey = o.\`key\`
             AND e.storeId = os.storeId
        )
      ORDER BY os.name ASC, o.sortOrder ASC, o.\`key\` ASC
      LIMIT ${MAX_ROWS}`,
      [tenantId],
    )) as {
      optionSetId: string;
      optionSetName: string;
      optionKey: string;
      label: string;
    }[];

    /*
     * ⚠️ **Counted with the same predicates, not estimated from the rows.** A
     * total that came from a looser query would overstate the problem — telling
     * a merchant they have ninety unused options when they have nine.
     */
    const [count] = (await this.dataSource.query(
      `SELECT COUNT(*) AS total
         FROM option_sets os
         JOIN option_groups g
           ON g.optionSetId = os.id AND g.deletedAt = '${LIVE_SENTINEL_SQL}'
         JOIN options o
           ON o.optionGroupId = g.id AND o.deletedAt = '${LIVE_SENTINEL_SQL}'
        WHERE os.tenantId = ?
          AND os.deletedAt = '${LIVE_SENTINEL_SQL}'
          AND NOT EXISTS (
            SELECT 1
              FROM order_selections sel
              JOIN order_events e ON e.id = sel.orderEventId
             WHERE sel.optionKey = o.\`key\`
               AND e.storeId = os.storeId
          )`,
      [tenantId],
    )) as { total: number }[];

    return this.capped(rows, Number(count?.total ?? 0));
  }

  /**
   * What each option set earned (M25.3's last clause, F150).
   *
   * ## Why the name comes from live configuration
   *
   * 📌 **A set id alone is unreadable**, and unlike `optionLabel` the order does
   * not snapshot the set's name — so this joins `option_sets` for it. The
   * consequence is deliberate: a **deleted** set has no name to show and drops
   * out, which is honest, because a merchant cannot act on revenue attributed to
   * something that no longer exists. Its selections still appear in
   * `topOptions`, so no revenue vanishes from the report as a whole.
   *
   * ⚠️ **`optionSetId IS NOT NULL` is REDUNDANT here, and kept deliberately.**
   * The inner `JOIN option_sets` already drops a row whose `optionSetId` is
   * null — measured, not assumed, so removing it is an *equivalent mutation*
   * that no test can kill. It stays because the exclusion is the point: orders
   * from a plugin older than F150 carry no set, and a reader must not have to
   * derive that from join semantics. They are counted separately by
   * `unattributedSelections`, because counting them as one anonymous group would
   * invent a set that never existed and dropping them silently would make the
   * per-set total read as complete.
   */
  /**
   * What options earned on each product (M25.4, F151).
   *
   * ## Why the name is a LEFT JOIN and the id is always shown
   *
   * 🔴 **`store_products` is a cache of the merchant's catalogue, not the truth
   * about it.** A shop that has never synced has no rows at all, and a product
   * deleted after an order was placed has none either — so an inner join would
   * drop exactly the revenue a merchant most wants explained, and drop it
   * silently. The id survives with a null name instead.
   *
   * ⚠️ **Joined on `storeId` as well as `externalId`.** A WooCommerce product
   * id is unique within one shop, and a tenant may connect several — so
   * matching on the id alone would show one store's product name against
   * another store's revenue the moment two shops both have a product 42.
   *
   * ## The boundary date
   *
   * ⚠️ **Rows from before the plugin sent a product are excluded, not counted
   * as one product.** `productRef IS NOT NULL` is what does it, and the
   * unattributed count beside this figure is what stops the exclusion reading
   * as "these products are all there is".
   */
  async productRevenue(tenantId: string): Promise<Capped<ProductRevenue>> {
    const rows = (await this.dataSource.query(
      `SELECT
         sel.productRef AS productRef,
         MAX(p.name) AS name,
         SUM(sel.priceDeltaMinor) AS revenueMinor,
         COUNT(*) AS orders
       FROM order_selections sel
       JOIN order_events e ON e.id = sel.orderEventId
       JOIN stores s ON s.id = e.storeId
       LEFT JOIN store_products p
         ON p.externalId = sel.productRef AND p.storeId = e.storeId
      WHERE s.tenantId = ? AND sel.productRef IS NOT NULL
      GROUP BY sel.productRef
      ORDER BY revenueMinor DESC, orders DESC, sel.productRef ASC
      LIMIT ${MAX_ROWS}`,
      [tenantId],
    )) as {
      productRef: string;
      name: string | null;
      revenueMinor: string;
      orders: number;
    }[];

    const [count] = (await this.dataSource.query(
      `SELECT COUNT(DISTINCT sel.productRef) AS total
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ? AND sel.productRef IS NOT NULL`,
      [tenantId],
    )) as { total: number }[];

    return this.capped(
      rows.map((row) => ({
        productRef: row.productRef,
        name: row.name ?? null,
        revenueMinor: Number(row.revenueMinor),
        orders: Number(row.orders),
      })),
      Number(count?.total ?? 0),
    );
  }

  /**
   * Selections placed before the plugin sent a product reference (F151).
   *
   * 🔴 **Without this the per-product table reads as complete when it is not.**
   * Every order placed before the plugin update carries a null `productRef`
   * and nothing can backfill it, so a merchant comparing two products needs to
   * know how much sits outside the comparison entirely — the same disclosure
   * `unattributedSelections` makes for option sets.
   */
  async unattributedProducts(tenantId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT COUNT(*) AS total
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ? AND sel.productRef IS NULL`,
      [tenantId],
    )) as { total: number }[];

    return Number(row?.total ?? 0);
  }

  /**
   * Of the customers who saw each option, how many bought it (M25.1, M25.3).
   *
   * ## Why this is a LEFT JOIN from views, not from orders
   *
   * 🔴 **The denominator is the thing that must not go missing.** Joining from
   * orders would list only options somebody bought — and an option seen two
   * thousand times and never chosen is precisely the row a merchant needs most.
   * It is the dead option M25.3 asks about, with a number attached.
   *
   * ⚠️ **An option with views and no orders converts at zero; an option with
   * orders and no views converts at NULL.** The first is a finding. The second
   * is a measurement gap — a store whose plugin predates M25.1 — and reporting
   * it as zero would tell a merchant their best option never sells.
   *
   * 📌 **Views are summed across days**, because the question is lifetime
   * conversion. A per-period figure belongs with `revenueTrend`, which already
   * owns the comparison over time.
   */
  async optionConversion(tenantId: string): Promise<Capped<OptionConversion>> {
    const rows = (await this.dataSource.query(
      /*
       * 🔴 **Two aggregates, never one join — a LEFT JOIN FANS OUT.** The first
       * version joined views to selections and summed both: a view row of 10
       * matched by two orders was counted twice, reporting 20 views and halving
       * the conversion rate. Measured, not reasoned about — a test asserting 10
       * received 20.
       *
       * ⚠️ **Each side is aggregated to one row per option BEFORE they meet**,
       * so neither can multiply the other however many rows it holds.
       */
      `SELECT
         v.optionKey AS optionKey,
         COALESCE(o.label, v.optionKey) AS label,
         v.views AS views,
         COALESCE(o.orders, 0) AS orders
       FROM (
         SELECT vc.optionKey AS optionKey, SUM(vc.views) AS views
           FROM option_view_counts vc
           JOIN stores s ON s.id = vc.storeId
          WHERE s.tenantId = ?
          GROUP BY vc.optionKey
       ) v
       LEFT JOIN (
         SELECT sel.optionKey AS optionKey,
                MAX(sel.optionLabel) AS label,
                COUNT(DISTINCT sel.orderEventId) AS orders
           FROM order_selections sel
           JOIN order_events e ON e.id = sel.orderEventId
           JOIN stores s2 ON s2.id = e.storeId
          WHERE s2.tenantId = ?
          GROUP BY sel.optionKey
       ) o ON o.optionKey = v.optionKey
      ORDER BY views DESC, v.optionKey ASC
      LIMIT ${MAX_ROWS}`,
      [tenantId, tenantId],
    )) as { optionKey: string; label: string; views: string; orders: number }[];

    const [count] = (await this.dataSource.query(
      `SELECT COUNT(DISTINCT v.optionKey) AS total
         FROM option_view_counts v
         JOIN stores s ON s.id = v.storeId
        WHERE s.tenantId = ?`,
      [tenantId],
    )) as { total: number }[];

    return this.capped(
      rows.map((row) => {
        const views = Number(row.views);
        const orders = Number(row.orders);

        return {
          optionKey: row.optionKey,
          label: row.label,
          views,
          orders,
          /* Division by zero is null, never Infinity — the F165 lesson. */
          rate: views > 0 ? orders / views : null,
        };
      }),
      Number(count?.total ?? 0),
    );
  }

  async optionSetRevenue(tenantId: string): Promise<Capped<OptionSetRevenue>> {
    const rows = (await this.dataSource.query(
      `SELECT
         sel.optionSetId AS optionSetId,
         os.name AS name,
         SUM(sel.priceDeltaMinor) AS revenueMinor,
         COUNT(*) AS orders
       FROM order_selections sel
       JOIN order_events e ON e.id = sel.orderEventId
       JOIN stores s ON s.id = e.storeId
       JOIN option_sets os
         ON os.id = sel.optionSetId AND os.deletedAt = '${LIVE_SENTINEL_SQL}'
      WHERE s.tenantId = ? AND sel.optionSetId IS NOT NULL
      GROUP BY sel.optionSetId, os.name
      ORDER BY revenueMinor DESC, orders DESC, os.name ASC
      LIMIT ${MAX_ROWS}`,
      [tenantId],
    )) as { optionSetId: string; name: string; revenueMinor: string; orders: number }[];

    const [count] = (await this.dataSource.query(
      `SELECT COUNT(DISTINCT sel.optionSetId) AS total
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
         JOIN option_sets os
           ON os.id = sel.optionSetId AND os.deletedAt = '${LIVE_SENTINEL_SQL}'
        WHERE s.tenantId = ? AND sel.optionSetId IS NOT NULL`,
      [tenantId],
    )) as { total: number }[];

    return this.capped(
      rows.map((row) => ({
        optionSetId: row.optionSetId,
        name: row.name,
        revenueMinor: Number(row.revenueMinor),
        orders: Number(row.orders),
      })),
      Number(count?.total ?? 0),
    );
  }

  /**
   * The one currency this tenant's orders are in, or `null` if there are several.
   *
   * 🔴 **Every figure this service returns is a sum of minor units**, and minor
   * units are meaningless without a currency: `4700` is £47.00 or ¥4700
   * depending on it. A dashboard that guessed would misstate revenue by a factor
   * of a hundred for a zero-decimal currency.
   *
   * ⚠️ **Several currencies yields `null`, not the most common one.** A tenant
   * with stores in two countries has totals here that are sums across both — not
   * an amount in either — so naming one would label a meaningless number with a
   * currency that makes it look meaningful. The caller is expected to withhold
   * the figures rather than mislabel them.
   */
  async currency(tenantId: string): Promise<string | null> {
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT e.currency AS currency
         FROM order_events e
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ?
        LIMIT 2`,
      [tenantId],
    )) as { currency: string }[];

    /* Exactly one, or nothing to say. Two is as informative as twenty here. */
    return rows.length === 1 ? rows[0].currency : null;
  }

  /**
   * How many selections carry no set attribution at all.
   *
   * 🔴 **This number is why the per-set report can be trusted.** Every order
   * placed before the plugin began sending a per-option set id has a null here,
   * permanently — nothing can backfill it, because the older per-line meta is a
   * flat list of the sets a line touched and cannot say which option belongs to
   * which. Reporting per-set revenue without saying how much sits outside it
   * presents a partial figure as a complete one.
   */
  async unattributedSelections(tenantId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT COUNT(*) AS total
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        WHERE s.tenantId = ? AND sel.optionSetId IS NULL`,
      [tenantId],
    )) as { total: number }[];

    return Number(row?.total ?? 0);
  }

  /**
   * Pair a capped list with the size of the population it came from.
   *
   * 🔴 **`truncated` is stated, not left for the caller to derive.** A client
   * comparing `rows.length` to a cap it has to know about is a client that gets
   * it wrong the first time `MAX_ROWS` changes — and the failure is silent.
   */
  private capped<T>(rows: T[], total: number): Capped<T> {
    return { rows, total, truncated: total > rows.length };
  }

  /**
   * Every option's revenue, as CSV rows (M25.5).
   *
   * ## Why this is not `optionRevenue()` with a bigger limit
   *
   * 🔴 **An export is for the whole dataset; the screen is for the top fifty.**
   * A merchant exporting to a spreadsheet is doing the thing the cap exists to
   * avoid — reading all of it — so capping the export would produce a file that
   * silently disagrees with itself the moment they sum a column.
   *
   * ⚠️ **No `MAX_ROWS` here, and that is deliberate.** The bound is the tenant's
   * own history, which is the honest one. A tenant large enough for this to
   * matter is a tenant whose rollups (M25.2) exist.
   *
   * 📌 **Currency travels with every row, not in a header.** A spreadsheet
   * column of minor units with the currency stated once at the top is a column
   * somebody sorts, filters, or pastes elsewhere — and then the currency is
   * gone. `null` becomes an empty cell rather than the word "null".
   */
  async exportOptionRevenue(tenantId: string): Promise<string> {
    const [rows, currency] = await Promise.all([
      this.dataSource.query(
        `SELECT optionKey, label, revenueMinor, orders FROM (
           SELECT
             sel.optionKey AS optionKey,
             FIRST_VALUE(sel.optionLabel) OVER (
               PARTITION BY sel.optionKey ORDER BY e.occurredAt DESC, sel.id DESC
             ) AS label,
             SUM(sel.priceDeltaMinor) OVER (PARTITION BY sel.optionKey) AS revenueMinor,
             COUNT(*) OVER (PARTITION BY sel.optionKey) AS orders,
             ROW_NUMBER() OVER (
               PARTITION BY sel.optionKey ORDER BY e.occurredAt DESC, sel.id DESC
             ) AS rn
           FROM order_selections sel
           JOIN order_events e ON e.id = sel.orderEventId
           JOIN stores s ON s.id = e.storeId
          WHERE s.tenantId = ?
         ) ranked
         WHERE rn = 1
         ORDER BY revenueMinor DESC, orders DESC, optionKey ASC`,
        [tenantId],
      ) as Promise<{ optionKey: string; label: string; revenueMinor: string; orders: number }[]>,
      this.currency(tenantId),
    ]);

    return toCsv(
      ['option_key', 'option_label', 'revenue_minor', 'currency', 'orders'],
      rows.map((row) => [
        row.optionKey,
        row.label,
        String(Number(row.revenueMinor)),
        currency ?? '',
        String(Number(row.orders)),
      ]),
      /*
       * 🔴 **Columns 2 and 4 stay numeric** — `revenue_minor` and `orders`
       * (F165). Both are `String(Number(…))` over an aggregate, so nothing a
       * merchant typed can reach them, and a negative revenue must arrive in
       * the spreadsheet as a number the merchant can sum.
       *
       * ⚠️ **`currency` at index 3 is NOT here.** It is a three-letter code
       * today, but it comes from `order_events.currency`, which the plugin
       * sends — so it is data from outside this system and is guarded like any
       * other text.
       */
      new Set([2, 4]),
    );
  }
}

/**
 * Rows to CSV, escaped so a spreadsheet reads what the database holds.
 *
 * ## Why this is hand-written rather than a dependency
 *
 * 📌 **The whole of CSV that matters here is one rule**, and it is RFC 4180's:
 * a field containing a comma, a quote or a newline is wrapped in quotes, and an
 * embedded quote is doubled. A merchant's option label is free text — *"Size,
 * large"* and *"12\" model"* are both ordinary — so this is not a theoretical
 * case.
 *
 * 🔴 **The leading-character guard is the one that matters for safety.** A cell
 * beginning `=`, `+`, `-` or `@` is executed as a formula by Excel and Sheets,
 * so a merchant who names an option `=1+1` ships a spreadsheet that computes —
 * and one who is targeted can be made to ship one that fetches a URL. Prefixing
 * a tab neutralises it while leaving the text readable.
 *
 * ⚠️ **CRLF, not LF.** RFC 4180 says so, and Excel on Windows is the reader that
 * cares.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  numericColumns: ReadonlySet<number> = new Set(),
): string {
  const escape = (raw: string, column: number, isHeader: boolean): string => {
    /*
     * 🔴 **A numeric column is NEVER formula-guarded** (F165).
     *
     * The guard prefixes a tab, and `-` is in its character class because
     * `-1+1` is a formula. But `revenue_minor` is legitimately negative — a
     * discount option earns negative revenue, which this codebase tests at both
     * ends — and `"\t-500"` is **text** to Excel, not a number. `SUM()` over
     * that column silently skips it, so the merchant's total is wrong with no
     * error shown: the exact failure a spreadsheet export exists to avoid.
     *
     * ⚠️ **Safe because these values never come from a merchant.** They are
     * `String(Number(…))` over a database aggregate — digits and an optional
     * leading minus, and nothing else can reach them. A column carrying
     * anything a person typed is not numeric and does not belong here.
     *
     * ✏️ **Found auditing my own commit**: I tested the guard with `=1+1` and
     * never with a negative number, in a repository that tests negative deltas
     * twice elsewhere.
     *
     * 🔴 **The HEADER row is never exempt, whatever column it is in.** A header
     * is a name, never a number, so the reason for the exemption does not apply
     * to it — and without this an `=`-leading header in a numeric column passed
     * through raw. Today's only caller passes five hardcoded literals, so
     * nothing is exploitable; `toCsv` is exported, so the next caller would
     * have inherited the trap with no way to see it.
     */
    const exempt = !isHeader && numericColumns.has(column);

    const guarded = !exempt && /^[=+\-@\t\r]/.test(raw) ? `\t${raw}` : raw;

    /*
     * Quoting runs after, so a guarded field carries its tab INSIDE the quotes.
     * The other order would let a parser see the tab before the opening quote
     * and break the field.
     *
     * 📌 **A leading newline is not in the guard's class and does not need to
     * be.** `"\n=1+1"` is quoted for the newline, which puts the `=` off cell
     * start — measured, rather than reasoned about.
     */
    return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };

  return [header, ...rows]
    .map((row, index) =>
      row.map((cell, column) => escape(cell, column, index === 0)).join(','),
    )
    .join('\r\n');
}
