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

/** How many orders carried options at all (M25.3). */
export interface AttachRate {
  readonly orders: number;
  readonly ordersWithOptions: number;
  /** 0–1, or `null` when there are no orders to divide by. */
  readonly rate: number | null;
  readonly optionRevenueMinor: number;
  readonly totalRevenueMinor: number;
}

/** Everything the analytics screen renders in one call. */
export interface AnalyticsSummary {
  readonly attach: AttachRate;
  readonly topOptions: OptionRevenue[];
  readonly topValues: ValueRevenue[];
  readonly deadOptions: DeadOption[];
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
    const [attach, topOptions, topValues, deadOptions] = await Promise.all([
      this.attachRate(tenantId),
      this.optionRevenue(tenantId),
      this.valueRevenue(tenantId),
      this.deadOptions(tenantId),
    ]);

    return { attach, topOptions, topValues, deadOptions };
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
         COALESCE(SUM(e.orderTotalMinor), 0) AS totalRevenueMinor
       FROM order_events e
       JOIN stores s ON s.id = e.storeId
      WHERE s.tenantId = ?`,
      [tenantId],
    )) as {
      orders: number;
      ordersWithOptions: string | null;
      optionRevenueMinor: string | null;
      totalRevenueMinor: string | null;
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
  async optionRevenue(tenantId: string): Promise<OptionRevenue[]> {
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

    return rows.map((row) => ({
      optionKey: row.optionKey,
      label: row.label,
      revenueMinor: Number(row.revenueMinor),
      orders: Number(row.orders),
    }));
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
  async valueRevenue(tenantId: string): Promise<ValueRevenue[]> {
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
       ORDER BY revenueMinor DESC, orders DESC, optionKey ASC, valueKey ASC
       LIMIT ${MAX_ROWS}`,
      [tenantId],
    )) as {
      optionKey: string;
      valueKey: string;
      label: string;
      revenueMinor: string;
      orders: number;
    }[];

    return rows.map((row) => ({
      optionKey: row.optionKey,
      valueKey: row.valueKey,
      label: row.label,
      revenueMinor: Number(row.revenueMinor),
      orders: Number(row.orders),
    }));
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
  async deadOptions(tenantId: string): Promise<DeadOption[]> {
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

    return rows;
  }
}
