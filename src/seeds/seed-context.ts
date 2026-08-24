import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../config/data-source';
import { loadConfig } from '../config/env';

/**
 * Shared setup for seed commands.
 *
 * Two responsibilities: open a connection, and refuse to run somewhere it
 * should not.
 */

/**
 * Open a data source for seeding, refusing to run against production.
 *
 * A seed that can reach production is a seed that will eventually reach it — the
 * command is short, memorable, and typed from a terminal that may have the wrong
 * `.env` loaded. `db:seed:demo` in particular inserts fabricated orders, which
 * in a merchant's database is corrupt revenue data rather than a mess to clean
 * up.
 *
 * @param command Name of the calling command, used in the refusal message.
 */
export async function openSeedConnection(command: string): Promise<DataSource> {
  loadDotenv();

  const config = loadConfig();

  if (config.isProduction) {
    throw new Error(
      `${command} refuses to run with NODE_ENV=production. ` +
        `Seeds insert fabricated data; in a merchant's database that is corruption, ` +
        `not a mess to clean up.`,
    );
  }

  const dataSource = new DataSource(buildDataSourceOptions(config));
  await dataSource.initialize();

  return dataSource;
}

/** Print a one-line summary of what a seed step did. */
export function report(label: string, created: number, existing: number): void {
  const detail =
    existing > 0 ? `${created} created, ${existing} already present` : `${created} created`;

  console.log(`  ${label.padEnd(22)} ${detail}`);
}

/**
 * Run a seed command, closing the connection whatever happens.
 *
 * @param name Command name, for messages.
 * @param run  The seeding work.
 */
export async function runSeedCommand(
  name: string,
  run: (dataSource: DataSource) => Promise<void>,
): Promise<void> {
  let dataSource: DataSource | undefined;

  try {
    dataSource = await openSeedConnection(name);

    console.log(`\n${name}`);

    await run(dataSource);

    console.log('');
  } catch (error) {
    console.error(`\n${name} failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await dataSource?.destroy();
  }
}
