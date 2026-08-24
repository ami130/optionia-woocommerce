import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource, type DataSourceOptions } from 'typeorm';

import { loadConfig } from './env';

/**
 * TypeORM data source.
 *
 * Serves two callers with different needs, which is why it exports both a
 * factory and a default instance:
 *
 *  - The **TypeORM CLI** runs outside Nest, so it needs a ready-made
 *    `DataSource` and must load `.env` itself. That is the default export.
 *  - The **application** builds its options from the already-validated config
 *    object during bootstrap, via `buildDataSourceOptions()`.
 *
 * Both paths go through `loadConfig()`, so there is exactly one place where an
 * environment variable is read and validated.
 */

/**
 * Build TypeORM options from validated configuration.
 *
 * @param config Validated application configuration.
 */
export function buildDataSourceOptions(config: ReturnType<typeof loadConfig>): DataSourceOptions {
  return {
    type: 'mysql',
    host: config.database.host,
    port: config.database.port,
    username: config.database.user,
    password: config.database.password,
    database: config.database.name,

    // Discovered by glob rather than an explicit list, so adding an entity does
    // not require editing this file. `.js` covers the compiled build, `.ts` the
    // CLI running through ts-node.
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../migrations/*{.ts,.js}'],

    /**
     * Never true, in any environment — including local.
     *
     * `synchronize` alters tables to match entities on boot. It is convenient
     * for a day and then silently drops a column when an entity changes.
     * Migrations are the only mechanism by which schema changes here.
     */
    synchronize: false,

    /**
     * Also never true. Dropping the schema on connect is a foot-gun with no
     * legitimate use in a project that has seed data.
     */
    dropSchema: false,

    migrationsTableName: 'migrations',

    // Queries are noisy; errors and slow queries are the useful signal.
    logging: config.isProduction ? ['error', 'warn'] : ['error', 'warn', 'schema'],
    maxQueryExecutionTime: 1000,

    ssl: config.database.ssl ? { rejectUnauthorized: true } : undefined,

    extra: {
      // utf8mb4 throughout. MySQL's "utf8" is three-byte and cannot store an
      // emoji, so a merchant naming an option "🎁 Gift wrap" would hit a
      // truncation error.
      charset: 'utf8mb4_unicode_ci',
      connectionLimit: 10,
    },
  };
}

/**
 * Default instance for the TypeORM CLI.
 *
 * The CLI runs standalone, so `.env` is loaded here. `loadConfig()` still
 * validates it — a CLI invocation with missing configuration fails immediately
 * rather than connecting somewhere unintended.
 */
loadDotenv();

export default new DataSource(buildDataSourceOptions(loadConfig()));
