import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * At most one current price per plan, currency and interval (F165).
 *
 * 🔴 **The entity has always CLAIMED this** — *"At most one per
 * plan/currency/interval"* — and nothing enforced it. `ix_plan_prices_current`
 * is an ordinary index, so the database happily held two rows with
 * `isCurrent = 1` for the same plan. A comment is not a constraint.
 *
 * 🔴 **It is reachable, and was MEASURED rather than reasoned about.** Two
 * concurrent calls to `PlansAdminService.setPrice` both `findOne` the current
 * row — a plain read, no lock — then both retire it and both insert a
 * replacement. A probe ran exactly that against the dev database: both
 * transactions committed and the plan ended with **two current prices**. The
 * transaction never protected this; only a unique constraint can.
 *
 * ⚠️ **Why it matters beyond tidiness.** `TenantProvisioningService` and
 * `PlansAdminService` both resolve price with
 * `findOne({ where: { isCurrent: true } })`, which with two matching rows
 * returns whichever MySQL yields first. A merchant could be provisioned at the
 * wrong price, nondeterministically — the most expensive kind of billing bug,
 * because it is silent and the customer finds it on a card statement.
 *
 * ## Why a generated column
 *
 * 📌 **MySQL has no partial index**, so `UNIQUE (planId, currency, interval)
 * WHERE isCurrent` cannot be expressed. The standard shape is a column that
 * carries the key only while the row is current and is `NULL` otherwise:
 * `NULL`s do not collide in a unique index, so any number of RETIRED rows may
 * share a key while at most one current row holds it.
 *
 * ⚠️ **Retired rows must stay unconstrained, and that is the whole design.**
 * Supersession means a plan accumulates many rows per interval — the dev
 * database already holds dozens — and a naive `UNIQUE (planId, currency,
 * interval)` would forbid the history this table exists to keep.
 */
export class OneCurrentPrice1790600000000 implements MigrationInterface {
  name = 'OneCurrentPrice1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * 🔴 **Refuse to run against data that already violates it**, rather than
     * letting MySQL fail halfway through building the index with a message
     * about a duplicate key that names no plan. A migration that cannot
     * explain itself at 3am is worse than one that does not run.
     */
    const offenders: Array<{ planId: string; currency: string; interval: string; n: number }> =
      await queryRunner.query(
        `SELECT planId, currency, \`interval\`, COUNT(*) AS n
           FROM plan_prices
          WHERE isCurrent = 1
          GROUP BY planId, currency, \`interval\`
         HAVING n > 1`,
      );

    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `${o.planId} ${o.currency}/${o.interval} has ${o.n}`)
        .join('; ');

      throw new Error(
        'Cannot add the one-current-price constraint: some plans already have ' +
          `more than one current price. Retire the extras first. ${detail}`,
      );
    }

    /*
     * 📌 **`currentKey` is NULL unless the row is current.** Stored rather than
     * virtual because a unique index on a virtual column cannot be used by
     * InnoDB.
     */
    await queryRunner.query(
      'ALTER TABLE `plan_prices` ADD COLUMN `currentKey` varchar(80) ' +
        'GENERATED ALWAYS AS (' +
        "IF(`isCurrent` = 1, CONCAT(`planId`, ':', `currency`, ':', `interval`), NULL)" +
        ') STORED',
    );

    await queryRunner.query(
      'CREATE UNIQUE INDEX `uq_plan_prices_current` ON `plan_prices` (`currentKey`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `uq_plan_prices_current` ON `plan_prices`');
    await queryRunner.query('ALTER TABLE `plan_prices` DROP COLUMN `currentKey`');
  }
}
