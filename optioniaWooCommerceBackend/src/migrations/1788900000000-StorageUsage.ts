import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-store storage reporting, and a usage row that can be written safely (M15.6).
 *
 * ## Why the store needs a column
 *
 * 🔴 **A per-tenant total cannot be written from a per-store report.**
 * `file_storage_mb` is a *tenant* limit, but a tenant may hold up to ten stores
 * and each has its own uploads table on its own disk. With one row per tenant per
 * metric, neither obvious write works:
 *
 * ```text
 * SET value = <store's figure>   -> last store to heartbeat wins; the others vanish
 * SET value = value + <figure>   -> grows without bound, once per heartbeat, forever
 * ```
 *
 * So each store's *current* figure is kept on the store, and the tenant row is
 * re-summed from those. `storageBytes` is that figure — a level, overwritten on
 * every heartbeat, never accumulated.
 *
 * Nullable, because a store that has never reported is **not** a store holding
 * zero bytes: an older plugin sends no field at all, and treating that as zero
 * would quietly shrink a tenant's measured usage the moment one store lagged
 * behind on updates.
 *
 * ## Why the usage index becomes unique
 *
 * ⚠️ **`ix_usage_tenant_metric` was not unique**, so an upsert had to be a
 * `SELECT` followed by an `INSERT` — and two stores of the same tenant
 * heartbeating at the same moment would both find nothing and both insert. A
 * tenant on the business plan has ten stores checking in daily; that race is not
 * hypothetical.
 *
 * Made unique so the write can be a single atomic `INSERT ... ON DUPLICATE KEY
 * UPDATE`. The column list is unchanged, so the index still serves every read it
 * served before.
 */
export class StorageUsage1788900000000 implements MigrationInterface {
  name = 'StorageUsage1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`stores\` ADD \`storageBytes\` bigint NULL`,
    );

    /*
     * Any duplicate rows predating the constraint would block it. There are none
     * today — nothing has ever written this table — but collapsing first makes
     * the migration safe to run against an environment that did.
     */
    await queryRunner.query(
      `DELETE u1 FROM \`usage_records\` u1
        INNER JOIN \`usage_records\` u2
           ON u1.tenantId = u2.tenantId
          AND u1.metric = u2.metric
          AND u1.periodStart = u2.periodStart
          AND u1.id > u2.id`,
    );

    /*
     * 🔴 **The new index is created before the old one is dropped, and that
     * order is not cosmetic.** `tenantId` leads `ix_usage_tenant_metric`, so
     * MySQL uses it to satisfy the foreign key to `tenants` — dropping it first
     * fails outright with `ER_DROP_INDEX_FK` (1553), measured against MySQL
     * rather than reasoned about. Creating the replacement first leaves the
     * constraint an index to rely on throughout.
     */
    await queryRunner.query(
      `CREATE UNIQUE INDEX \`uq_usage_tenant_metric\` ON \`usage_records\` (\`tenantId\`, \`metric\`, \`periodStart\`)`,
    );

    await queryRunner.query(
      `DROP INDEX \`ix_usage_tenant_metric\` ON \`usage_records\``,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Same ordering in reverse, for the same foreign-key reason.
    await queryRunner.query(
      `CREATE INDEX \`ix_usage_tenant_metric\` ON \`usage_records\` (\`tenantId\`, \`metric\`, \`periodStart\`)`,
    );

    await queryRunner.query(
      `DROP INDEX \`uq_usage_tenant_metric\` ON \`usage_records\``,
    );

    await queryRunner.query(`ALTER TABLE \`stores\` DROP COLUMN \`storageBytes\``);
  }
}
