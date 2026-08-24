import { seedDemo } from './demo.seed';
import { runSeedCommand } from './seed-context';

/**
 * A realistic merchant for development and E2E.
 *
 * Never run this anywhere real — `openSeedConnection` refuses production, and the
 * tenant slug is one no genuine merchant would use.
 */
void runSeedCommand('db:seed:demo', async (dataSource) => {
  await seedDemo(dataSource);
});
