import { MigrationInterface, QueryRunner } from "typeorm";

export class AuthAndMailTables1787559406558 implements MigrationInterface {
    name = 'AuthAndMailTables1787559406558'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`email_suppressions\` (\`id\` char(36) NOT NULL, \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), \`email\` varchar(320) NOT NULL, \`reason\` varchar(20) NOT NULL, \`detail\` varchar(500) NOT NULL DEFAULT '', \`liftedAt\` datetime(3) NULL, \`liftedByUserId\` char(36) NULL, UNIQUE INDEX \`uq_email_suppressions_email\` (\`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`email_deliveries\` (\`id\` char(36) NOT NULL, \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), \`tenantId\` char(36) NULL, \`userId\` char(36) NULL, \`recipient\` varchar(320) NOT NULL, \`template\` varchar(64) NOT NULL, \`subject\` varchar(255) NOT NULL DEFAULT '', \`status\` varchar(20) NOT NULL DEFAULT 'queued', \`providerMessageId\` varchar(128) NOT NULL DEFAULT '', \`error\` varchar(500) NOT NULL DEFAULT '', \`attempts\` int UNSIGNED NOT NULL DEFAULT '0', \`sentAt\` datetime(3) NULL, INDEX \`ix_email_deliveries_template\` (\`template\`, \`createdAt\`), INDEX \`ix_email_deliveries_tenant\` (\`tenantId\`), INDEX \`ix_email_deliveries_recipient\` (\`recipient\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`refresh_tokens\` (\`id\` char(36) NOT NULL, \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), \`userId\` char(36) NOT NULL, \`tokenHash\` char(64) NOT NULL, \`familyId\` char(36) NOT NULL, \`rotatedAt\` datetime(3) NULL, \`replacedById\` char(36) NULL, \`revokedAt\` datetime(3) NULL, \`revokedReason\` varchar(40) NOT NULL DEFAULT '', \`expiresAt\` datetime(3) NOT NULL, \`ip\` varchar(45) NOT NULL DEFAULT '', \`userAgent\` varchar(255) NOT NULL DEFAULT '', INDEX \`ix_refresh_tokens_user\` (\`userId\`), INDEX \`ix_refresh_tokens_family\` (\`familyId\`), UNIQUE INDEX \`ix_refresh_tokens_hash\` (\`tokenHash\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`password_reset_tokens\` (\`id\` char(36) NOT NULL, \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), \`userId\` char(36) NOT NULL, \`tokenHash\` char(64) NOT NULL, \`consumedAt\` datetime(3) NULL, \`expiresAt\` datetime(3) NOT NULL, \`ip\` varchar(45) NOT NULL DEFAULT '', \`userAgent\` varchar(255) NOT NULL DEFAULT '', INDEX \`ix_password_reset_tokens_user\` (\`userId\`), UNIQUE INDEX \`ix_password_reset_tokens_hash\` (\`tokenHash\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`email_verification_tokens\` (\`id\` char(36) NOT NULL, \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), \`userId\` char(36) NOT NULL, \`tokenHash\` char(64) NOT NULL, \`email\` varchar(320) NOT NULL, \`consumedAt\` datetime(3) NULL, \`expiresAt\` datetime(3) NOT NULL, INDEX \`ix_email_verification_tokens_user\` (\`userId\`), UNIQUE INDEX \`ix_email_verification_tokens_hash\` (\`tokenHash\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`refresh_tokens\` ADD CONSTRAINT \`FK_610102b60fea1455310ccd299de\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`password_reset_tokens\` ADD CONSTRAINT \`FK_d6a19d4b4f6c62dcd29daa497e2\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`email_verification_tokens\` ADD CONSTRAINT \`FK_10f285d038feb767bf7c2da14b3\` FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`email_verification_tokens\` DROP FOREIGN KEY \`FK_10f285d038feb767bf7c2da14b3\``);
        await queryRunner.query(`ALTER TABLE \`password_reset_tokens\` DROP FOREIGN KEY \`FK_d6a19d4b4f6c62dcd29daa497e2\``);
        await queryRunner.query(`ALTER TABLE \`refresh_tokens\` DROP FOREIGN KEY \`FK_610102b60fea1455310ccd299de\``);
        await queryRunner.query(`DROP INDEX \`ix_email_verification_tokens_hash\` ON \`email_verification_tokens\``);
        await queryRunner.query(`DROP INDEX \`ix_email_verification_tokens_user\` ON \`email_verification_tokens\``);
        await queryRunner.query(`DROP TABLE \`email_verification_tokens\``);
        await queryRunner.query(`DROP INDEX \`ix_password_reset_tokens_hash\` ON \`password_reset_tokens\``);
        await queryRunner.query(`DROP INDEX \`ix_password_reset_tokens_user\` ON \`password_reset_tokens\``);
        await queryRunner.query(`DROP TABLE \`password_reset_tokens\``);
        await queryRunner.query(`DROP INDEX \`ix_refresh_tokens_hash\` ON \`refresh_tokens\``);
        await queryRunner.query(`DROP INDEX \`ix_refresh_tokens_family\` ON \`refresh_tokens\``);
        await queryRunner.query(`DROP INDEX \`ix_refresh_tokens_user\` ON \`refresh_tokens\``);
        await queryRunner.query(`DROP TABLE \`refresh_tokens\``);
        await queryRunner.query(`DROP INDEX \`ix_email_deliveries_recipient\` ON \`email_deliveries\``);
        await queryRunner.query(`DROP INDEX \`ix_email_deliveries_tenant\` ON \`email_deliveries\``);
        await queryRunner.query(`DROP INDEX \`ix_email_deliveries_template\` ON \`email_deliveries\``);
        await queryRunner.query(`DROP TABLE \`email_deliveries\``);
        await queryRunner.query(`DROP INDEX \`uq_email_suppressions_email\` ON \`email_suppressions\``);
        await queryRunner.query(`DROP TABLE \`email_suppressions\``);
    }

}
