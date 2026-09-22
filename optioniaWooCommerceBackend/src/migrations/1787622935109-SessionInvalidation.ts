import { MigrationInterface, QueryRunner } from "typeorm";

export class SessionInvalidation1787622935109 implements MigrationInterface {
    name = 'SessionInvalidation1787622935109'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` ADD \`sessionsInvalidatedAt\` datetime(3) NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`sessionsInvalidatedAt\``);
    }

}
