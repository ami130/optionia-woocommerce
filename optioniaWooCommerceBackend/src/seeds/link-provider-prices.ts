import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { reconcileProviderPrices } from '../billing/provider-prices';
import { createStripeClient } from '../billing/billing.module';
import { buildDataSourceOptions } from '../config/data-source';
import { loadConfig } from '../config/env';

/**
 * `npm run billing:link-prices` — reconcile `plan_prices` with the provider.
 *
 * 🔴 **This replaces four lines of SQL typed into a terminal.** Sandbox
 * verification linked the prices by hand (K1), which meant the mapping existed
 * in exactly one database and nowhere in the repository — so CI, a new machine,
 * and live mode would each have every `providerPriceId` null, and checkout would
 * refuse to sell with no clue why.
 *
 * ## Deliberately NOT a seed
 *
 * ⚠️ `openSeedConnection` refuses to run with `NODE_ENV=production`, and rightly
 * — seeds insert fabricated data. But linking prices is exactly what live mode
 * needs, so this opens its own connection with the opposite rule: production is
 * allowed, and it is **creating** that is restricted instead.
 *
 * ## Flags
 *
 * - `--dry-run` reports what would change and writes nothing, anywhere.
 * - `--create` forces creation in live mode, which is otherwise refused.
 * - `--no-create` disables creation in test mode.
 */
async function main(): Promise<void> {
  loadDotenv();

  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const config = loadConfig();

  if (config.billing.secretKey === null) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. This command talks to the provider and cannot run without it.',
    );
  }

  /*
   * 🔴 **Live mode is detected from the key, not from NODE_ENV.** A developer
   * with a live key in a `.env` marked `development` is exactly the accident
   * this guards: the key is what decides whose account is touched.
   */
  const live = config.billing.secretKey.startsWith('sk_live_');

  /*
   * ⚠️ **The default is the safety, and the guard below is unreachable by
   * design.** In live, `create` defaults to false, so there is no path where it
   * is true without `--create` having been typed — the check exists to fail
   * loudly if someone later changes the default and forgets why it was false.
   */
  const create = argv.includes('--create')
    ? true
    : argv.includes('--no-create')
      ? false
      : !live;

  if (live && create && !argv.includes('--create')) {
    throw new Error(
      'Refusing to create in live mode without an explicit --create. ' +
        'A duplicate product in live is a support problem, not a rollback.',
    );
  }

  console.log(
    `billing:link-prices  mode=${live ? 'LIVE' : 'test'}  create=${create}  dryRun=${dryRun}`,
  );

  if (live) {
    console.log(
      '  ⚠️  This is a LIVE key. Products and prices here are what real merchants are charged.',
    );
  }

  const dataSource = new DataSource(buildDataSourceOptions(config));
  await dataSource.initialize();

  try {
    const outcome = await reconcileProviderPrices(
      dataSource,
      createStripeClient(config.billing.secretKey),
      { dryRun, create, live },
    );

    const section = (label: string, lines: readonly string[]): void => {
      if (lines.length === 0) {
        return;
      }

      console.log(`  ${label}`);
      lines.forEach((line) => console.log(`    ${line}`));
    };

    section('created', outcome.created);
    section('linked', outcome.linked);
    section('unchanged', outcome.unchanged);
    section('PROBLEMS', outcome.problems);

    if (outcome.problems.length > 0) {
      /*
       * ⚠️ **A non-zero exit, because this runs in deploy pipelines.** A price
       * that disagrees with the provider is a pricing discrepancy: reporting it
       * on stdout and exiting 0 is how it gets scrolled past.
       */
      console.error(`\n${outcome.problems.length} problem(s). Nothing was linked for those.`);
      process.exitCode = 1;

      return;
    }

    console.log('\nEvery current sellable price is linked and agrees with the provider.');
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(`billing:link-prices failed: ${(error as Error).message}`);
  process.exit(1);
});
