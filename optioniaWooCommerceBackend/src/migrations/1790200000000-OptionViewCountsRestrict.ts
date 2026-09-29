import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `option_view_counts.storeId` becomes RESTRICT (M25.1, corrected).
 *
 * 🔴 **The first version was CASCADE, and documenting it is what exposed the
 * mistake.** `DATABASE.md` already records why `order_events.store_id` is
 * `RESTRICT`: *"disconnecting a store must not silently take its revenue
 * history with it"*. View counts are not revenue — but they are the
 * **denominator of a conversion rate**, so losing them is worse than losing a
 * number: every comparison drawn afterwards is silently wrong rather than
 * visibly absent.
 *
 * ⚠️ **A merchant who disconnects and reconnects a store is the ordinary case**,
 * not a rare one — a migration, a staging swap, a support fix. Under `CASCADE`
 * their option views vanish while their orders survive, so conversion would read
 * as *infinite* for every option: divide by zero on a shop that plainly has
 * traffic.
 *
 * 📌 **Written as its own migration rather than by editing the first.** The
 * original has already run on two databases here and would be re-run nowhere,
 * so rewriting it would leave a schema no migration describes — the defect this
 * project keeps meeting, one layer down.
 */
export class OptionViewCountsRestrict1790200000000 implements MigrationInterface {
  name = 'OptionViewCountsRestrict1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`option_view_counts\` DROP FOREIGN KEY \`fk_option_view_counts_store\``,
    );

    await queryRunner.query(`
      ALTER TABLE \`option_view_counts\`
        ADD CONSTRAINT \`fk_option_view_counts_store\`
        FOREIGN KEY (\`storeId\`) REFERENCES \`stores\` (\`id\`) ON DELETE RESTRICT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`option_view_counts\` DROP FOREIGN KEY \`fk_option_view_counts_store\``,
    );

    await queryRunner.query(`
      ALTER TABLE \`option_view_counts\`
        ADD CONSTRAINT \`fk_option_view_counts_store\`
        FOREIGN KEY (\`storeId\`) REFERENCES \`stores\` (\`id\`) ON DELETE CASCADE
    `);
  }
}
