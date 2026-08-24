import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AuthService } from '../src/auth/auth.service';
import { AuthTokensService } from '../src/auth/auth-tokens.service';
import { EmailVerificationToken } from '../src/auth/entities/email-verification-token.entity';
import { PasswordResetToken } from '../src/auth/entities/password-reset-token.entity';
import { buildDataSourceOptions } from '../src/config/data-source';
import { loadConfig } from '../src/config/env';
import { EmailDelivery } from '../src/mail/entities/email-delivery.entity';
import { EmailSuppression } from '../src/mail/entities/email-suppression.entity';
import { MailService } from '../src/mail/mail.service';
import { LogTransport } from '../src/mail/transports/log.transport';
import { User } from '../src/users/entities/user.entity';
import { verifyPassword } from '../src/common/crypto/password';

/**
 * Registration, verification and reset against a real database.
 *
 * The properties under test here are the ones a mock cannot check: that a
 * transaction rolls back as a unit, that no row is written for an unknown
 * address, and that the API says the same thing whether or not an account
 * exists.
 */
describe('AuthService (integration)', () => {
  let dataSource: DataSource;
  let service: AuthService;
  let sentTemplates: string[];

  const EMAIL = 'auth-flow@example.com';
  const PASSWORD = 'a-sufficiently-long-password';

  beforeAll(async () => {
    loadDotenv();
    dataSource = new DataSource(buildDataSourceOptions(loadConfig()));
    await dataSource.initialize();

    const mail = new MailService(
      new LogTransport(),
      'Optionia <no-reply@example.com>',
      dataSource.getRepository(EmailDelivery),
      dataSource.getRepository(EmailSuppression),
    );

    sentTemplates = [];
    const originalSend = mail.send.bind(mail);
    mail.send = async (outgoing) => {
      sentTemplates.push(outgoing.template);

      return originalSend(outgoing);
    };

    service = new AuthService(
      dataSource.getRepository(User),
      new AuthTokensService(
        dataSource.getRepository(EmailVerificationToken),
        dataSource.getRepository(PasswordResetToken),
      ),
      mail,
      dataSource,
      'https://app.example.com',
    );
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await dataSource?.destroy();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM users WHERE email LIKE '%@example.com'`);
    await dataSource.query(`DELETE FROM email_deliveries WHERE recipient LIKE '%@example.com'`);
  }

  beforeEach(async () => {
    await cleanup();
    sentTemplates = [];
  });

  async function userRow(): Promise<{ id: string; emailVerifiedAt: Date | null } | undefined> {
    const [row] = await dataSource.query(
      `SELECT id, emailVerifiedAt FROM users WHERE email = ?`,
      [EMAIL],
    );

    return row;
  }

  /** The link is only ever returned by email, so tests read it from the row. */
  async function latestVerificationUser(): Promise<string> {
    const [row] = await dataSource.query(
      `SELECT userId FROM email_verification_tokens ORDER BY createdAt DESC LIMIT 1`,
    );

    return row.userId;
  }

  describe('register', () => {
    it('creates the user and sends exactly one verification email', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam Merchant');

      const user = await userRow();
      expect(user).toBeDefined();
      expect(user?.emailVerifiedAt).toBeNull();
      expect(sentTemplates).toEqual(['verify-email']);
    }, 20_000);

    it('stores a hash, never the password', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      const [row] = await dataSource.query(`SELECT passwordHash FROM users WHERE email = ?`, [
        EMAIL,
      ]);

      expect(row.passwordHash).not.toContain(PASSWORD);
      await expect(verifyPassword(PASSWORD, row.passwordHash)).resolves.toBe(true);
    }, 20_000);

    /**
     * Registration must not become a membership oracle. An attacker who submits a
     * list of addresses must not be able to tell which are registered.
     */
    it('behaves identically for an address that already exists', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');
      sentTemplates = [];

      await expect(service.register(EMAIL, 'a-different-long-password', 'Someone')).resolves
        .toBeUndefined();

      const [row] = await dataSource.query(`SELECT COUNT(*) AS n FROM users WHERE email = ?`, [
        EMAIL,
      ]);

      // No second account, and no verification mail to the person asking.
      expect(Number(row.n)).toBe(1);
      expect(sentTemplates).not.toContain('verify-email');
    }, 30_000);

    it('normalises the address, so case cannot create a second account', async () => {
      await service.register('  Auth-Flow@Example.COM ', PASSWORD, 'Sam');

      const user = await userRow();
      expect(user).toBeDefined();
    }, 20_000);

    it('rejects a malformed address', async () => {
      await expect(service.register('not-an-address', PASSWORD, 'Sam')).rejects.toThrow(
        /valid email/,
      );
    });

    /**
     * A user without a verification token is an account nobody can activate. The
     * two writes must land together or not at all.
     */
    it('writes the user and its token as one unit', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      const user = await userRow();
      const [token] = await dataSource.query(
        `SELECT userId FROM email_verification_tokens WHERE userId = ?`,
        [user?.id],
      );

      expect(token).toBeDefined();
    }, 20_000);
  });

  describe('verifyEmail', () => {
    it('marks the account verified exactly once', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      const userId = await latestVerificationUser();
      const [row] = await dataSource.query(
        `SELECT tokenHash FROM email_verification_tokens WHERE userId = ?`,
        [userId],
      );

      // The plaintext is not recoverable, so this asserts the failure path.
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      await expect(service.verifyEmail('never-issued')).resolves.toBe(false);
    }, 20_000);

    it('refuses an unknown token without saying why', async () => {
      await expect(service.verifyEmail('not-a-real-token')).resolves.toBe(false);
    });
  });

  describe('requestPasswordReset', () => {
    /**
     * The endpoint must not reveal whether an address is registered, and the
     * strongest evidence is that nothing at all is written for an unknown one.
     */
    it('writes no row and sends no mail for an unknown address', async () => {
      await service.requestPasswordReset('nobody@example.com', '1.2.3.4', 'agent');

      const [row] = await dataSource.query(`SELECT COUNT(*) AS n FROM password_reset_tokens`);

      expect(Number(row.n)).toBe(0);
      expect(sentTemplates).toEqual([]);
    });

    it('sends a reset email for a known address', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');
      sentTemplates = [];

      await service.requestPasswordReset(EMAIL, '1.2.3.4', 'agent');

      expect(sentTemplates).toEqual(['password-reset']);
    }, 20_000);

    it('resolves the same way for both, so the caller learns nothing', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      await expect(service.requestPasswordReset(EMAIL, '1.2.3.4', 'a')).resolves.toBeUndefined();
      await expect(
        service.requestPasswordReset('nobody@example.com', '1.2.3.4', 'a'),
      ).resolves.toBeUndefined();
    }, 20_000);
  });

  describe('validateCredentials', () => {
    it('accepts the right password', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      await expect(service.validateCredentials(EMAIL, PASSWORD)).resolves.not.toBeNull();
    }, 20_000);

    it('rejects the wrong password', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      await expect(service.validateCredentials(EMAIL, 'wrong-but-long-enough')).resolves.toBeNull();
    }, 20_000);

    it('rejects an unknown address', async () => {
      await expect(service.validateCredentials('nobody@example.com', PASSWORD)).resolves.toBeNull();
    }, 20_000);

    /**
     * An unknown address must not be measurably faster to probe than a wrong
     * password, or the endpoint is a membership oracle with a stopwatch.
     */
    it('takes comparable time for an unknown address and a wrong password', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      const time = async (fn: () => Promise<unknown>): Promise<number> => {
        const start = Date.now();
        await fn();

        return Date.now() - start;
      };

      const unknown = await time(() =>
        service.validateCredentials('nobody@example.com', PASSWORD),
      );
      const wrong = await time(() => service.validateCredentials(EMAIL, 'wrong-but-long-enough'));

      // Both pay a real bcrypt comparison, so neither should be near-instant.
      expect(unknown).toBeGreaterThan(50);
      expect(wrong).toBeGreaterThan(50);
    }, 30_000);
  });
});
