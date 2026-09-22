import { execFileSync } from 'node:child_process';

import { DB } from './fixtures';

/**
 * Remove what previous runs left behind.
 *
 * ## Why this is needed
 *
 * The canonical flow starts at *"a merchant registers"*, so every run creates a
 * tenant, a user, a store and an option set — and nothing removed them.
 * Measured after roughly sixteen runs: **32 tenants, 32 users, 11 stores** in
 * the shared development database, growing without bound.
 *
 * That is not merely untidy. It leaves **live store credentials** for a site
 * that has forgotten them — nine of them at the point this was written, one per
 * run — which is precisely the state an authentication suite should be proving
 * impossible rather than manufacturing. The in-flow disconnect stops new ones
 * accruing; this clears the backlog.
 *
 * ## Why it runs before, not after
 *
 * A failed run's data is worth keeping: it is the evidence. Cleaning at the
 * start of the *next* run means a failure can be inspected while the next run
 * still begins from a known floor.
 *
 * ## Why it is narrow
 *
 * It matches only what this suite creates — `e2e-…@optionia.test` addresses and
 * the tenants they own. A cleanup that took a broader swing at a development
 * database, on a machine where the demo seed and hand-made data also live, would
 * be a worse problem than the one it solves.
 */
export function cleanupPreviousRuns(): void {
  const statements = [
    /*
     * Order matters: `stores` and `option_sets` are RESTRICT against `tenants`,
     * so the tenant cannot go first. Everything under a store cascades from it.
     */
    `DELETE oe FROM order_events oe
       JOIN stores s ON s.id = oe.storeId
       JOIN tenants t ON t.id = s.tenantId
      WHERE t.name LIKE 'E2E Workspace %'`,

    `DELETE s FROM stores s
       JOIN tenants t ON t.id = s.tenantId
      WHERE t.name LIKE 'E2E Workspace %'`,

    `DELETE os FROM option_sets os
       JOIN tenants t ON t.id = os.tenantId
      WHERE t.name LIKE 'E2E Workspace %'`,

    `DELETE ims FROM impersonation_sessions ims
       JOIN tenants t ON t.id = ims.tenantId
      WHERE t.name LIKE 'E2E Workspace %'`,

    `DELETE sub FROM subscriptions sub
       JOIN tenants t ON t.id = sub.tenantId
      WHERE t.name LIKE 'E2E Workspace %'`,

    `DELETE FROM tenants WHERE name LIKE 'E2E Workspace %'`,

    /* Users last: a membership cascades from the tenant, the user does not. */
    `DELETE FROM users WHERE email LIKE 'e2e-%@optionia.test'`,
  ];

  for (const sql of statements) {
    run(sql);
  }
}

/** How many rows this suite has left in the database. */
export function residue(): number {
  const output = run(
    `SELECT (SELECT COUNT(*) FROM tenants WHERE name LIKE 'E2E Workspace %') +
            (SELECT COUNT(*) FROM users   WHERE email LIKE 'e2e-%@optionia.test')`,
  );

  return Number(output.trim().split('\n').pop() ?? 0);
}

function run(sql: string): string {
  return execFileSync(
    'mysql',
    [`-h${DB.host}`, `-P${DB.port}`, `-u${DB.user}`, `-p${DB.password}`, DB.name, '-N', '-e', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
}
