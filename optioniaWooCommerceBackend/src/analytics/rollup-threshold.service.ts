import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * When a tenant's analytics grows past the point rollups start paying (M25.2).
 *
 * ## Why this exists instead of the rollup tables
 *
 * 🔴 **M25.2's deferral was an intention, not a mechanism.** The measurement is
 * recorded in the plan: covering indexes are worth **3.5×** at 480k selections
 * (253ms → 72ms) and **nothing** at 60k (127ms against 130ms), because below
 * roughly 100k the optimizer scans and scanning is genuinely cheaper. Building
 * rollups before then pays a write cost on every order for a read that is
 * already fast.
 *
 * ⚠️ **But nothing watched the figure.** A deferral with no trigger is a note
 * asking a human to remember, and this repository has recorded that lesson
 * repeatedly — most recently in `check-ledger.sh`, whose opening line is that a
 * note asking a human to remember is not a mechanism. Without this, the first
 * sign of crossing the threshold is a merchant reporting a slow dashboard.
 *
 * ## What this deliberately does NOT do
 *
 * 🔴 **It does not build, schedule or hint at a rollup.** The decision recorded
 * in 25-1.0 is that rollups are built *when the threshold is crossed*, and a
 * monitor that quietly started aggregating would make that decision by itself.
 *
 * ⚠️ **It does not touch `/health`.** That endpoint is a liveness probe a load
 * balancer acts on, and a tenant crossing a capacity threshold is not a reason
 * to restart the service or pull it from rotation. Conflating "this instance is
 * broken" with "this account got big" is how a probe stops meaning anything.
 *
 * 📌 **It reports at WARN and changes nothing.** The signal is the whole
 * deliverable: somebody is told, in time to build rollups deliberately rather
 * than under a performance incident.
 */
@Injectable()
export class RollupThresholdService {
  private readonly logger = new Logger(RollupThresholdService.name);

  /**
   * The point at which covering indexes begin to pay.
   *
   * 🔴 **Measured on a 480k-row scratch copy, not chosen.** At 60k the indexes
   * were worth nothing (127ms against 130ms); at 480k they were worth 3.5×
   * (253ms → 72ms). 100k is where the curve turns, so it is where a warning is
   * useful rather than premature.
   */
  static readonly THRESHOLD = 100_000;

  /**
   * How far below the threshold a tenant is still worth reporting.
   *
   * ⚠️ **Warning only AT the threshold would be a warning that arrives too
   * late.** Building rollups is a schema change with a migration and a
   * backfill; being told on the day the dashboard slows leaves no room to do it
   * deliberately. 80% gives roughly a quarter of the tenant's growth as notice.
   */
  static readonly APPROACHING = 0.8;

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Every tenant at or near the threshold, largest first.
   *
   * ⚠️ **`HAVING`, not a `WHERE` on the count**, because the count does not
   * exist until the rows are grouped. Filtering in SQL rather than in JS means
   * a platform with ten thousand small tenants transfers a handful of rows
   * rather than all of them.
   *
   * 📌 **Cheap by construction, and it has to be.** A monitor that became the
   * slow query it warns about would be self-defeating; `EXPLAIN` shows covering
   * index lookups throughout, on the indexes analytics already needs.
   */
  async approaching(): Promise<ReadonlyArray<{ tenantId: string; selections: number }>> {
    const floor = Math.floor(RollupThresholdService.THRESHOLD * RollupThresholdService.APPROACHING);

    const rows = (await this.dataSource.query(
      `SELECT s.tenantId AS tenantId, COUNT(*) AS selections
         FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
         JOIN stores s ON s.id = e.storeId
        GROUP BY s.tenantId
       HAVING selections >= ?
        ORDER BY selections DESC`,
      [floor],
    )) as { tenantId: string; selections: string | number }[];

    /*
     * ⚠️ **`COUNT(*)` arrives as a number and `SUM()` as a string**, and mysql2
     * is not uniform about it. `Number()` over both is the only safe reading —
     * the same trap `revenueTrend` documents.
     */
    return rows.map((row) => ({
      tenantId: row.tenantId,
      selections: Number(row.selections),
    }));
  }

  /**
   * Check, and say something when there is something to say.
   *
   * 🔴 **Silent when nothing is near the threshold.** A monitor that logs on
   * every pass is one an operator learns to filter out, and then the one line
   * that matters is filtered with it.
   */
  async check(): Promise<{ approaching: number; crossed: number }> {
    const tenants = await this.approaching();

    const crossed = tenants.filter(
      (tenant) => tenant.selections >= RollupThresholdService.THRESHOLD,
    );

    for (const tenant of crossed) {
      this.logger.warn(
        `Tenant ${tenant.tenantId} has ${tenant.selections} order selections, past the ` +
          `${RollupThresholdService.THRESHOLD} at which M25.2's rollup tables begin to pay ` +
          `(measured 3.5x at 480k, nothing at 60k). Analytics reads are now worth revisiting.`,
      );
    }

    /*
     * 📌 **Approaching is reported once, as a count rather than per tenant.**
     * The actionable event is crossing; the approach is context, and naming
     * every tenant would bury the lines above it.
     */
    if (tenants.length > crossed.length) {
      this.logger.log(
        `${tenants.length - crossed.length} tenant(s) are within ` +
          `${Math.round((1 - RollupThresholdService.APPROACHING) * 100)}% of the rollup threshold.`,
      );
    }

    return { approaching: tenants.length - crossed.length, crossed: crossed.length };
  }
}
