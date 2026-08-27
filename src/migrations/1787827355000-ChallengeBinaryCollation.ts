import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pin `store_connection_codes.challenge` to a binary collation.
 *
 * The column holds a PKCE S256 challenge — `base64url(SHA-256(verifier))` — which
 * is case-sensitive. Under the schema-wide `utf8mb4_unicode_ci` MySQL considers
 * two genuinely different challenges equal:
 *
 * ```sql
 * SELECT 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
 *      = 'e9mELHOA2oWVfREmtjGUchAOEk1T8urwBUgjssTW-CM';  -- 1 under _ci, 0 under _bin
 * ```
 *
 * Every other hash column in this database is hex, where `_ci` is harmless
 * because hex has no two spellings of one value. This is the only base64 column,
 * and so the only one that needs binary comparison.
 *
 * ⚠️ **TypeORM does not diff collation**, so `migration:generate` reports no
 * changes for this and every later run — verified. Written by hand for that
 * reason; a generated migration would silently leave the entity and the database
 * disagreeing.
 */
export class ChallengeBinaryCollation1787827355000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`store_connection_codes\`
         MODIFY \`challenge\` char(43) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`store_connection_codes\`
         MODIFY \`challenge\` char(43) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL`,
    );
  }
}
