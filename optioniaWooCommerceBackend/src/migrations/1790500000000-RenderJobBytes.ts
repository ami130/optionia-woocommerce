import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The transfer buffer a rendered print file waits in (M26e.4, Decision 3b).
 *
 * 🔴 **A buffer, not a home.** Decision 3 put the print file on the merchant's
 * WordPress and Decision 3a decided how it crosses: the cloud holds the bytes
 * briefly, pushes a short-lived signed URL, the plugin pulls. This column is
 * the "briefly".
 *
 * ⚠️ **In the database rather than on disk, because Decision 1's disk is
 * ephemeral BY DESIGN** — *"a pipeline that needed local persistence would be
 * one restart from losing a merchant's print file"*. A buffer on local disk
 * loses its bytes on every deploy, and the worker claims `processedAt IS NULL`,
 * so a job whose buffer vanished would never be re-claimed: stuck at
 * `rendered` for ever.
 *
 * 📌 **`MEDIUMBLOB` (16 MB) against a measured 0.40 MB worst case.** A render
 * at the 36-megapixel ceiling — 6000×6000, the largest `checkRenderBounds`
 * permits — produced a 0.40 MB PNG. `max_allowed_packet` is 64 MB here. Forty
 * times the headroom, and a `LONGBLOB` would only invite someone to exceed the
 * render ceiling rather than the column.
 */
export class RenderJobBytes1790500000000 implements MigrationInterface {
  name = 'RenderJobBytes1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * ⚠️ **Nullable, and null is the normal state.** A job is null before it
     * renders and null again once the plugin has collected — the bytes exist
     * only in between. A NOT NULL default would make "nothing to collect"
     * indistinguishable from "an empty file".
     */
    await queryRunner.query('ALTER TABLE `render_jobs` ADD `png` mediumblob NULL');

    /*
     * 🔴 **The collection deadline, so an uncollected buffer is visible.**
     * Decision 3a names the drift this prevents: *"if collection ever fails
     * silently, the buffer becomes the home by accident."* A row past this
     * date with bytes still in it is the symptom, queryable rather than
     * inferred.
     */
    await queryRunner.query('ALTER TABLE `render_jobs` ADD `collectBy` datetime(3) NULL');

    /*
     * 📌 **The index a sweeper needs**, so finding abandoned buffers is not a
     * table scan across every finished job.
     */
    await queryRunner.query(
      'CREATE INDEX `ix_render_jobs_uncollected` ON `render_jobs` (`collectBy`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX `ix_render_jobs_uncollected` ON `render_jobs`');
    await queryRunner.query('ALTER TABLE `render_jobs` DROP COLUMN `collectBy`');
    await queryRunner.query('ALTER TABLE `render_jobs` DROP COLUMN `png`');
  }
}
