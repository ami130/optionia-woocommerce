import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';

/**
 * The metrics a plan limit can be enforced against (M24.1).
 *
 * 📌 **Wider than `UsageMetric`, and deliberately so.** That union names what is
 * *recorded* into `usage_records`; this names what can be *compared* to a plan.
 * The two differ because most of these are counted live — see below.
 */
export const COUNTABLE_METRICS = [
  'option_sets',
  'stores',
  'team_seats',
  'products_assigned',
  'file_storage_mb',
] as const;

/**
 * 🔴 **The type is DERIVED from the runtime list, not written beside it.**
 *
 * Plan administration validates an admin's input against the metrics this
 * system can actually enforce, and that check needs the names **at runtime** —
 * a type-only union cannot be iterated. Declaring the array separately and
 * keeping the union by hand is how the two drift: a metric added to one and
 * forgotten in the other produces either a limit nothing enforces, or an
 * enforceable metric an admin cannot set, and neither fails loudly.
 *
 * `typeof … [number]` makes drift impossible rather than unlikely.
 */
export type CountableMetric = (typeof COUNTABLE_METRICS)[number];

/**
 * What a tenant is using right now (M24.1).
 *
 * ## Why these are counted live and storage is not
 *
 * 🔴 **A stored count can drift from the truth; a live count cannot.** Four of
 * these five metrics are rows in tables this backend owns, so the database can
 * answer exactly. A snapshot would need every create, delete, restore and
 * cascade to remember to update it — and the one that forgets produces a tenant
 * refused a write they are entitled to, or allowed one they are not, with
 * nothing to indicate which.
 *
 * ⚠️ **`file_storage_mb` is the exception because the bytes are not ours.** They
 * live on the merchant's own server and arrive by heartbeat, so there is nothing
 * to count here — `UsageService.recordStorage()` sums what was last reported.
 * That is a genuinely different kind of number and it reads from
 * `usage_records` rather than counting.
 *
 * ✏️ **This said *"not a hot read"*, and two commits later it was one.**
 * M24.4 put `report()` on `GET /v1/billing/subscription`, which the dashboard
 * polls **every three seconds while a checkout is settling** — so one merchant
 * mid-payment drives roughly 140 counts a minute across five tables, where the
 * original claim assumed a merchant clicking Create by hand.
 *
 * 📌 **Still not cached, and now for a reason that survives the move.** Each
 * count is a single indexed `COUNT(*)` on a tenant-scoped table, the poll is
 * bounded (it stops the moment `settling` clears, typically seconds), and a
 * cache would reintroduce exactly the drift these live counts exist to avoid —
 * a stored figure that disagrees with the rows and refuses a merchant a write
 * they are entitled to.
 *
 * ⚠️ **What would change the answer**: a second polled caller, or a metric
 * whose count is not index-backed. Either makes this a measurement to redo
 * rather than a comment to re-read.
 */
