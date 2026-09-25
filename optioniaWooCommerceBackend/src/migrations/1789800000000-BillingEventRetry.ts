import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M23.4 — what a retry needs to know, and when to stop (F123).
 *
 * ## Why these two columns and not a second table
 *
 * 🔴 **A `dead_letter_events` table would duplicate every event column** —
 * `payload`, `type`, `providerEventId` — and split one event's history across
 * two places, so answering *"what happened to this event?"* would mean checking
 * both. It would also sit outside the `UNIQUE provider_event_id` that makes
 * redelivery a no-op (M23.2), which is the one guarantee this table exists for.
 *
 * 📌 **Two nullable columns express the same states with no duplication**:
 * `attempts` counts what we have tried, `deadAt` records that we stopped.
 *
 * ## What each state means
 *
 * | `processedAt` | `deadAt` | meaning |
 * |---|---|---|
 * | set | null | finished |
 * | null | null | retryable — the worker will pick it up |
 * | null | set | given up on; **never retried**, Phase 26 renders it |
 *
 * ⚠️ **`attempts` defaults to 0, not 1.** A row is written *before* it is
 * processed (N1's ordering), so at insert time nothing has been attempted yet.
 * Defaulting to 1 would make the first failure look like the second and bring
 * the give-up limit forward by one.
 */
export class BillingEventRetry1789800000000 implements MigrationInterface {
  name = 'BillingEventRetry1789800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `billing_events` ADD `attempts` int NOT NULL DEFAULT 0',
    );

    await queryRunner.query(
      'ALTER TABLE `billing_events` ADD `deadAt` datetime(3) NULL',
    );

    /*
     * 📌 **Composite, and in this order.** The worker's query is
     * `WHERE processedAt IS NULL AND deadAt IS NULL` — the retryable set. MySQL
     * can use a leading `processedAt` index for it, but scanning every
     * unprocessed row to discard the dead ones gets worse precisely as
     * dead-lettered events accumulate, which is the one direction this table
     * only grows in.
     *
     * ⚠️ The existing `ix_billing_events_unprocessed` is left in place: it
     * still serves *"which events never finished"*, dead ones included, which
     * is the question an operator asks and this new index would answer wrongly.
     */
    await queryRunner.query(
      'CREATE INDEX `ix_billing_events_retryable` ON `billing_events` (`processedAt`, `deadAt`)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `ix_billing_events_retryable` ON `billing_events`');
    await queryRunner.query('ALTER TABLE `billing_events` DROP COLUMN `deadAt`');
    await queryRunner.query('ALTER TABLE `billing_events` DROP COLUMN `attempts`');
  }
}
