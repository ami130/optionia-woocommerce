import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M25.4 — which product each choice was bought against (F151).
 *
 * ## Why this column sits beside `optionSetId` rather than on `order_events`
 *
 * 🔴 **One order has many line items, each a different product.** `get_items()`
 * is a loop, and `line_selections()` runs per item — so a product reference on
 * `order_events` could only ever name one of them, and would attribute a
 * three-product order's whole option revenue to whichever product happened to
 * be first. The grain of the question is the selection, which is the grain
 * `optionSetId` already uses for the same reason (F150).
 *
 * ## Why no foreign key, and why it will stay partly null forever
 *
 * ⚠️ **No foreign key, deliberately, and this is ADR-016 rather than an
 * omission.** An order is a historical fact and does not change because the
 * catalogue later did. A merchant deleting a product must not take last
 * quarter's revenue attribution with it — and Phase 4 proved the alternative,
 * where a deleted option either blocked the delete or cascaded the order away.
 *
 * ⚠️ **Nothing can backfill it**, exactly as with `optionSetId`. WooCommerce
 * holds the product on the line item, and an order already reported carries no
 * record of which line each selection came from. So every order placed before
 * the plugin update has a null here permanently, and "revenue per product"
 * carries a boundary date the merchant is told about rather than discovers.
 *
 * 📌 **The third such discontinuity**, after F146's quantity fix and F150's set
 * attribution, and recorded for the same reason each time: rewriting financial
 * history is worse than a documented gap.
 *
 * ## Why `varchar(64)` and not `char(36)`
 *
 * 🔴 **A WooCommerce product id is an integer, not a UUID.** `optionSetId` is
 * `char(36)` because Optionia mints UUIDs; this value comes from the merchant's
 * own WordPress install, where ids are auto-increment integers — and a
 * variation id, which is what a variable product reports, is a different
 * integer again. It is stored as text because it identifies a row in a database
 * this system does not own: arithmetic on it would be meaningless, and a
 * merchant migrating stores can produce ids that no longer fit an assumption
 * about range.
 *
 * ## Why the index leads with `productRef`
 *
 * The question is *"what did options earn on THIS product?"*, so the product is
 * the filter and `optionKey` serves the grouping within it without a second
 * read — the same shape as `ix_order_selections_set`.
 */
export class OrderSelectionProduct1790000000000 implements MigrationInterface {
  name = 'OrderSelectionProduct1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`order_selections\` ADD \`productRef\` varchar(64) NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX \`ix_order_selections_product\` ON \`order_selections\` (\`productRef\`, \`optionKey\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`ix_order_selections_product\` ON \`order_selections\``,
    );

    await queryRunner.query(
      `ALTER TABLE \`order_selections\` DROP COLUMN \`productRef\``,
    );
  }
}
