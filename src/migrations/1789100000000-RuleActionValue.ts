import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The payload an action acts with (M17.4).
 *
 * 🔴 **Three of the six actions could not be expressed at all.** `OptionRule`
 * carried nine columns and none of them held a value, so a `set_price` rule had
 * **no amount to set** and a `set_default` rule **no value to write**. The
 * entity, the DTOs and `PublishedRule` all agreed with each other and all
 * omitted it — which is why nothing caught it until an evaluator was designed
 * against the shape rather than against the prose.
 *
 * ⚠️ **ADR-049 was written against the shape that does not exist.** It says a
 * `set_price` rule *"supplies the value's delta outright"*, and is tagged M17.4.
 * The reasoning it records is sound and unchanged; what it lacked was a column.
 *
 * ## Why one JSON column rather than a typed one per action
 *
 * `set_price` needs an integer of minor units. `set_default` needs whatever a
 * value key is — a string. A future action may need neither. Three nullable
 * typed columns would leave every row carrying two nulls and every reader
 * asking which one applies, and the answer is already in `action`.
 *
 * The shape is validated by a Zod schema keyed on `action`, exactly as
 * `price_config` is: `{ amountMinor }` for `set_price`, `{ valueKey }` for
 * `set_default`, and **absent** for the four that act without a payload.
 *
 * Nullable, because absence is the normal case: `show`, `hide`, `require` and
 * `unrequire` say everything in the action name. A defaulted `{}` would make
 * every existing rule carry an empty object the reader has to distinguish from a
 * missing one.
 */
export class RuleActionValue1789100000000 implements MigrationInterface {
  name = 'RuleActionValue1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`option_rules\` ADD \`actionValue\` json NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`option_rules\` DROP COLUMN \`actionValue\``);
  }
}
