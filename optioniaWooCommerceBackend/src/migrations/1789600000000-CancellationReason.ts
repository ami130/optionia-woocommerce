import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Why a merchant cancelled (M22.5, E4).
 *
 * ## Why the reason is ours and not the provider's
 *
 * 🔴 **M22.5 asks for "cancellation with reason capture"**, and a reason stored
 * in Stripe's metadata is readable only by whoever opens the Stripe dashboard.
 * Churn analysis is the whole point of collecting it: it has to be queryable
 * beside the plan, the tenure and the usage that preceded it, which means it
 * belongs in this database.
 *
 * ## Why it is nullable, and why that is not laziness
 *
 * ⚠️ **A merchant may cancel without saying why, and must be allowed to.** A
 * required field on the way out is a dark pattern that produces junk answers
 * from people who want the dialog gone — worse than no data, because it looks
 * like data. Null means "not given"; the column never invents a reason.
 *
 * 📌 **`varchar(500)`, not `text`.** Long enough for a real sentence, short
 * enough that the column stays inline and a paste of an entire support thread
 * is refused at validation rather than stored.
 */
export class CancellationReason1789600000000 implements MigrationInterface {
  name = 'CancellationReason1789600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `subscriptions` ADD `cancellationReason` varchar(500) NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `subscriptions` DROP COLUMN `cancellationReason`');
  }
}
