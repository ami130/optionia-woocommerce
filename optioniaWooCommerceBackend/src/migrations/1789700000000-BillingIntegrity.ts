import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two invariants the audit found asserted and unenforced (N1, N5).
 *
 * ## Finding unfinished work
 *
 * 🔴 **`billing_events.processedAt IS NULL` had no index, and nothing queried
 * it.** The webhook service's own docblock called such a row *"a visible,
 * queryable 'started and did not finish'"* — visible to nobody. A claimed event
 * whose handler threw sat there permanently, and because the retry was answered
 * "already handled" (N1), it was never completed either.
 *
 * ⚠️ **The index is what makes the recovery query cheap enough to run often.**
 * M23.4's dead-letter view is a scan of exactly this predicate, and a table that
 * grows with every provider event is the wrong thing to scan without one.
 *
 * ## One subscription per tenant
 *
 * 🔴 **`SubscriptionLifecycleService.findSubscription` falls back to matching on
 * `providerCustomerId`, and that is only safe if a tenant holds one
 * subscription** — otherwise `findOne` picks an arbitrary row and a webhook
 * updates the wrong one. Provisioning creates exactly one and every path
 * mutates it in place, so the constraint records what the code already assumes.
 *
 * ⚠️ **Asserted in a comment until now** (H5), which is the defect class this
 * phase has produced more than any other: an invariant held by convention reads
 * exactly like one held by the schema, right up until someone adds a second row.
 */
export class BillingIntegrity1789700000000 implements MigrationInterface {
  name = 'BillingIntegrity1789700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * 📌 **Indexed on `processedAt` alone, not a composite.** The query is
     * "which events never finished", and a provider column would only help if
     * the answer differed per provider — it does not, and a narrower index is
     * cheaper on the write path that every webhook takes.
     */
    await queryRunner.query(
      'CREATE INDEX `ix_billing_events_unprocessed` ON `billing_events` (`processedAt`)',
    );

    await queryRunner.query(
      'ALTER TABLE `subscriptions` ADD UNIQUE INDEX `uq_subscriptions_tenant` (`tenantId`)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `subscriptions` DROP INDEX `uq_subscriptions_tenant`',
    );
    await queryRunner.query('DROP INDEX `ix_billing_events_unprocessed` ON `billing_events`');
  }
}
