import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

/**
 * The metrics `plans.limits` can be compared against.
 *
 * A string union rather than free text: `usage_records.metric` is 40 characters
 * of `varchar`, so a typo is a row nobody reads and a limit nobody enforces —
 * silently, because both sides of the comparison would simply find nothing.
 */
export type UsageMetric = 'file_storage_mb';

/** Bytes in a megabyte, as the plan limits mean it. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * Records what a tenant is using, for [Phase 24] to enforce against.
 *
 * ## Why storage is summed rather than written
 *
 * 🔴 **`file_storage_mb` is a tenant limit, and storage is per store.** A tenant
 * may hold up to ten stores, each with its own uploads table on its own disk, and
 * each reports only its own figure. Neither obvious write is correct:
 *
 * ```text
 * SET value = <store's figure>   -> the last store to heartbeat wins
 * SET value = value + <figure>   -> grows on every heartbeat, forever
 * ```
 *
 * So each store's current figure lives on `stores.storageBytes`, and this
 * re-sums them. The tenant row is then a *derived* number that no single store
 * can distort, and a store that stops reporting stops contributing rather than
 * freezing its last value into the total.
 */
@Injectable()
export class UsageService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Re-sum a tenant's storage across its stores and record the total.
   *
   * ⚠️ **Rounded up, and never to zero.** A limit comparison in megabytes must
   * not let a store holding 1.4 MB report as 1 — under-reporting is the direction
   * that lets a tenant exceed a limit it has been sold. A tenant holding *any*
   * bytes reports at least 1 MB for the same reason.
   *
   * @param tenantId The tenant whose usage is being recorded.
   */
  async recordStorage(tenantId: string, manager?: EntityManager): Promise<void> {
    /*
     * ⚠️ **Runs inside the caller's transaction when there is one.** The
     * heartbeat writes the store's figure and then re-sums the tenant from it;
     * splitting those across two transactions would let a failure between them
     * leave a store's figure recorded and the tenant total describing the
     * previous one — data that looks legitimate, so nothing reports an error.
     */
    const runner = manager ?? this.dataSource;

    /*
     * 🔴 **A store the merchant has disconnected stops counting.**
     *
     * `recordStorage` runs only on a heartbeat, and a disconnected or revoked
     * store never heartbeats again — so without this filter its bytes stay in the
     * tenant's total with no way to reduce them. For a tenant holding one store
     * that means a number frozen permanently, blocking a merchant against storage
     * that no longer reports and that they cannot see.
     *
     * ⚠️ **`error` and `connecting` still count.** Those stores are live: one is
     * failing to reach the cloud and the other is mid-handshake, and both will
     * heartbeat again. The question this filter answers is not "are the bytes on
     * disk" but "can the merchant still change this number".
     *
     * String literals rather than `StoreStatus.*` because `check-store-state.sh`
     * flags any file naming the enum outside its allowlist — the state machine is
     * the one place allowed to reason about transitions, and this is a read.
     */
    const [row] = await runner.query(
      `SELECT COALESCE(SUM(storageBytes), 0) AS bytes
         FROM stores
        WHERE tenantId = ?
          AND status NOT IN ('disconnected', 'revoked')`,
      [tenantId],
    );

    const bytes = Number(row?.bytes ?? 0);
    const megabytes = bytes > 0 ? Math.max(1, Math.ceil(bytes / BYTES_PER_MB)) : 0;

    await this.record(runner, tenantId, 'file_storage_mb', megabytes);
  }

  /**
   * Write one metric for the current period.
   *
   * ⚠️ **A single atomic statement.** `ix_usage_tenant_metric` is unique, so
   * `ON DUPLICATE KEY UPDATE` replaces the read-then-write that two stores of one
   * tenant could both lose. The period is the calendar month, which is what a
   * plan is billed and enforced against.
   *
   * @param runner   The connection or transaction to write through.
   * @param tenantId The tenant.
   * @param metric   Which limit this counts against.
   * @param value    The measured total.
   */
  private async record(
    runner: DataSource | EntityManager,
    tenantId: string,
    metric: UsageMetric,
    value: number,
  ): Promise<void> {
    /*
     * Computed in SQL rather than in Node so the boundary follows the database's
     * clock. A server drifting from MySQL would otherwise write into a period the
     * database would never read back.
     */
    await runner.query(
      `INSERT INTO usage_records
         (id, createdAt, updatedAt, tenantId, metric, value, periodStart, periodEnd)
       VALUES (
         ?, NOW(3), NOW(3), ?, ?, ?,
         DATE_FORMAT(NOW(3), '%Y-%m-01 00:00:00.000'),
         LAST_DAY(NOW(3)) + INTERVAL 1 DAY - INTERVAL 1 MICROSECOND
       )
       ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = NOW(3)`,
      [uuidv7(), tenantId, metric, value],
    );
  }
}
