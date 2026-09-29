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
      optionSets,
      unattributed,
      currency,
    ] = await Promise.all([
        this.attachRate(tenantId),
        this.optionRevenue(tenantId),
        this.valueRevenue(tenantId, 'most'),
        this.valueRevenue(tenantId, 'least'),
        this.deadOptions(tenantId),
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
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const escape = (raw: string): string => {
    /*
     * The formula guard runs BEFORE quoting, so the tab is inside the quoted
     * field rather than outside it — otherwise the quoting would be what a
     * parser sees first and the tab would break the field.
     */
    const guarded = /^[=+\-@\t\r]/.test(raw) ? `\t${raw}` : raw;

    return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };

  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
}
