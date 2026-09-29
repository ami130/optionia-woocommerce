import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M25.1 — how many customers saw each option (stage 25-4).
 *
 * ## Why counts and not events
 *
 * 🔴 **A view is every product page load, and an order is one per fifty of
 * them.** Storing a row per view would put the busiest table in this system on
 * the merchant's own traffic rather than their sales — millions of rows to
 * answer a question that needs a number. The plugin aggregates before sending,
 * so one store's day is one row per option however many customers looked.
 *
 * ## Why the unique key is the whole design
 *
 * 🔴 **`(storeId, optionSetId, optionKey, day)` is UNIQUE so the write is an
 * UPSERT**, and that is what makes a retried batch safe. The plugin drains on
 * cron; a drain that timed out after writing would otherwise double a
 * merchant's view count on every retry, and a conversion rate built on it would
 * halve. `ON DUPLICATE KEY UPDATE views = views + VALUES(views)` is correct
 * **only** because the plugin sends a delta it then clears — see
 * `ViewsController` for the reasoning, which is the part a reviewer should
 * distrust first.
 *
 * ## Why `day` is a DATE and not a timestamp
 *
 * ⚠️ **The question is "how many saw this", never "at 14:32".** A timestamp
 * would multiply the rows by the number of distinct instants and answer nothing
 * extra. A day is also the smallest grain that cannot identify a person: one
 * customer's visit is indistinguishable from another's inside it, which is what
 * keeps this outside personal data entirely (M25.6).
 *
 * ⚠️ **Stored as the STORE's day, not UTC's.** A shop in Auckland sees its
 * traffic split across two UTC dates every evening, and a merchant comparing
 * "today" against "yesterday" would be comparing the wrong halves. The plugin
 * sends the date it computed locally.
 *
 * ## Why no foreign key to `option_sets`
 *
 * ADR-016, the same rule `order_selections` follows: a view is a historical
 * fact and does not change because configuration later did. A merchant deleting
 * an option set must not take last quarter's view counts with it — and Phase 4
 * proved the alternative, where a delete either blocks or cascades the history
 * away.
 */
export class OptionViewCounts1790100000000 implements MigrationInterface {
  name = 'OptionViewCounts1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`option_view_counts\` (
        \`id\` char(36) NOT NULL,
        \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        \`storeId\` char(36) NOT NULL,
        \`optionSetId\` char(36) NOT NULL,
        \`optionKey\` varchar(64) NOT NULL,
        \`day\` date NOT NULL,
        \`views\` int UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_option_view_counts\` (\`storeId\`, \`optionSetId\`, \`optionKey\`, \`day\`),
        KEY \`ix_option_view_counts_day\` (\`storeId\`, \`day\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    /*
     * ⚠️ **`storeId` IS a foreign key, unlike `optionSetId`.** A store is the
     * tenancy boundary — a row whose store vanished belongs to nobody and could
     * never be read back through any query in this system, so orphaning it is
     * not preserving history, it is leaking rows. `CASCADE` because
     * disconnecting a store is the merchant's own act.
     */
    await queryRunner.query(`
      ALTER TABLE \`option_view_counts\`
        ADD CONSTRAINT \`fk_option_view_counts_store\`
        FOREIGN KEY (\`storeId\`) REFERENCES \`stores\` (\`id\`) ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`option_view_counts\``);
  }
}
