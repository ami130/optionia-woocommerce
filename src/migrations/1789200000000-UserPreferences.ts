import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a person's dashboard preferences live (M20b.2, ADR-088).
 *
 * The setup checklist is *"persistent, dismissible"*, and there was nowhere to
 * persist that: **32 tables, none of them preferences**, and no spare column on
 * `users` or `tenant_members`.
 *
 * ## Why a table rather than the browser
 *
 * A dismissal in `localStorage` does not follow the merchant to another device,
 * and [M20b.6](../../../developePlan.md)'s unsubscribe preference needs the same
 * surface — so it is built once. `localStorage` stays right for per-view
 * conveniences; a preference that outlives the view is not one.
 *
 * ## Why keyed on the user
 *
 * A colleague invited next month has not done their first run and must see their
 * own checklist, so a tenant-level flag would hide it from someone who has never
 * seen it. ⚠️ **No `tenantId` column, deliberately** — a preference belongs to
 * the person, not the workspace, and someone in two tenants dismisses once.
 *
 * `UNIQUE` on `userId`: one row per person, so a read is a lookup rather than a
 * "latest wins" scan, and a double-write cannot leave two disagreeing rows.
 *
 * `CASCADE` on delete: unlike a store or an option set, nothing is lost by
 * deleting a UI convenience along with its owner.
 */
export class UserPreferences1789200000000 implements MigrationInterface {
  name = 'UserPreferences1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`user_preferences\` (
         \`id\` char(36) NOT NULL,
         \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         \`userId\` char(36) NOT NULL,
         \`checklistDismissedAt\` datetime(3) NULL,
         UNIQUE INDEX \`uq_user_preferences_user\` (\`userId\`),
         PRIMARY KEY (\`id\`)
       ) ENGINE=InnoDB`,
    );

    await queryRunner.query(
      `ALTER TABLE \`user_preferences\`
         ADD CONSTRAINT \`fk_user_preferences_user\`
         FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`)
         ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`user_preferences\` DROP FOREIGN KEY \`fk_user_preferences_user\``,
    );
    await queryRunner.query(`DROP TABLE \`user_preferences\``);
  }
}
