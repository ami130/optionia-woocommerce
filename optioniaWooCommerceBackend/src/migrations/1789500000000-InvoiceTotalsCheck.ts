import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The invoice's own arithmetic, enforced by the database.
 *
 * ## Why a constraint and not a comment
 *
 * 🔴 **`subtotalMinor + taxMinor = totalMinor` was stated in a docblock and
 * enforced by nothing (F92/D2).** No `CHECK`, and the four reporting tests
 * never compared the three columns — their fixture happened to be consistent,
 * so a provider adapter writing an inconsistent total would have passed every
 * one of them. The failure would then surface as a **tax return that does not
 * reconcile against the bank**, months later, with no test to point at.
 *
 * ⚠️ **Added BEFORE the adapter that writes these rows, deliberately.** Writing
 * the adapter first and constraining afterwards means the constraint gets shaped
 * around whatever the adapter happened to emit — which is how a schema ends up
 * documenting a bug rather than preventing one.
 *
 * ## Why this is safe for refunds
 *
 * 📌 **The columns are signed `bigint`, and the check is an equality rather than
 * a positivity test.** A credit note is `-2900 + -609 = -3509`, which satisfies
 * it; requiring non-negative amounts would have made refunds unstorable and is
 * exactly the over-constraint this avoids.
 *
 * ⚠️ **MySQL enforces `CHECK` from 8.0.16.** On anything older it is parsed and
 * ignored, which would make this a comment with extra steps — so the e2e test
 * asserts a violating row is **refused**, rather than trusting the DDL to mean
 * something.
 */
export class InvoiceTotalsCheck1789500000000 implements MigrationInterface {
  name = 'InvoiceTotalsCheck1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `invoices` ADD CONSTRAINT `ck_invoices_totals` ' +
        'CHECK (`totalMinor` = `subtotalMinor` + `taxMinor`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `invoices` DROP CONSTRAINT `ck_invoices_totals`');
  }
}
