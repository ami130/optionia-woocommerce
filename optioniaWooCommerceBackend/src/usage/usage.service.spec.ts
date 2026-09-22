import type { DataSource } from 'typeorm';

import { UsageService } from './usage.service';

/**
 * A connection that answers the storage sum and records what was written.
 *
 * @param bytes What the tenant's stores add up to.
 */
function connectionReturning(bytes: number | null): {
  dataSource: DataSource;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const dataSource = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });

      return sql.includes('FROM stores') ? [{ bytes }] : [];
    },
  } as unknown as DataSource;

  return { dataSource, queries };
}

/** The value written into `usage_records`, as the insert bound it. */
function recordedValue(queries: Array<{ sql: string; params: unknown[] }>): number {
  const insert = queries.find((q) => q.sql.includes('usage_records'));

  if (!insert) {
    throw new Error('No usage row was written.');
  }

  // (id, tenantId, metric, value)
  return insert.params[3] as number;
}

describe('UsageService.recordStorage', () => {
  /**
   * 🔴 **The tenant total is summed across its stores, never taken from one.**
   *
   * `file_storage_mb` is a tenant limit, but a tenant may hold ten stores each
   * reporting only itself. Writing one store's figure would let the last store to
   * heartbeat decide the total; accumulating would grow it on every heartbeat.
   */
  it('sums every store belonging to the tenant', async () => {
    const { dataSource, queries } = connectionReturning(3 * 1024 * 1024);

    await new UsageService(dataSource).recordStorage('tenant-1');

    const sum = queries.find((q) => q.sql.includes('FROM stores'));

    expect(sum?.sql).toContain('SUM(storageBytes)');
    expect(sum?.sql).toContain('WHERE tenantId = ?');
    expect(sum?.params).toEqual(['tenant-1']);
  });

  /**
   * 🔴 **A store the merchant has disconnected stops counting.**
   *
   * `recordStorage` runs only on a heartbeat, and a disconnected or revoked store
   * never heartbeats again — so without this filter its bytes stay in the tenant
   * total with nothing left to reduce them. A tenant holding one store would sit
   * permanently against a limit for storage it can no longer see or change.
   */
  it('excludes stores the merchant can no longer reduce', async () => {
    const { dataSource, queries } = connectionReturning(1024 * 1024);

    await new UsageService(dataSource).recordStorage('tenant-1');

    const sum = queries.find((q) => q.sql.includes('FROM stores'));

    expect(sum?.sql).toContain("NOT IN ('disconnected', 'revoked')");
  });

  /**
   * ⚠️ **`error` and `connecting` still count.** Both are live stores — one
   * failing to reach the cloud, one mid-handshake — and both will heartbeat
   * again. The filter answers "can the merchant still change this number", not
   * "are the bytes on disk".
   */
  it('keeps counting stores that are merely unhealthy', async () => {
    const { dataSource, queries } = connectionReturning(1024 * 1024);

    await new UsageService(dataSource).recordStorage('tenant-1');

    const sum = queries.find((q) => q.sql.includes('FROM stores'));

    expect(sum?.sql).not.toContain('error');
    expect(sum?.sql).not.toContain('connecting');
  });

  /**
   * ⚠️ **Rounded up, because under-reporting is the dangerous direction.**
   *
   * A store holding 1.4 MB reporting as 1 would let a tenant sit just over a
   * limit it was sold while measuring as just under.
   */
  it('rounds a part-used megabyte up', async () => {
    const { dataSource, queries } = connectionReturning(1.4 * 1024 * 1024);

    await new UsageService(dataSource).recordStorage('tenant-1');

    expect(recordedValue(queries)).toBe(2);
  });

  /** A tenant holding any bytes at all reports at least one megabyte. */
  it('never rounds a non-empty store down to nothing', async () => {
    const { dataSource, queries } = connectionReturning(1);

    await new UsageService(dataSource).recordStorage('tenant-1');

    expect(recordedValue(queries)).toBe(1);
  });

  /** A tenant holding nothing reports nothing, not one. */
  it('records zero for a tenant holding nothing', async () => {
    const { dataSource, queries } = connectionReturning(0);

    await new UsageService(dataSource).recordStorage('tenant-1');

    expect(recordedValue(queries)).toBe(0);
  });

  /** A tenant whose stores have never reported is treated as empty, not broken. */
  it('survives a null sum', async () => {
    const { dataSource, queries } = connectionReturning(null);

    await new UsageService(dataSource).recordStorage('tenant-1');

    expect(recordedValue(queries)).toBe(0);
  });

  /**
   * 🔴 **One atomic statement, not a read followed by a write.**
   *
   * `ix_usage_tenant_metric` is unique precisely so this can be a single
   * `INSERT ... ON DUPLICATE KEY UPDATE`: two stores of one tenant heartbeating
   * together would both lose a read-then-write race, and a business-plan tenant
   * has ten stores checking in daily.
   */
  it('writes the period row atomically', async () => {
    const { dataSource, queries } = connectionReturning(1024 * 1024);

    await new UsageService(dataSource).recordStorage('tenant-1');

    const insert = queries.find((q) => q.sql.includes('usage_records'));

    expect(insert?.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(insert?.params[1]).toBe('tenant-1');
    expect(insert?.params[2]).toBe('file_storage_mb');
  });

  /**
   * ⚠️ **The period boundary is the database's clock, not Node's.** A server
   * drifting from MySQL would otherwise write into a month the database would
   * never read back.
   */
  it('derives the period in SQL', async () => {
    const { dataSource, queries } = connectionReturning(1024 * 1024);

    await new UsageService(dataSource).recordStorage('tenant-1');

    const insert = queries.find((q) => q.sql.includes('usage_records'));

    expect(insert?.sql).toContain('DATE_FORMAT(NOW(3)');
    expect(insert?.sql).toContain('LAST_DAY(NOW(3))');
  });
});
