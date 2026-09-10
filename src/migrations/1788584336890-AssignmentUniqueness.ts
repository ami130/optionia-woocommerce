import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One assignment per set, per target (Phase 13 Stage 0, finding **A1**).
 *
 * `option_set_assignments` carried two plain indexes and nothing unique, so the
 * same option set could be assigned to the same product any number of times.
 *
 * The storefront survived it — `Config\ProductIndex` keys by
 * `$products[$product_id][$set_id]`, so duplicates collapse on read. **The
 * merchant did not**: [M13.6](../../developePlan.md)'s picker would list the set
 * twice, and unassigning would delete one row while the option kept rendering.
 * That is a support ticket shaped exactly like the duplicate-store one this
 * architecture was built to avoid.
 *
 * ## Why a database constraint rather than a check in the service
 *
 * The picker is a UI where a double submit is ordinary — a slow network and an
 * impatient click. Two requests racing both pass a `SELECT`-then-`INSERT`
 * check, and one of them writes the duplicate. Only the database can decide
 * this, and it decides it once for every caller.
 *
 * ## Why `deletedAt` is part of the key
 *
 * Assignments are soft-deletable (ADR-014), so an unassigned row stays in the
 * table with `deletedAt` set to the moment it was removed. Without that column
 * in the key, re-assigning a product a merchant had previously unassigned would
 * collide with the tombstone and fail. Every other unique index on a
 * soft-deletable table here does the same — `uq_options_group_key`,
 * `uq_option_values_option_key`, `uq_option_sets_...`.
 *
 * Live rows share the sentinel `1970-01-01 00:00:00.000`, so uniqueness among
 * them is exactly what the constraint enforces.
 *
 * ## Scope
 *
 * `MANUAL` and `CONDITIONAL` assignments name a target and are covered. An
 * `ALL` assignment has `targetType` and `targetRef` NULL, and **MySQL treats
 * NULLs as distinct in a unique index** — so this does not prevent a set being
 * assigned to "all products" twice. That is deliberate: preventing it needs
 * either a generated column or application logic, and M13.6 does not author
 * `ALL` assignments. Recorded so the limit is known rather than assumed.
 *
 * Verified before applying: zero duplicate groups across 16 existing rows.
 */
export class AssignmentUniqueness1788584336890 implements MigrationInterface {
  name = 'AssignmentUniqueness1788584336890';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX \`uq_assignments_set_target\`
         ON \`option_set_assignments\` (\`optionSetId\`, \`targetType\`, \`targetRef\`, \`deletedAt\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`uq_assignments_set_target\` ON \`option_set_assignments\``,
    );
  }
}
