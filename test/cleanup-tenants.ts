import type { DataSource } from 'typeorm';

/**
 * Remove the tenants a suite's users belong to.
 *
 * ## Why this is not `DELETE FROM tenants WHERE slug LIKE 'ns-%'`
 *
 * Registration provisions a tenant whose slug comes from the tenant **name**,
 * not the suite's namespace. A test registering as `Sam Merchant` or `Owner`
 * produces `sam-…` or `owner-…`, which a slug match never finds — so every run
 * leaked a handful of tenants.
 *
 * That went unnoticed until the table reached **6,900 rows**, at which point the
 * added latency turned other suites' fixture creates into intermittent 404s. The
 * failure moved between tests, never reproduced in isolation, and was chased
 * through three wrong theories across two audits before the row count was
 * looked at.
 *
 * Three suites had the same defect and were fixed one at a time. This exists so
 * the fourth does not: membership is the only reliable link between a tenant and
 * the suite that made it.
 *
 * Memberships are read **before** they are deleted, because deleting them first
 * destroys the only evidence of which tenants to remove.
 */
export async function deleteTenantsFor(
  dataSource: DataSource,
  emailPrefix: string,
): Promise<void> {
  const owned: Array<{ tenantId: string }> = await dataSource.query(
    `SELECT DISTINCT tm.tenantId FROM tenant_members tm JOIN users u ON u.id = tm.userId
      WHERE u.email LIKE ?`,
    [`${emailPrefix}-%`],
  );

  await dataSource.query(
    `DELETE tm FROM tenant_members tm JOIN users u ON u.id = tm.userId WHERE u.email LIKE ?`,
    [`${emailPrefix}-%`],
  );

  if (owned.length > 0) {
    await dataSource.query(`DELETE FROM tenants WHERE id IN (?)`, [
      owned.map((row) => row.tenantId),
    ]);
  }
}
