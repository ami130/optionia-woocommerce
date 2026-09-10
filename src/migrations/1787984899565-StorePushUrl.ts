import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where the cloud pushes "new configuration is available" (M9.4).
 *
 * Nullable rather than defaulted: a store connected by a plugin build that
 * predates the push route has no URL to record, and inventing one would produce
 * deliveries that fail forever. A store without a push URL simply falls back to
 * the fifteen-minute conditional pull (M9.3), which is the acceptance's own
 * fallback path.
 */
export class StorePushUrl1787984899565 implements MigrationInterface {
  name = 'StorePushUrl1787984899565';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`stores\` ADD \`pushUrl\` varchar(500) NULL`,
    );

    // Carried through the handshake before it can be copied to the store, so
    // the request row holds it too.
    await queryRunner.query(
      `ALTER TABLE \`store_connection_codes\` ADD \`pushUrl\` varchar(500) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`store_connection_codes\` DROP COLUMN \`pushUrl\``,
    );
    await queryRunner.query(`ALTER TABLE \`stores\` DROP COLUMN \`pushUrl\``);
  }
}
