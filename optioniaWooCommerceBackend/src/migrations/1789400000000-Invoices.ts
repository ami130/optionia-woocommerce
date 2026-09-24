import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invoices, because ADR-115 made them a compliance requirement rather than a
 * feature.
 *
 * ## Why this is not optional
 *
 * 🔴 **G3 recorded invoice history as *"an unstated choice inside a milestone
 * that reads as settled"*.** ADR-115 settled it the other way: ParseLab is
 * merchant of record (ADR-114) and collects VAT through Stripe Tax, so it must
 * be able to report **what tax it collected, for a period**. Nothing in this
 * schema stored a tax amount anywhere.
 *
 * ⚠️ **Reading invoices live from the provider is not a reporting strategy.**
 * It fails when the provider is down, it is rate limited, and a tax authority
 * asks about a quarter rather than a page. ✏️ **ADR-115 also had to be
 * corrected**: Stripe Tax calculates and collects and produces the reports a
 * return is filed from — it does not file, outside a separate product in
 * limited jurisdictions. Filing is ParseLab's, and filing needs local rows.
 *
 * ## Why a mirror rather than a source of truth
 *
 * 📌 **The provider is authoritative for what was charged; this table is a
 * queryable copy.** Reconciliation (M23.5) compares the two, and a difference
 * is a finding rather than an error to paper over — the same shape as
 * `plan_prices`, where the provider holds the Price and we hold the pin.
 *
 * ## Money
 *
 * 🔴 **`subtotalMinor` + `taxMinor` = `totalMinor`, all `bigint`**, through the
 * same transformer as every other money column here. A `decimal` would be a
 * second money representation — the mistake `plan_prices` was created to avoid
 * one table over. ⚠️ **Tax is stored separately rather than derived**: a
 * reverse-charge B2B sale has `taxMinor = 0` at a non-zero rate, and a figure
 * recomputed at read time would quietly disagree with what the customer was
 * actually charged.
 *
 * ## Idempotency
 *
 * `UNIQUE (provider, providerInvoiceId)`, matching `billing_events`. A webhook
 * is delivered more than once by design, so the second delivery must find the
 * row already there rather than write a second one and double the quarter's
 * reported tax.
 */
export class Invoices1789400000000 implements MigrationInterface {
  name = 'Invoices1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE \`invoices\` (
      \`id\` char(36) NOT NULL,
      \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      \`tenantId\` char(36) NOT NULL,
      \`subscriptionId\` char(36) NULL,
      \`provider\` varchar(32) NOT NULL,
      \`providerInvoiceId\` varchar(128) NOT NULL,
      \`status\` varchar(20) NOT NULL,
      \`currency\` char(3) NOT NULL,
      \`subtotalMinor\` bigint NOT NULL,
      \`taxMinor\` bigint NOT NULL DEFAULT '0',
      \`totalMinor\` bigint NOT NULL,
      \`taxCountry\` char(2) NULL,
      \`issuedAt\` datetime(3) NULL,
      \`paidAt\` datetime(3) NULL,
      \`hostedUrl\` varchar(500) NULL,
      UNIQUE INDEX \`uq_invoices_provider_invoice\` (\`provider\`, \`providerInvoiceId\`),
      INDEX \`ix_invoices_tenant_issued\` (\`tenantId\`, \`issuedAt\`),
      INDEX \`ix_invoices_tax_period\` (\`taxCountry\`, \`issuedAt\`),
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB`);

    /*
     * 🔴 `RESTRICT`, as `subscriptions` already uses. An invoice whose tenant
     * vanished is an unexplainable line in a tax return — the record of a charge
     * must outlive the convenience of deleting a row.
     */
    await queryRunner.query(
      'ALTER TABLE `invoices` ADD CONSTRAINT `FK_invoices_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE NO ACTION',
    );

    /*
     * ⚠️ `SET NULL`, unlike the tenant. A subscription may be removed while its
     * invoices remain reportable; losing the link is acceptable, losing the
     * invoice is not.
     */
    await queryRunner.query(
      'ALTER TABLE `invoices` ADD CONSTRAINT `FK_invoices_subscription` FOREIGN KEY (`subscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `invoices` DROP FOREIGN KEY `FK_invoices_subscription`');
    await queryRunner.query('ALTER TABLE `invoices` DROP FOREIGN KEY `FK_invoices_tenant`');
    await queryRunner.query('DROP INDEX `ix_invoices_tax_period` ON `invoices`');
    await queryRunner.query('DROP INDEX `ix_invoices_tenant_issued` ON `invoices`');
    await queryRunner.query('DROP INDEX `uq_invoices_provider_invoice` ON `invoices`');
    await queryRunner.query('DROP TABLE `invoices`');
  }
}
