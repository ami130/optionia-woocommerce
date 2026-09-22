import { seedPlans } from './plans.seed';
import { runSeedCommand } from './seed-context';
import { seedSuperAdmin } from './super-admin.seed';

/**
 * Baseline data the application needs to function.
 *
 * Idempotent and safe to re-run: plans are matched on `code` and updated rather
 * than duplicated, so this is also how a limit change is applied in development.
 *
 * Distinct from `db:seed:demo`, which fabricates a merchant for development and
 * should never run anywhere real.
 */
void runSeedCommand('db:seed', async (dataSource) => {
  await seedPlans(dataSource);
  await seedSuperAdmin(dataSource);
});
