import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AuditAction } from '../src/audit/audit.service';
import { AuthTokensService } from '../src/auth/auth-tokens.service';
import { createHarness, type Harness } from './harness';

/**
 * Authentication events reach the audit trail (M6.x).
 *
 * ## Why this exists
 *
 * 🔴 **`AuditService` was injected into `auth.module.ts` and never called.**
 * Thirty-six actions covered option authoring and store connection; not one
 * covered signing in. A trail that records who renamed an option value but not
 * who signed in has its priorities inverted — the sign-in is where an incident
 * response starts.
 *
 * Wired and unused is the easiest kind of gap to mistake for coverage, which is
 * why this asserts rows in the table rather than calls on a spy: `AuditService`
 * swallows its own write failures by design, so a spy cannot tell a successful
 * write from one that threw.
 *
 * ## The other half: what must NOT be recorded
 *
 * Every one of these routes is deliberately vague about whether an account
 * exists — login answers the same for a wrong password and an unknown address,
 * registration answers `202` either way, logout answers `204` for any string.
 * **A row that distinguishes them rebuilds that oracle inside the log**, for
 * everyone who can read it. Half the cases below assert an absence.
 */
describe('auth audit trail (e2e)', () => {
  let harness: Harness;
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'authaud';
  const PASSWORD = 'a-sufficiently-long-password';

  const address = (which: string) => `${NS}-${which}@example.com`;

  /** Rows for one address, newest first. */
  interface AuditRow {
    action: string;
    ip: unknown;
    userId: string | null;
    changes: unknown;
  }

  async function rowsFor(email: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT a.action, a.ip, a.userId, a.changes
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.userId
        WHERE u.email = ? OR JSON_EXTRACT(a.changes, '$.email') = ?
        ORDER BY a.createdAt DESC`,
      [email, email],
    );
  }

  /** How many verification rows exist right now. */
  async function verifiedRows(): Promise<number> {
    const [row] = (await dataSource.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?`,
      [AuditAction.USER_EMAIL_VERIFIED],
    )) as Array<{ n: number }>;

    return Number(row.n);
  }

  const actions = async (email: string): Promise<string[]> =>
    (await rowsFor(email)).map((row) => row.action);

  /**
   * Rows this suite writes that the harness cannot see.
   *
   * ⚠️ `harness.cleanup()` removes tenants and their users, and an audit row for
   * a *failed* login or an unknown address has **no user to cascade from** — it
   * is keyed only by the address inside `changes`. Found the hard way: a mutation
   * test left one behind, and the next run failed against a row from the previous
   * one rather than against the code.
   */
  async function purgeOrphanRows(): Promise<void> {
    await dataSource.query(`DELETE FROM audit_logs WHERE changes LIKE ?`, [`%${NS}-%`]);
  }

  beforeAll(async () => {
    harness = await createHarness(NS);
    app = harness.app;
    dataSource = harness.dataSource;
    await harness.cleanup();
    await purgeOrphanRows();
  }, 60_000);

  afterAll(async () => {
    await purgeOrphanRows();
    await harness.cleanup();
    await app?.close();
  });

  describe('registration', () => {
    it('records a real registration', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({ email: address('reg'), password: PASSWORD, name: 'Reg', tenantName: 'Reg Co' })
        .expect(202);

      expect(await actions(address('reg'))).toContain(AuditAction.USER_REGISTERED);
    }, 30_000);

    /**
     * 🔴 The route answers `202` for an address that already exists — that is
     * exactly what it must not disclose. A second row here would put the answer
     * in the log instead.
     */
    it('records nothing for a duplicate', async () => {
      const before = (await actions(address('reg'))).filter(
        (a) => a === AuditAction.USER_REGISTERED,
      ).length;

      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({ email: address('reg'), password: PASSWORD, name: 'Reg', tenantName: 'Reg Co' })
        .expect(202);

      const after = (await actions(address('reg'))).filter(
        (a) => a === AuditAction.USER_REGISTERED,
      ).length;

      expect(after).toBe(before);
    }, 30_000);
  });

  describe('verifying an address', () => {
    /**
     * 🔴 **No suite redeemed a real verification token.** `auth.e2e-spec` covers
     * only the failure cases, and every harness marks `emailVerifiedAt` directly
     * — so the success path had no coverage and its audit row was never produced.
     * Found by reading the live table after every suite passed: six of the seven
     * actions had rows and this one had **none**.
     *
     * The plaintext token never leaves `sendVerification()`, so this drives the
     * service directly with a token it issued, which is the only way to reach the
     * success branch without intercepting mail.
     */
    it('records a redeemed verification token', async () => {
      const email = address('verify');

      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send({ email, password: PASSWORD, name: 'Ver', tenantName: 'Ver Co' })
        .expect(202);

      const before = await verifiedRows();

      /*
       * Redeemed through the real route with the real token. `issueVerification`
       * returns the plaintext and stores only its hash, so a second issue for the
       * same user is the supported way to obtain one — the same call registration
       * itself makes.
       */
      const tokens = app.get(AuthTokensService);
      const [user] = (await dataSource.query(`SELECT id FROM users WHERE email = ?`, [
        email,
      ])) as Array<{ id: string }>;

      const plaintext = await tokens.issueVerification(user.id, email);

      await request(app.getHttpServer())
        .post('/v1/auth/verify-email')
        .send({ token: plaintext })
        .expect(200);

      expect(await verifiedRows()).toBeGreaterThan(before);
    }, 30_000);
  });

  describe('signing in', () => {
    it('records a successful sign-in, scoped to the tenant it was for', async () => {
      await harness.tenant('ok');

      const rows = await dataSource.query(
        `SELECT a.action, a.tenantId, a.userId, a.ip
           FROM audit_logs a JOIN users u ON u.id = a.userId
          WHERE u.email = ? AND a.action = ?`,
        [address('ok'), AuditAction.USER_LOGGED_IN],
      );

      expect(rows.length).toBeGreaterThan(0);

      /* Scoped, or the tenant whose data that session can reach cannot see it. */
      expect(rows[0].tenantId).not.toBeNull();
      expect(rows[0].userId).not.toBeNull();

      /* The IP comes from the request context, never from the caller. */
      expect(rows[0].ip).not.toBeNull();
    }, 60_000);

    it('records a failed sign-in', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: address('ok'), password: 'wrong-but-long-enough-to-pass' })
        .expect(401);

      expect(await actions(address('ok'))).toContain(AuditAction.USER_LOGIN_FAILED);
    }, 30_000);

    /**
     * 🔴 **The oracle test.** A wrong password and an address that never
     * registered must produce the *same* action — anything else lets a reader of
     * the log enumerate which addresses hold accounts.
     */
    it('does not distinguish a wrong password from an unknown address', async () => {
      const unknown = address('ghost');

      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: unknown, password: 'wrong-but-long-enough-to-pass' })
        .expect(401);

      const ghost = await rowsFor(unknown);
      const known = await rowsFor(address('ok'));

      const ghostFailures = ghost.filter((r) => r.action === AuditAction.USER_LOGIN_FAILED);
      const knownFailures = known.filter((r) => r.action === AuditAction.USER_LOGIN_FAILED);

      expect(ghostFailures.length).toBeGreaterThan(0);
      expect(knownFailures.length).toBeGreaterThan(0);

      /* Same action, and neither carries a reason. */
      const reasons = [...ghost, ...known]
        .filter((r) => r.action === AuditAction.USER_LOGIN_FAILED)
        .map((r) => JSON.stringify(r.changes ?? {}));

      for (const reason of reasons) {
        expect(reason).not.toMatch(/password|unknown|no such|not found/i);
      }
    }, 30_000);
  });

  describe('signing out', () => {
    it('records a real sign-out and ignores an unknown token', async () => {
      const token = await harness.tenant('out');

      const login = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: address('out'), password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .send({ refreshToken: login.body.data.refreshToken })
        .expect(204);

      expect(await actions(address('out'))).toContain(AuditAction.USER_LOGGED_OUT);

      /*
       * 🔴 The route is unauthenticated and answers 204 for anything. A row per
       * posted string would tell an attacker which stolen tokens are still live.
       *
       * ⚠️ Counted across **all** sign-out rows, not the user's own. An earlier
       * version counted rows for this address, and a mutant that recorded every
       * attempt **survived** — the orphan row it wrote has no user to join back
       * to, so the very rows the assertion exists to forbid were invisible to it.
       */
      const total = async (): Promise<number> => {
        const [row] = (await dataSource.query(
          `SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?`,
          [AuditAction.USER_LOGGED_OUT],
        )) as Array<{ n: number }>;

        return Number(row.n);
      };

      const before = await total();

      await request(app.getHttpServer())
        .post('/v1/auth/logout')
        .send({ refreshToken: 'not-a-real-token' })
        .expect(204);

      expect(await total()).toBe(before);
      expect(token).toBeTruthy();
    }, 60_000);
  });

  describe('the audit action list', () => {
    /**
     * The four families M6's criterion names. Role and publish were already
     * covered; auth is what this suite adds. **Billing is deliberately absent** —
     * Phase 23 owns those events, and claiming them here would tick a criterion
     * against work that does not exist.
     */
    it('carries every authentication event', () => {
      const auth = Object.values(AuditAction).filter((a) => a.startsWith('user.'));

      expect(auth).toEqual(
        expect.arrayContaining([
          AuditAction.USER_REGISTERED,
          AuditAction.USER_EMAIL_VERIFIED,
          AuditAction.USER_LOGGED_IN,
          AuditAction.USER_LOGIN_FAILED,
          AuditAction.USER_LOGGED_OUT,
          AuditAction.USER_PASSWORD_RESET_REQUESTED,
          AuditAction.USER_PASSWORD_RESET,
        ]),
      );
    });

    /** `refresh` fires on a timer, not an intent — recording it buries the rest. */
    it('does not record token refresh', () => {
      expect(Object.values(AuditAction)).not.toContain('user.token_refreshed');
    });
  });
});
