import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The cloud's record of a print file it was asked to make (M26e.4).
 *
 * 🔴 **A job table, because Decision 2 chose asynchronous rendering.** A
 * synchronous render was ruled out on measured numbers — 8 s, 20 s, 5 MB — and
 * the customer has already checked out by the time the file matters. The
 * plugin asks, the cloud answers "accepted", and the work happens where the
 * fonts, the memory and the CPU are.
 *
 * 🔴 **A foreign key to `stores`, `ON DELETE RESTRICT` — and the first draft had
 * none, which a schema test caught.** ADR-016 is about CONFIGURATION outliving
 * an order, not about tenancy: `order_selections` carries no key to `options`
 * for that reason, while `order_events` and `option_view_counts` both key to
 * the store. Every table must reach a tenant or be exempted with a reason, and
 * a render job reaching none would be artwork nobody owns.
 *
 * ⚠️ **`RESTRICT` rather than `CASCADE`, for the reason `order_events` is.**
 * A job holds the customer's artwork and the file a merchant fulfils from, and
 * disconnect-and-reconnect is the ordinary case — a migration, a staging swap,
 * a support fix. `CASCADE` would silently erase the print files for every order
 * placed before it. `option_view_counts` shipped as `CASCADE` and needed its
 * own migration to correct; this starts where that one ended up.
 *
 * 📌 **`uq_render_jobs_line` is the idempotency M26e.4 asks for** — *"a retry
 * must not produce a second file"*. The plugin retries whenever a response is
 * sent but never received, and WordPress cron is not single-threaded, so a
 * check-then-insert would race. A unique key makes the duplicate impossible
 * rather than unlikely, exactly as `uq_order_events_external` does for orders.
 */
export class RenderJobs1790400000000 implements MigrationInterface {
  name = 'RenderJobs1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `render_jobs` (' +
        '`id` char(36) NOT NULL, ' +
        '`createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        '`updatedAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ' +
        'ON UPDATE CURRENT_TIMESTAMP(3), ' +
        '`storeId` char(36) NOT NULL, ' +
        '`lineRef` varchar(128) NOT NULL, ' +
        '`scene` json NOT NULL, ' +
        '`width` int NOT NULL, ' +
        '`height` int NOT NULL, ' +
        '`processedAt` datetime(3) NULL, ' +
        '`fileUrl` varchar(500) NULL, ' +
        '`attempts` int NOT NULL DEFAULT 0, ' +
        '`deadAt` datetime(3) NULL, ' +
        '`lastError` text NULL, ' +
        'UNIQUE INDEX `uq_render_jobs_line` (`storeId`, `lineRef`), ' +
        /*
         * 📌 **The worker's own index**: it claims rows that are neither
         * processed nor dead, oldest first. Without it every pass is a table
         * scan that grows with the archive of finished jobs.
         */
        'INDEX `ix_render_jobs_pending` (`processedAt`, `deadAt`, `createdAt`), ' +
        'PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );

    await queryRunner.query(
      'ALTER TABLE `render_jobs` ADD CONSTRAINT `fk_render_jobs_store` ' +
        'FOREIGN KEY (`storeId`) REFERENCES `stores` (`id`) ON DELETE RESTRICT',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `render_jobs` DROP FOREIGN KEY `fk_render_jobs_store`',
    );
    await queryRunner.query('DROP INDEX `ix_render_jobs_pending` ON `render_jobs`');
    await queryRunner.query('DROP INDEX `uq_render_jobs_line` ON `render_jobs`');
    await queryRunner.query('DROP TABLE `render_jobs`');
  }
}
