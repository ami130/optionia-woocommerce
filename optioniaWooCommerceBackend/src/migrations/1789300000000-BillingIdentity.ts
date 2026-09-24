import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What billing needs before a single Stripe call can be made (Phase 22, step 1).
 *
 * ## Why one migration and not five
 *
 * 📌 The Phase 22 audit found five schema gaps — a mutable plan reference (G1),
 * no provider customer (G7), single-currency plans (G9), and no tax location
 * (G10). They are **one** change: plan ownership, the customer a portal session
 * needs, the currency an invoice is denominated in, and the country a tax engine
 * computes against all describe the same moment. Migrating billing tables three
 * times to add them separately is how a live billing schema acquires the kind of
 * drift nobody dares correct later.
 *
 * ## Why this migration only ADDS
 *
 * 🔴 **`tenants.planId` stays, and the audit was half wrong about why.** G6
 * recorded *"the plan is stored twice, and nothing reads either"*. Reading the
 * **writers** instead: `tenant-provisioning.service.ts` and `demo.seed.ts` both
 * write it, and **no subscription row is ever created anywhere** — `create(
 * Subscription` and `save(Subscription` return nothing across the backend. So
 * `tenants.planId` is not a duplicate; it is the only plan reference that
 * exists, and dropping it here would leave a new tenant with no plan at all.
 *
 * The subscription becomes the owner in a later step, once provisioning creates
 * one — a code change guarded by tests, not a migration that silently drops
 * state a running system depends on.
 *
 * ## `plan_prices`, and the defect it exists to prevent
 *
 * 🔴 **Editing a price must not re-price people who already bought.** Plans are
 * merchant-editable by decision (M22.1a), and `subscriptions.planId` points at a
 * mutable row — so today an edit would change what every existing subscriber
 * pays, which they would discover on a card statement. A price is therefore an
 * **immutable version**: editing writes a new row, existing subscriptions stay
 * pinned to the one they bought, and new signups take the current one. This is
 * how Stripe models prices, which also keeps the provider mapping honest.
 *
 * ⚠️ **`amountMinor` is `bigint`**, matching `plans.priceMonthlyMinor` and the
 * money transformer already used across this schema. A `decimal` here would be a
 * second money representation, and two are how rounding disagreements start.
 *
 * ## Nullable, deliberately
 *
 * `country`, `vatNumber` and `billingCurrency` are nullable because a free-tier
 * tenant has no billing identity and is not asked for one (B9: collected at
 * first paid checkout, so signup stays free of a tax form). ⚠️ A `NOT NULL`
 * here would force a default country on every existing tenant — inventing a tax
 * location is worse than having none.
 */
export class BillingIdentity1789300000000 implements MigrationInterface {
  name = 'BillingIdentity1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * ISO 3166-1 alpha-2, so `char(2)`: the length is the validation. A tax
     * engine keys on exactly this, and a longer column would invite country
     * *names*, which no tax engine accepts.
     */
    await queryRunner.query(
      "ALTER TABLE `tenants` ADD `country` char(2) NULL COMMENT 'ISO 3166-1 alpha-2, for tax location (B9)'",
    );

    /*
     * EU VAT ids reach 14 characters; 32 leaves room for the non-EU schemes a
     * merchant of record eventually meets without a second migration.
     */
    await queryRunner.query('ALTER TABLE `tenants` ADD `vatNumber` varchar(32) NULL');

    /*
     * ISO 4217, `char(3)`, matching `plans.currency`. On the tenant because a
     * subscription is denominated once and must not change currency under the
     * merchant mid-term.
     */
    await queryRunner.query('ALTER TABLE `tenants` ADD `billingCurrency` char(3) NULL');

    /*
     * 🔴 The customer, not the subscription. A billing portal session, a saved
     * payment method and invoice history all key on the **customer** — so
     * `providerSubscriptionId` alone cannot open a portal, which is what M22.5
     * promises (G7).
     */
    await queryRunner.query(
      'ALTER TABLE `subscriptions` ADD `providerCustomerId` varchar(128) NULL',
    );

    await queryRunner.query(`CREATE TABLE \`plan_prices\` (
      \`id\` char(36) NOT NULL,
      \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      \`planId\` char(36) NOT NULL,
      \`currency\` char(3) NOT NULL,
      \`interval\` varchar(10) NOT NULL,
      \`amountMinor\` bigint NOT NULL,
      \`providerPriceId\` varchar(128) NULL,
      \`isCurrent\` tinyint NOT NULL DEFAULT 1,
      \`retiredAt\` datetime(3) NULL,
      INDEX \`ix_plan_prices_current\` (\`planId\`, \`currency\`, \`interval\`, \`isCurrent\`),
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB`);

    /*
     * `RESTRICT`, as `subscriptions` already uses for its plan: a price a
     * subscription is pinned to must not vanish underneath it. Retirement is
     * `retiredAt`, not deletion — the row is what an old invoice was priced by.
     */
    await queryRunner.query(
      'ALTER TABLE `plan_prices` ADD CONSTRAINT `FK_plan_prices_plan` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    );

    /*
     * 🔴 The pin itself. Nullable because every subscription that exists today
     * predates versioning — and because a free subscription has no price at all,
     * which is a real state rather than missing data.
     */
    await queryRunner.query('ALTER TABLE `subscriptions` ADD `planPriceId` char(36) NULL');

    await queryRunner.query(
      'ALTER TABLE `subscriptions` ADD CONSTRAINT `FK_subscriptions_plan_price` FOREIGN KEY (`planPriceId`) REFERENCES `plan_prices`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `subscriptions` DROP FOREIGN KEY `FK_subscriptions_plan_price`',
    );
    await queryRunner.query('ALTER TABLE `subscriptions` DROP COLUMN `planPriceId`');
    await queryRunner.query('ALTER TABLE `plan_prices` DROP FOREIGN KEY `FK_plan_prices_plan`');
    await queryRunner.query('DROP INDEX `ix_plan_prices_current` ON `plan_prices`');
    await queryRunner.query('DROP TABLE `plan_prices`');
    await queryRunner.query('ALTER TABLE `subscriptions` DROP COLUMN `providerCustomerId`');
    await queryRunner.query('ALTER TABLE `tenants` DROP COLUMN `billingCurrency`');
    await queryRunner.query('ALTER TABLE `tenants` DROP COLUMN `vatNumber`');
    await queryRunner.query('ALTER TABLE `tenants` DROP COLUMN `country`');
  }
}