@Injectable()
export class UsageCounterService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * How many units of `metric` this tenant is using.
   *
   * ⚠️ **Runs inside the caller's transaction when given one.** A guard that
   * counts outside the transaction it is protecting can be beaten by a
   * concurrent write in the gap: two requests both read "9 of 10" and both
   * proceed. Counting on the caller's connection puts the read and the write in
   * the same unit of work.
   */
  async count(
    tenantId: string,
    metric: CountableMetric,
    manager?: EntityManager,
  ): Promise<number> {
    const runner = manager ?? this.dataSource;

    switch (metric) {
      case 'option_sets':
        return this.scalar(
          runner,
          /*
           * 🔴 **Soft-deleted sets are not usage**: the merchant cannot see
           * them and cannot reduce the number further, so counting them would
           * hold them against a limit for work they already removed.
           *
           * ✏️ **`deletedAt IS NULL` was WRONG and silently counted nothing.**
           * The column is `NOT NULL` with a `1970-01-01` sentinel default
           * (`LIVE_SENTINEL`), so `IS NULL` matches no row at all — every
           * tenant would have reported zero usage and no limit would ever have
           * fired. Caught by an e2e reading the row back, not by review.
           */
          `SELECT COUNT(*) AS n FROM option_sets
            WHERE tenantId = ? AND deletedAt = '${LIVE_SENTINEL_SQL}'`,
          tenantId,
        );

      case 'stores':
        /*
         * ⚠️ **Every store counts, including disconnected ones.** Unlike
         * storage — where a disconnected store's bytes must stop counting
         * because the merchant can no longer reduce them — a store row is
         * something they *can* delete. Excluding them would let a tenant hold
         * unlimited disconnected stores against a limit of one.
         */
        return this.scalar(
          runner,
          `SELECT COUNT(*) AS n FROM stores WHERE tenantId = ?`,
          tenantId,
        );

      case 'team_seats':
        /*
         * 🔴 **Accepted members PLUS pending invitations**, which the milestone
         * is explicit about: *"otherwise a tenant can exceed its seat limit by
         * holding invitations open"*.
         *
         * ⚠️ **An EXPIRED invitation holds no seat.** It cannot be accepted, so
         * charging for it would bill a tenant for a seat nobody can ever take —
         * and the milestone's reasoning is about seats someone might still
         * claim, not about rows that exist.
         *
         * 📌 **Role is irrelevant**: a `viewer` occupies a seat exactly as an
         * `owner` does, per M24.1.
         */
        return this.scalar(
          runner,
          `SELECT
             (SELECT COUNT(*) FROM tenant_members
               WHERE tenantId = ? AND revokedAt IS NULL)
           + (SELECT COUNT(*) FROM tenant_invitations
               WHERE tenantId = ?
                 AND acceptedAt IS NULL
                 AND revokedAt IS NULL
                 AND expiresAt > NOW(3)) AS n`,
          tenantId,
          tenantId,
        );

      case 'products_assigned':
        /*
         * 🔴 **Assignment ROWS, not resolved products** — the user's decision,
         * recorded in the Phase 24 plan. A category assignment costs 1 whatever
         * it covers, because resolving it against the mirrored catalogue would
         * make a tenant's usage move when they add a product *in WooCommerce*.
         * Being refused a write here because of something done elsewhere is a
         * support ticket, not a limit.
         *
         * ⚠️ **Scoped through the option set**, because `option_set_assignments`
         * carries no `tenantId` of its own — and the set's own soft-delete is
         * checked too, or a deleted set's assignments keep costing the merchant.
         */
        return this.scalar(
          runner,
          `SELECT COUNT(*) AS n
             FROM option_set_assignments a
             JOIN option_sets s ON s.id = a.optionSetId
            WHERE s.tenantId = ?
              AND a.deletedAt = '${LIVE_SENTINEL_SQL}'
              AND s.deletedAt = '${LIVE_SENTINEL_SQL}'`,
          tenantId,
        );

      case 'file_storage_mb':
        /*
         * 📌 **Read, not counted.** The bytes are on the merchant's server; the
         * most recent heartbeat is the only thing that knows them.
         */
        return this.scalar(
          runner,
          `SELECT COALESCE(value, 0) AS n FROM usage_records
            WHERE tenantId = ? AND metric = 'file_storage_mb'
            ORDER BY periodStart DESC LIMIT 1`,
          tenantId,
        );
    }
  }

  /**
   * 📌 **`Number(...)` defensively, not because it is needed today.**
   *
   * ✏️ The first version of this comment claimed `mysql2` returns `COUNT` as a
   * string for `BIGINT` — **measured, and it does not**: `typeof` is `number`.
   * The coercion stays because the driver is **not uniform**, measured on this
   * database: `COUNT(*)` and `usage_records.value` come back as `number`, while
   * `SUM(...)` comes back as the **string** `"0"`. Every query here is one
   * `SUM` away from the wrong type, and `'9' >= 10` is false while `'10' >= 10`
   * is true — a limit that would work until the number reached two digits.
   * Keeping the cast costs nothing; keeping a wrong reason for it costs the
   * next reader.
   */
  private async scalar(
    runner: DataSource | EntityManager,
    sql: string,
    ...params: string[]
  ): Promise<number> {
    const [row] = (await runner.query(sql, params)) as { n: string | number }[];

    return Number(row?.n ?? 0);
  }
}
