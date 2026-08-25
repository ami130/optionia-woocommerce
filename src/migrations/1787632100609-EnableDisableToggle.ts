import { MigrationInterface, QueryRunner } from "typeorm";

export class EnableDisableToggle1787632100609 implements MigrationInterface {
    name = 'EnableDisableToggle1787632100609'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`option_groups\` ADD \`isEnabled\` tinyint NOT NULL DEFAULT 1`);
        await queryRunner.query(`ALTER TABLE \`options\` ADD \`isEnabled\` tinyint NOT NULL DEFAULT 1`);
        await queryRunner.query(`ALTER TABLE \`option_values\` ADD \`isEnabled\` tinyint NOT NULL DEFAULT 1`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`option_values\` DROP COLUMN \`isEnabled\``);
        await queryRunner.query(`ALTER TABLE \`options\` DROP COLUMN \`isEnabled\``);
        await queryRunner.query(`ALTER TABLE \`option_groups\` DROP COLUMN \`isEnabled\``);
    }

}
