import { config as loadDotenv } from 'dotenv';

import dataSource from '../src/config/data-source';

/**
 * Sweeps tenants no suite claimed, once, after the whole run.
 *
 * ## Why this is needed at all
 *
 * Registration provisions a tenant whose **slug comes from the tenant name**,
 * not from the suite's namespace. A test registering as `Sam Merchant` or
 * `Owner` produces `sam-…` or `owner-…`, which a cleanup matching
 * `WHERE slug LIKE 'authsvc-%'` never finds. Each suite leaked a handful of
 * tenants per run.
 *
 * That was invisible until the table reached **6,900 rows**, at which point the
 * extra latency turned other suites' fixture creates into intermittent 404s —
 * a failure that looked like a product bug for several audits, moved between
 * tests, and never reproduced in isolation.
 *
 * ## Why a sweep rather than only per-suite fixes
 *
 * The per-suite cleanups were also fixed, and they remain the primary
 * mechanism. But a cleanup keyed on a name a test happens to pass is fragile by
 * construction: the next test that registers as "Acme" leaks again, silently,
 * and the cost arrives months later as flakiness nobody connects to it.
 *
 * This is deliberately conservative. It removes a tenant only when it has **no
 * members, no stores and no option sets** — pure residue, which a real tenant
 * never is — and never touches the demo seed.
 */
export default async function teardown(): Promise<void> {
  /*
   * 🔴 **Pinned here as well as in `setup-e2e.ts`, because this runs in its own
   * process.** `globalTeardown` does not load `setupFiles`, so the database
   * pinned for the suites is not pinned for the sweep — and the sweep is the
   * half that deletes. Without this it would run `DELETE FROM tenants` against
   * whatever `.env` names, which on a developer machine is the development
   * database.
   *
   * Set before `loadDotenv()`: dotenv never overwrites an existing variable, so
   * this wins over `.env` while a deliberate `DB_NAME` from CI still wins over
   * this.
   */
  process.env.DB_NAME ??= 'optionia_woo_test';
  process.env.NODE_ENV ??= 'test';

  loadDotenv();

  await dataSource.initialize();

  try {
    await dataSource.query(
      `DELETE t FROM tenants t
         LEFT JOIN tenant_members tm ON tm.tenantId = t.id
         LEFT JOIN option_sets os ON os.tenantId = t.id
         LEFT JOIN stores s ON s.tenantId = t.id
        WHERE tm.id IS NULL AND os.id IS NULL AND s.id IS NULL
          AND t.slug <> 'demo-merchant'`,
    );
  } finally {
    await dataSource.destroy();
  }
}
