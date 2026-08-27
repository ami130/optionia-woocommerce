import { MigrationInterface, QueryRunner } from "typeorm";

export class StoreConnectionCodes1787826250750 implements MigrationInterface {
    name = 'StoreConnectionCodes1787826250750'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`store_connection_codes\` (\`id\` char(36) NOT NULL, \`createdAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updatedAt\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), \`siteUrl\` varchar(255) NOT NULL, \`callback\` varchar(500) NOT NULL, \`stateHash\` char(64) NOT NULL, \`challenge\` char(43) NOT NULL, \`pluginVersion\` varchar(20) NULL, \`codeHash\` char(64) NULL, \`tenantId\` char(36) NULL, \`storeId\` char(36) NULL, \`requestExpiresAt\` datetime(3) NOT NULL, \`approvedAt\` datetime(3) NULL, \`codeExpiresAt\` datetime(3) NULL, \`redeemedAt\` datetime(3) NULL, INDEX \`ix_store_connection_codes_tenant\` (\`tenantId\`), UNIQUE INDEX \`ix_store_connection_codes_code\` (\`codeHash\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`store_connection_codes\` ADD CONSTRAINT \`FK_1135a7b53de187730be25fcbf0f\` FOREIGN KEY (\`tenantId\`) REFERENCES \`tenants\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`store_connection_codes\` ADD CONSTRAINT \`FK_6b249433e43a6296e907e8337aa\` FOREIGN KEY (\`storeId\`) REFERENCES \`stores\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`store_connection_codes\` DROP FOREIGN KEY \`FK_6b249433e43a6296e907e8337aa\``);
        await queryRunner.query(`ALTER TABLE \`store_connection_codes\` DROP FOREIGN KEY \`FK_1135a7b53de187730be25fcbf0f\``);
        await queryRunner.query(`DROP INDEX \`ix_store_connection_codes_code\` ON \`store_connection_codes\``);
        await queryRunner.query(`DROP INDEX \`ix_store_connection_codes_tenant\` ON \`store_connection_codes\``);
        await queryRunner.query(`DROP TABLE \`store_connection_codes\``);
    }

}
