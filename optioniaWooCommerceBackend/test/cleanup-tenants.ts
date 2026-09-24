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
    /*
     * 🔴 **Subscriptions first, because `subscriptions.tenantId` is RESTRICT.**
     *
     * Provisioning now creates a free subscription alongside the owner (F86,
     * step 2b), so every tenant has one — and the tenant delete below began
     * failing in **six** suites at once, in teardown rather than in a test.
     * That is the worst place for it: the error names a foreign key, not the
     * change that caused it, and it appears in files that have nothing to do
     * with billing.
     *
     * ⚠️ **`RESTRICT` is right and stays.** A subscription whose tenant vanished
     * is an orphaned billing record, which is precisely what the constraint
     * exists to prevent. The teardown adapts to the schema, not the other way
     * round.
     */
    await dataSource.query(`DELETE FROM subscriptions WHERE tenantId IN (?)`, [
      owned.map((row) => row.tenantId),
    ]);

    await dataSource.query(`DELETE FROM tenants WHERE id IN (?)`, [
      owned.map((row) => row.tenantId),
    ]);
  }
}

/**
 * Delete tenants matched by slug, clearing what `RESTRICT` protects first.
 *
 * 🔴 **`DELETE FROM tenants WHERE slug LIKE …` stopped working the moment
 * provisioning started creating subscriptions** (F86, step 2b), because
 * `subscriptions.tenantId` is `RESTRICT`. Five suites wrote that statement by
 * hand, and all five began failing at once — some in teardown, where the error
 * names a foreign key rather than the change that caused it.
 *
 * ⚠️ **The constraint is right and stays.** A subscription whose tenant vanished
 * is an orphaned billing record, which is exactly what `RESTRICT` prevents. This
 * exists so the **sixth** suite does not rediscover the rule — the same reason
 * `deleteTenantsFor` above exists.
 */
export async function deleteTenantsBySlug(
  dataSource: DataSource,
  slugPrefix: string,
): Promise<void> {
  const like = `${slugPrefix}-%`;

  await dataSource.query(
    `DELETE FROM subscriptions WHERE tenantId IN (SELECT id FROM tenants WHERE slug LIKE ?)`,
    [like],
  );

  await dataSource.query(`DELETE FROM tenants WHERE slug LIKE ?`, [like]);
}
