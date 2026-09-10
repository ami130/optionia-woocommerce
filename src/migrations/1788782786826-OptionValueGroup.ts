import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `<optgroup>` labels for dropdown values (M14.3).
 *
 * The last outstanding entry in M14.3's list, and deliberately **not a new
 * type**: grouping is a rendering detail of `dropdown`, not a different question
 * asked of a customer. Registering `dropdown_grouped` would give merchants two
 * ways to describe one thing — the opposite of what the three-axis model is for.
 *
 * Nullable rather than defaulted to `''`. A value with no group is the normal
 * case and must render as a plain `<option>`; an empty-string default would make
 * every existing value a member of one nameless group, which is a different
 * document for every set already published.
 *
 * 200 characters matches `label` — a group heading is the same kind of text, and
 * a shorter cap would be an arbitrary second rule for merchants to discover.
 */
export class OptionValueGroup1788782786826 implements MigrationInterface {
  name = 'OptionValueGroup1788782786826';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`option_values\` ADD \`groupLabel\` varchar(200) NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`option_values\` DROP COLUMN \`groupLabel\``);
  }
}
