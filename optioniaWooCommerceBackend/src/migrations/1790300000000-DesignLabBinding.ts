import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Designs bind to the option model (M26d.4).
 *
 * 🔴 **Two columns on two tables, because the design lives on a different row
 * per type.** An image or colour choice is a set of `option_values` and each
 * value carries its own artwork — a red swatch and a blue one print different
 * things. A free-text option has no values at all (`takesValues: false`), so its
 * design belongs on the `options` row. One column could not express both: on
 * the value, a text design would have nowhere to live; on the option, every
 * swatch in a colour picker would share one design.
 *
 * ⚠️ **Both nullable, and that is not laziness.** Null is the normal case —
 * most values carry no artwork — and a NOT NULL default would write `{}` onto
 * every existing row to mean "nothing", a shape the reader would then have to
 * tell apart from a design that genuinely has no layers yet. Nullable also
 * makes this migration safe on a populated table: no rewrite, no default to
 * backfill.
 *
 * 📌 **JSON rather than real columns, unlike ADR-015's pricing fields.** Those
 * became columns because analytics and plan limits filter on them. Nothing
 * filters on a design: it is fetched whole with its row, rendered whole, and
 * never queried by its contents — and a design holds an arbitrary list of
 * layers, which no fixed set of columns could hold.
 */
export class DesignLabBinding1790300000000 implements MigrationInterface {
  name = 'DesignLabBinding1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`option_values\` ADD \`design\` json NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE \`options\` ADD \`textDesign\` json NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`options\` DROP COLUMN \`textDesign\``);

    await queryRunner.query(
      `ALTER TABLE \`option_values\` DROP COLUMN \`design\``,
    );
  }
}
