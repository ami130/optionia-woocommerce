import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AuthTokensService } from '../src/auth/auth-tokens.service';
import { EmailVerificationToken } from '../src/auth/entities/email-verification-token.entity';
import { PasswordResetToken } from '../src/auth/entities/password-reset-token.entity';
import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { hashToken } from '../src/common/crypto/tokens';

/**
 * Token issuance and redemption, against a real database.
 *
 * These cannot be unit tests with mocked repositories. The first version of this
 * service matched outstanding tokens with `consumedAt: null`, which TypeORM
 * renders as `= NULL` — never true in SQL. A mock returning what it was told
 * would have agreed; MySQL reported zero rows affected and the bug was real:
 * every "resend" would have left the previous link working.
 */
describe('AuthTokensService (integration)', () => {
  let dataSource: DataSource;
  let service: AuthTokensService;

  const USER_ID = 'tok-test-user';
  const EMAIL = 'token-test@example.com';

  beforeAll(async () => {
    loadDotenv();
    dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
    await dataSource.initialize();

    service = new AuthTokensService(
      dataSource.getRepository(EmailVerificationToken),
      dataSource.getRepository(PasswordResetToken),
    );
  }, 30_000);

  afterAll(async () => {
    await dataSource?.query(`DELETE FROM users WHERE id = ?`, [USER_ID]);
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM users WHERE id = ?`, [USER_ID]);
    await dataSource.query(
      `INSERT INTO users (id, email, passwordHash, name, locale, createdAt, updatedAt)
       VALUES (?, ?, '$2b$12$placeholder', 'Token Test', 'en', NOW(3), NOW(3))`,
      [USER_ID, EMAIL],
    );
  });

  async function liveVerifications(): Promise<number> {
    const [row] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM email_verification_tokens WHERE userId = ? AND consumedAt IS NULL`,
      [USER_ID],
    );

    return Number(row.n);
  }

  describe('verification', () => {
    it('issues a token whose hash is what gets stored', async () => {
      const plaintext = await service.issueVerification(USER_ID, EMAIL);

      const [row] = await dataSource.query(
        `SELECT tokenHash FROM email_verification_tokens WHERE userId = ?`,
        [USER_ID],
      );

      expect(row.tokenHash).toBe(hashToken(plaintext));
      expect(row.tokenHash).not.toContain(plaintext);
    });

    /**
     * The bug this suite exists for. A merchant who clicks "resend" three times
     * must not end up with three working links.
     */
    it('leaves exactly one live token after repeated resends', async () => {
      await service.issueVerification(USER_ID, EMAIL);
      await service.issueVerification(USER_ID, EMAIL);
      const third = await service.issueVerification(USER_ID, EMAIL);

      expect(await liveVerifications()).toBe(1);

      const result = await service.redeemVerification(third);
      expect(result.failure).toBeNull();
    });

    it('invalidates the earlier link when a new one is issued', async () => {
      const first = await service.issueVerification(USER_ID, EMAIL);
      await service.issueVerification(USER_ID, EMAIL);

      const result = await service.redeemVerification(first);

      expect(result.failure).toBe('already_used');
      expect(result.token).toBeNull();
    });

    it('redeems once and refuses the second time', async () => {
      const plaintext = await service.issueVerification(USER_ID, EMAIL);

      const first = await service.redeemVerification(plaintext);
      expect(first.failure).toBeNull();
      expect(first.token?.email).toBe(EMAIL);

      const second = await service.redeemVerification(plaintext);
      expect(second.failure).toBe('already_used');
    });

    it('reports an unknown token as not found', async () => {
      const result = await service.redeemVerification('a-token-that-was-never-issued');

      expect(result.failure).toBe('not_found');
    });

    it('refuses an expired token', async () => {
      const plaintext = await service.issueVerification(USER_ID, EMAIL);

      await dataSource.query(
        `UPDATE email_verification_tokens SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 MINUTE)
          WHERE userId = ?`,
        [USER_ID],
      );

      expect((await service.redeemVerification(plaintext)).failure).toBe('expired');
    });
  });

  describe('password reset', () => {
    /**
     * Two concurrent requests must not leave a second working link after the
     * first is used — that is a live takeover vector, not a nuisance.
     */
    it('keeps only the newest link alive', async () => {
      const first = await service.issueReset(USER_ID, '1.2.3.4', 'agent');
      const second = await service.issueReset(USER_ID, '1.2.3.4', 'agent');

      expect((await service.redeemReset(first)).failure).toBe('already_used');
      expect((await service.redeemReset(second)).failure).toBeNull();
    });

    it('records where the request came from, for the notification', async () => {
      await service.issueReset(USER_ID, '203.0.113.10', 'Mozilla/5.0');

      const [row] = await dataSource.query(
        `SELECT ip, userAgent FROM password_reset_tokens WHERE userId = ?`,
        [USER_ID],
      );

      expect(row.ip).toBe('203.0.113.10');
      expect(row.userAgent).toBe('Mozilla/5.0');
    });

    /** A long user agent must not fail the insert. */
    it('truncates an oversized user agent rather than failing', async () => {
      await expect(
        service.issueReset(USER_ID, '1.2.3.4', 'x'.repeat(400)),
      ).resolves.toBeDefined();
    });

    /**
     * A link minted before a password change must not be usable to undo it.
     */
    it('revokes outstanding links after a password change', async () => {
      const plaintext = await service.issueReset(USER_ID, '1.2.3.4', 'agent');

      await service.revokeResets(USER_ID);

      expect((await service.redeemReset(plaintext)).failure).toBe('already_used');
    });
  });
});
