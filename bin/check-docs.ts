/**
 * Compare docs/DATABASE.md against the live schema.
 *
 * Exits non-zero on any disagreement, with the specific claim that failed.
 * See bin/check-docs.sh for why this exists and what it deliberately ignores.
 */
import * as fs from 'fs';
import * as path from 'path';

import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';

/** TypeORM's own bookkeeping table; not part of the documented domain. */
const NOT_A_DOMAIN_TABLE = new Set(['migrations']);

interface ForeignKey {
  table: string;
  column: string;
  deleteRule: string;
}

async function main(): Promise<void> {
  loadDotenv();

  const dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
  await dataSource.initialize();

  const failures: string[] = [];

  try {
    const [{ db }] = await dataSource.query('SELECT DATABASE() AS db');
    const docPath = path.join(__dirname, '..', 'docs', 'DATABASE.md');
    const doc = fs.readFileSync(docPath, 'utf8');

    const liveTables: string[] = (
      await dataSource.query(
        `SELECT TABLE_NAME AS t FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME`,
        [db],
      )
    )
      .map((r: { t: string }) => r.t)
      .filter((t: string) => !NOT_A_DOMAIN_TABLE.has(t));

    // Each table gets its own `### table_name` section.
    const documentedTables = [...doc.matchAll(/^### `?([a-z_]+)`?/gm)].map((m) => m[1]);

    for (const table of liveTables) {
      if (!documentedTables.includes(table)) {
        failures.push(`table \`${table}\` exists but has no section in docs/DATABASE.md`);
      }
    }

    for (const table of documentedTables) {
      if (!liveTables.includes(table)) {
        failures.push(`docs/DATABASE.md documents \`${table}\`, which no migration creates`);
      }
    }

    const liveForeignKeys: ForeignKey[] = (
      await dataSource.query(
        `SELECT r.TABLE_NAME AS t, k.COLUMN_NAME AS c, r.DELETE_RULE AS d
           FROM information_schema.REFERENTIAL_CONSTRAINTS r
           JOIN information_schema.KEY_COLUMN_USAGE k
             ON k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
            AND k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA
          WHERE r.CONSTRAINT_SCHEMA = ?`,
        [db],
      )
    ).map((r: { t: string; c: string; d: string }) => ({
      table: r.t,
      column: r.c,
      deleteRule: r.d,
    }));

    // A foreign key with no declared rule silently becomes RESTRICT, which is
    // how GDPR user erasure becomes impossible without any migration failing.
    for (const fk of liveForeignKeys) {
      if (fk.deleteRule === 'NO ACTION') {
        failures.push(
          `${fk.table}.${fk.column} has no ON DELETE rule (MySQL reports NO ACTION)`,
        );
      }
    }

    // The document writes columns in snake_case; the schema uses camelCase.
    // Comparing them literally matches nothing, which is how the first version
    // of this check reported success while verifying zero rules.
    const normalise = (column: string): string => column.toLowerCase().replace(/_/g, '');

    const claims = [
      ...doc.matchAll(
        /^([a-z_]+)\.([a-z_]+)\s*→[^\n]*?ON DELETE (CASCADE|SET NULL|RESTRICT)/gm,
      ),
    ];

    let checked = 0;

    for (const [, table, column, claimed] of claims) {
      const live = liveForeignKeys.find(
        (fk) => fk.table === table && normalise(fk.column) === normalise(column),
      );

      if (!live) {
        failures.push(
          `docs/DATABASE.md states a rule for ${table}.${column}, which is not a foreign key in the schema`,
        );
        continue;
      }

      checked += 1;

      if (live.deleteRule !== claimed) {
        failures.push(
          `${table}.${column}: docs/DATABASE.md says ON DELETE ${claimed}, schema has ${live.deleteRule}`,
        );
      }
    }

    // A check that silently verifies nothing is worse than no check: it reports
    // success and stops anyone looking. This one has already done that once.
    if (checked < liveForeignKeys.length) {
      failures.push(
        `only ${checked} of ${liveForeignKeys.length} foreign keys have a stated rule in ` +
          `docs/DATABASE.md; every foreign key needs one so this check can verify it`,
      );
    }

    // Soft delete uses a sentinel, not NULL: a unique index over a nullable
    // column enforces nothing, because NULL != NULL in MySQL (ADR-014).
    const [{ n: nullableDeletedAt }] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'deletedAt' AND IS_NULLABLE = 'YES'`,
      [db],
    );

    if (Number(nullableDeletedAt) > 0) {
      failures.push(
        `${nullableDeletedAt} deletedAt column(s) are nullable; the sentinel design (ADR-014) requires NOT NULL`,
      );
    }

    if (failures.length > 0) {
      console.error('\ndocs/DATABASE.md disagrees with the schema:\n');
      failures.forEach((f) => console.error(`  ✗ ${f}`));
      console.error('');
      process.exitCode = 1;

      return;
    }

    console.log(
      `All doc checks passed. ${liveTables.length} tables, ` +
        `${liveForeignKeys.length} foreign keys, ${checked} stated delete rules.`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(`\ncheck-docs failed to run: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
