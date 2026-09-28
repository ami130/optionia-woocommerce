import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M25.3 — which option set each choice came from (F150).
 *
 * ## Why a column rather than a join
 *
 * 🔴 **`order_selections` carries no reference to configuration at all, by
 * design.** ADR-016: an order is a historical fact and does not change because
 * configuration later did, so `optionKey` is denormalised and unconstrained —
 * Phase 4 proved the alternative, where an option deleted while it sat in a cart
 * either blocked the deletion or cascaded the order record away.
 *
 * This column follows that rule exactly: `char(36)`, nullable, **no foreign
 * key**. A merchant deleting an option set must not take last quarter's revenue
 * attribution with it.
 *
 * ## Why it is nullable, and will stay partly null forever
 *
 * ⚠️ **Nothing can backfill it.** The plugin's older per-line meta
 * (`_optionia_option_set_id`) is a **flat list** of the sets a line touched,
 * which cannot say which option belongs to which — that is the entire reason the
 * per-option key was added. So every order placed before the plugin update has a
 * null here, permanently, and "revenue per option set" carries a boundary date.
 *
 * 📌 **The same discontinuity F146's quantity fix created, on a second axis**,
 * and recorded for the same reason: rewriting financial history is worse than a
 * documented gap.
 *
 * ## Why the index is on (optionSetId, optionKey)
 *
 * M25.3 groups by set and then reports the options within it, so the leading
 * column is the filter and the second serves the grouping without a second read.
 */
export class OrderSelectionSet1789900000000 implements MigrationInterface {
  name = 'OrderSelectionSet1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`order_selections\` ADD \`optionSetId\` char(36) NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX \`ix_order_selections_set\` ON \`order_selections\` (\`optionSetId\`, \`optionKey\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`ix_order_selections_set\` ON \`order_selections\``,
    );

    await queryRunner.query(`ALTER TABLE \`order_selections\` DROP COLUMN \`optionSetId\``);
  }
}
