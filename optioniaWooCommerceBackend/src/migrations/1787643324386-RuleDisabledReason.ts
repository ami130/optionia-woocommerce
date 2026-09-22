import { MigrationInterface, QueryRunner } from "typeorm";

export class RuleDisabledReason1787643324386 implements MigrationInterface {
    name = 'RuleDisabledReason1787643324386'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`option_rules\` ADD \`disabledReason\` varchar(40) NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`option_rules\` DROP COLUMN \`disabledReason\``);
    }

}
