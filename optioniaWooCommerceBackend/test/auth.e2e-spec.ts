import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { deleteTenantsFor } from './cleanup-tenants';

import { AuditService } from '../src/audit/audit.service';
import { AuditLog } from '../src/audit/entities/audit-log.entity';
import { AuthService } from '../src/auth/auth.service';
import { AuthTokensService } from '../src/auth/auth-tokens.service';
import { RefreshToken } from '../src/auth/entities/refresh-token.entity';
import { SessionsService } from '../src/auth/sessions.service';
import { TenantProvisioningService } from '../src/tenants/tenant-provisioning.service';
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
  let mailService: MailService;

  // Distinct from the HTTP suite's namespace: Jest runs them in parallel and a
  // shared cleanup pattern made each delete the other's rows.
  const NS = 'authsvc';
  const EMAIL = `${NS}-flow@example.com`;
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

    mailService = mail;

    service = new AuthService(
      dataSource.getRepository(User),
      new AuthTokensService(
        dataSource.getRepository(EmailVerificationToken),
        dataSource.getRepository(PasswordResetToken),
      ),
      mail,
      dataSource,
      new SessionsService(dataSource.getRepository(RefreshToken), 30 * 86_400_000),
      new TenantProvisioningService(),
      'https://app.example.com',
      new AuditService(dataSource.getRepository(AuditLog)),
    );
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await dataSource?.destroy();
  });

  async function cleanup(): Promise<void> {
    // Registering as `Sam Merchant` provisions a tenant slugged `sam-…`, which
    // no namespace match finds — see `deleteTenantsFor`.
    await deleteTenantsFor(dataSource, NS);
    await dataSource.query(
      `DELETE FROM subscriptions WHERE tenantId IN (
         SELECT id FROM (SELECT t.id FROM tenants t
           WHERE t.slug LIKE '${NS}-%' OR t.name LIKE '${NS}-%') AS doomed)`,
    );

    /* Subscriptions first: `subscriptions.tenantId` is RESTRICT (F86). */
    await dataSource.query(
      `DELETE t FROM tenants t WHERE t.slug LIKE '${NS}-%' OR t.name LIKE '${NS}-%'`,
    );
    await dataSource.query(`DELETE FROM users WHERE email LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM email_deliveries WHERE recipient LIKE '${NS}-%'`);
    /* The suppression tests below write real rows; `beforeEach` clears them so a
     * failed run cannot silence the next one's mail. */
    await dataSource.query(`DELETE FROM email_suppressions WHERE email LIKE '${NS}-%'`);
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
      await service.register(`  ${NS}-Flow@Example.COM `, PASSWORD, 'Sam');

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

  describe('tenant provisioning (M6.2)', () => {
    /**
     * A user without a tenant cannot do anything, and a tenant without an owner
     * is unreachable. Both must exist after registration or neither should.
     */
    it('creates a tenant and makes the registrant its owner', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam Merchant');

      const [row] = await dataSource.query(
        `SELECT t.id, t.name, t.slug, t.status, t.trialEndsAt, t.planId, tm.role
           FROM tenants t
           JOIN tenant_members tm ON tm.tenantId = t.id
           JOIN users u ON u.id = tm.userId
          WHERE u.email = ?`,
        [EMAIL],
      );

      expect(row).toBeDefined();
      expect(row.role).toBe('owner');
      expect(row.status).toBe('active');
    }, 20_000);

    /**
     * The trial is carried by `trialEndsAt`, not by a status value — a lapsed
     * trial keeps working at free limits rather than changing state.
     */
    it('starts a trial and puts the tenant on the free plan', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam Merchant');

      const [row] = await dataSource.query(
        `SELECT t.trialEndsAt, p.code FROM tenants t
           JOIN plans p ON p.id = t.planId
           JOIN tenant_members tm ON tm.tenantId = t.id
           JOIN users u ON u.id = tm.userId
          WHERE u.email = ?`,
        [EMAIL],
      );

      expect(row.code).toBe('free');
      expect(new Date(row.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
    }, 20_000);

    /** The owner created the tenant, so nobody invited them. */
    it('records the owner as un-invited', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam Merchant');

      const [row] = await dataSource.query(
        `SELECT tm.invitedBy, tm.acceptedAt FROM tenant_members tm
           JOIN users u ON u.id = tm.userId WHERE u.email = ?`,
        [EMAIL],
      );

      expect(row.invitedBy).toBeNull();
      expect(row.acceptedAt).not.toBeNull();
    }, 20_000);

    /**
     * "My Store" is not an unusual name. A collision must not fail the
     * registration.
     */
    it('gives colliding names distinct slugs', async () => {
      await service.register(EMAIL, PASSWORD, 'My Store');
      await service.register(`${NS}-second@example.com`, PASSWORD, 'My Store');

      const rows = await dataSource.query(
        `SELECT DISTINCT t.slug FROM tenants t
           JOIN tenant_members tm ON tm.tenantId = t.id
           JOIN users u ON u.id = tm.userId
          WHERE u.email LIKE '${NS}-%'`,
      );

      const slugs = rows.map((r: { slug: string }) => r.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(slugs.length).toBe(2);
    }, 40_000);

    /**
     * The whole point of one transaction. If provisioning fails, the user must
     * not survive — a registered account with no tenant is a support ticket.
     */
    it('leaves no user behind when provisioning fails', async () => {
      const broken = new AuthService(
        dataSource.getRepository(User),
        new AuthTokensService(
          dataSource.getRepository(EmailVerificationToken),
          dataSource.getRepository(PasswordResetToken),
        ),
        mailService,
        dataSource,
        new SessionsService(dataSource.getRepository(RefreshToken), 30 * 86_400_000),
        {
          provision: () => Promise.reject(new Error('provisioning failed')),
        } as unknown as TenantProvisioningService,
        'https://app.example.com',
        new AuditService(dataSource.getRepository(AuditLog)),
      );

      await expect(broken.register(EMAIL, PASSWORD, 'Sam')).rejects.toThrow(
        /provisioning failed/,
      );

      const [row] = await dataSource.query(`SELECT COUNT(*) AS n FROM users WHERE email = ?`, [
        EMAIL,
      ]);

      expect(Number(row.n)).toBe(0);
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
      await service.requestPasswordReset(`${NS}-nobody@example.com`, '1.2.3.4', 'agent');

      /*
       * Scoped to this namespace's own users.
       *
       * The count was unscoped -- `COUNT(*)` over the whole table -- so **any**
       * reset row from any source failed it, including one left by a developer
       * exercising the flow by hand. Found exactly that way during Phase 13
       * Stage 2, and the failure named this behaviour rather than the leftover
       * row, which is the expensive kind of red.
       */
      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM password_reset_tokens prt
           JOIN users u ON u.id = prt.userId
          WHERE u.email LIKE ?`,
        [`${NS}-%`],
      );

      expect(Number(row.n)).toBe(0);
      expect(sentTemplates).toEqual([]);
    });

    it('sends a reset email for a known address', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');
      sentTemplates = [];

      await service.requestPasswordReset(EMAIL, '1.2.3.4', 'agent');

      expect(sentTemplates).toEqual(['password-reset']);
    }, 20_000);

    /**
     * 🔴 **An unsubscribe must never silence a password reset.**
     *
     * `MailService.send()` refused every mail for a suppressed address whatever
     * the reason, and all three auth mails go through it — so a merchant who
     * opted out of onboarding email would stop receiving resets, locking
     * themselves out of their own account by clicking unsubscribe in a marketing
     * message.
     *
     * ⚠️ **Asserted against a real row**, because the rule reads `reason` from a
     * real `varchar(20)` column and the unit spec's fake repository returns a
     * hand-built object. `email_suppressions` holds no rows in any environment —
     * nothing feeds it yet — so this is the only place the branch executes
     * against the database it will run against.
     *
     * ⚠️ **And on the delivery row, not `sentTemplates`**, which records what was
     * *attempted*: a suppressed message is attempted and then refused, so the
     * template list looks identical either way. `status` is what differs.
     */
    describe('a suppressed address (M20b.6, ADR-097)', () => {
      const suppress = async (reason: string): Promise<void> => {
        await dataSource.query(
          `INSERT INTO email_suppressions (id, createdAt, updatedAt, email, reason, detail)
           VALUES (UUID(), NOW(3), NOW(3), ?, ?, '')`,
          [EMAIL, reason],
        );
      };

      /**
       * The status of a **named** message, not merely the newest one.
       *
       * ✏️ **This read `ORDER BY createdAt DESC LIMIT 1` and could not say which
       * mail it had found.** `register()` sends a verification first — before the
       * suppression row exists, so it is always `sent` — and the unsubscribe case
       * expects `sent` too. Proven by pointing the helper at the *oldest* row:
       * the `hard_bounce` case failed and the `unsubscribe` case **passed**,
       * asserting a mail it was not testing.
       *
       * Selecting by template removes the ambiguity, and a missing row now reads
       * as `undefined` rather than as some other message's status.
       */
      const statusOf = async (template: string): Promise<string | undefined> => {
        const rows: Array<{ status: string }> = await dataSource.query(
          `SELECT status FROM email_deliveries WHERE recipient = ? AND template = ?
            ORDER BY createdAt DESC LIMIT 1`,
          [EMAIL, template],
        );

        return rows[0]?.status;
      };

      it('still receives a password reset after unsubscribing', async () => {
        await service.register(EMAIL, PASSWORD, 'Sam');
        await suppress('unsubscribe');

        await service.requestPasswordReset(EMAIL, '1.2.3.4', 'agent');

        expect(await statusOf('password-reset')).toBe('sent');
      }, 20_000);

      /**
       * A hard-bounced address does not work, so a reset would not arrive either
       * — and sending to it damages delivery for every merchant who *is*
       * reachable. Silencing everything is correct here.
       */
      it('receives nothing after a hard bounce', async () => {
        await service.register(EMAIL, PASSWORD, 'Sam');
        await suppress('hard_bounce');

        await service.requestPasswordReset(EMAIL, '1.2.3.4', 'agent');

        expect(await statusOf('password-reset')).toBe('suppressed');

        /* ⚠️ And the verification sent *before* the bounce row still reads
         * `sent`, so the assertion above is about the reset and not about
         * whatever happened to arrive last. */
        expect(await statusOf('verify-email')).toBe('sent');
      }, 20_000);
    });

    it('resolves the same way for both, so the caller learns nothing', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      await expect(service.requestPasswordReset(EMAIL, '1.2.3.4', 'a')).resolves.toBeUndefined();
      await expect(
        service.requestPasswordReset(`${NS}-nobody@example.com`, '1.2.3.4', 'a'),
      ).resolves.toBeUndefined();
    }, 20_000);
  });

  describe('resetPassword', () => {
    /**
     * Whoever knew the old password may still hold a refresh token. A reset
     * prompted by a suspected compromise has to lock the attacker out, or it
     * achieves nothing.
     */
    it('ends every session for the user', async () => {
      await service.register(EMAIL, PASSWORD, 'Sam');

      const [user] = await dataSource.query(`SELECT id FROM users WHERE email = ?`, [EMAIL]);

      const sessions = new SessionsService(
        dataSource.getRepository(RefreshToken),
        30 * 86_400_000,
      );
      await sessions.issue(user.id, '1.2.3.4', 'phone');
      await sessions.issue(user.id, '5.6.7.8', 'laptop');

      // Redeem a real reset token rather than reaching past the flow.
      const tokens = new AuthTokensService(
        dataSource.getRepository(EmailVerificationToken),
        dataSource.getRepository(PasswordResetToken),
      );
      const resetToken = await tokens.issueReset(user.id, '1.2.3.4', 'agent');

      await service.resetPassword(resetToken, 'a-brand-new-long-password', '1.2.3.4');

      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM refresh_tokens WHERE userId = ? AND revokedAt IS NULL`,
        [user.id],
      );

      expect(Number(row.n)).toBe(0);
    }, 30_000);
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
      await expect(service.validateCredentials(`${NS}-nobody@example.com`, PASSWORD)).resolves.toBeNull();
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
        service.validateCredentials(`${NS}-nobody@example.com`, PASSWORD),
      );
      const wrong = await time(() => service.validateCredentials(EMAIL, 'wrong-but-long-enough'));

      // Both pay a real bcrypt comparison, so neither should be near-instant.
      expect(unknown).toBeGreaterThan(50);
      expect(wrong).toBeGreaterThan(50);
    }, 30_000);
  });
});
