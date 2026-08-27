import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { deleteTenantsFor } from './cleanup-tenants';

import { bootstrapTestApp } from './harness';

/**
 * The auth endpoints over HTTP.
 *
 * The service tests prove the logic; these prove the *responses*, which is where
 * enumeration resistance actually lives. A service that behaves identically for a
 * known and unknown address still leaks if the controller returns a different
 * status or body.
 */
describe('auth endpoints (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Each e2e suite owns a distinct address namespace. Jest runs suites in
  // parallel, and a shared `%@example.com` cleanup meant each suite deleted the
  // other's user mid-test — which passed when run alone and failed together.
  const NS = 'httpauth';

  /**
   * A distinct address per test.
   *
   * Rate limiting is keyed on the submitted account and now actually works, so a
   * shared address means later tests in the file are throttled by earlier ones.
   * The counter shape mirrors reality — real users do not register the same
   * address twelve times — rather than working around the limiter.
   */
  let sequence = 0;
  let EMAIL = `${NS}-user-0@example.com`;

  beforeEach(() => {
    sequence += 1;
    EMAIL = `${NS}-user-${sequence}@example.com`;
  });
  const PASSWORD = 'a-sufficiently-long-password';

  beforeAll(async () => {
    // The harness installs the prefix, the context middleware and the exact pipe
    // `main.ts` ships — including its `exceptionFactory`. This suite used to
    // build its own, and that copy read `error.property` directly, so a nested
    // failure reported `postcode` where the application reports
    // `address.postcode`. It also omitted `enableImplicitConversion`.
    app = await bootstrapTestApp();

    dataSource = app.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    // Registering as `x` provisions a tenant slugged `x-…`, which no namespace
    // match finds — see `deleteTenantsFor`.
    if (dataSource) {
      await deleteTenantsFor(dataSource, NS);
    }

    await dataSource?.query(`DELETE FROM users WHERE email LIKE '${NS}-%'`);
    await dataSource?.query(`DELETE FROM email_deliveries WHERE recipient LIKE '${NS}-%'`);
    await app?.close();
  });

  beforeEach(async () => {
    await deleteTenantsFor(dataSource, NS);
    await dataSource.query(`DELETE FROM users WHERE email LIKE '${NS}-%'`);
  });

  const post = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/v1/auth/${path}`).send(body);

  /** Register, verify, and log in — returning the whole login payload. */
  async function loginPayload(): Promise<Record<string, string>> {
    await post('register', { email: EMAIL, password: PASSWORD, name: 'Sam' });
    await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [EMAIL]);

    const response = await post('login', { email: EMAIL, password: PASSWORD });

    return response.body.data as Record<string, string>;
  }

  describe('validation', () => {
    it('rejects a malformed address', async () => {
      const response = await post('register', { email: 'nope', password: PASSWORD, name: 'A' });

      expect(response.status).toBe(400);
    });

    it('rejects a password under the minimum', async () => {
      const response = await post('register', { email: EMAIL, password: 'short', name: 'A' });

      expect(response.status).toBe(400);
    });

    /**
     * `forbidNonWhitelisted` is what stops a caller probing for fields the API
     * might accept — an unexpected key is rejected rather than silently dropped.
     */
    it('rejects an unexpected field', async () => {
      const response = await post('register', {
        email: EMAIL,
        password: PASSWORD,
        name: 'A',
        role: 'super_admin',
      });

      expect(response.status).toBe(400);
    });

    /** bcrypt truncates at 72 bytes, so a longer password must not be accepted. */
    it('rejects a password beyond 72 bytes', async () => {
      const response = await post('register', {
        email: EMAIL,
        password: 'x'.repeat(73),
        name: 'A',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('validation details name the field (ADR-009)', () => {
    /**
     * A detail with no field tells a form that something is wrong and not what,
     * which is the least useful thing an API can say to someone filling one in.
     * Every entry was previously `field: ''`, including one whose own message
     * named the property.
     */
    it('names the field for each failed constraint', async () => {
      const response = await post('register', {
        email: 'a@b.com',
        password: 'short',
        name: 'x',
      });

      expect(response.status).toBe(400);

      const fields = (response.body.error?.details ?? []).map(
        (d: { field: string }) => d.field,
      );

      expect(fields).toContain('password');
      expect(fields.every((f: string) => f.length > 0)).toBe(true);
    });

    it('names the field on an invalid email', async () => {
      const response = await post('register', {
        email: 'not-an-address',
        password: PASSWORD,
        name: 'x',
      });

      const fields = (response.body.error?.details ?? []).map(
        (d: { field: string }) => d.field,
      );

      expect(fields).toContain('email');
    });

    /** One field can fail several rules, and each is a separate thing to fix. */
    it('reports every failed constraint, not just the first', async () => {
      const response = await post('register', { email: 'nope', password: 'x', name: 'y' });

      expect((response.body.error?.details ?? []).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('register', () => {
    it('accepts a valid registration', async () => {
      const response = await post('register', { email: EMAIL, password: PASSWORD, name: 'Sam' });

      expect(response.status).toBe(202);
    }, 20_000);

    /**
     * The property that matters. A second registration for the same address must
     * be indistinguishable from the first — same status, same body — or the
     * endpoint answers "is this address taken?".
     */
    it('answers identically for a new and an existing address', async () => {
      const first = await post('register', { email: EMAIL, password: PASSWORD, name: 'Sam' });
      const second = await post('register', { email: EMAIL, password: PASSWORD, name: 'Other' });

      expect(second.status).toBe(first.status);
      // `meta.requestId` is per-request by design, so compare the payload rather
      // than the envelope — otherwise this fails for a reason that is not a leak.
      expect(second.body.data).toEqual(first.body.data);
    }, 30_000);
  });

  describe('login', () => {
    beforeEach(async () => {
      await post('register', { email: EMAIL, password: PASSWORD, name: 'Sam' });
    }, 20_000);

    /**
     * A wrong password and an unregistered address must produce the same status
     * and the same message. Any difference is a membership oracle.
     */
    it('gives one answer for a wrong password and an unknown address', async () => {
      const wrong = await post('login', { email: EMAIL, password: 'wrong-but-long-enough' });
      const unknown = await post('login', {
        email: `${NS}-nobody@example.com`,
        password: PASSWORD,
      });

      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(unknown.body.error?.message).toBe(wrong.body.error?.message);
      expect(unknown.body.error?.code).toBe(wrong.body.error?.code);

      // Comparing the two responses only proves they are consistent — making
      // both say "no account exists" would still pass. The message must also
      // not name which half was wrong.
      const message = String(wrong.body.error?.message);
      expect(message).toMatch(/email or password/i);
      expect(message).not.toMatch(/no account|not registered|unknown (email|address)/i);
      expect(message).not.toMatch(/wrong password|incorrect password/i);
    }, 30_000);

    /**
     * Safe to distinguish only because the caller has already proven they hold
     * the password — this tells them nothing they did not know.
     */
    it('refuses an unverified account with a distinct, actionable message', async () => {
      const response = await post('login', { email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(403);
      expect(response.body.error?.message).toMatch(/verify/i);
    }, 20_000);
  });

  describe('sessions', () => {
    async function verifiedLogin(): Promise<string> {
      await post('register', { email: EMAIL, password: PASSWORD, name: 'Sam' });
      await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [
        EMAIL,
      ]);

      const response = await post('login', { email: EMAIL, password: PASSWORD });

      if (!response.body?.data) {
        throw new Error(
          `login failed: ${response.status} ${JSON.stringify(response.body)}`,
        );
      }

      return response.body.data.refreshToken as string;
    }

    it('issues a refresh token on a verified login', async () => {
      const token = await verifiedLogin();

      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThanOrEqual(43);
    }, 30_000);

    it('exchanges a refresh token for a new one', async () => {
      const first = await verifiedLogin();

      const response = await post('refresh', { refreshToken: first });

      expect(response.status).toBe(200);
      expect(response.body.data.refreshToken).not.toBe(first);
    }, 30_000);

    /**
     * The reuse response must be indistinguishable from any other failure.
     * Telling an attacker their replay was noticed is telling them the token was
     * real — the detection is for operations, not for the caller.
     */
    it('answers a replayed token exactly like an unknown one', async () => {
      const first = await verifiedLogin();
      await post('refresh', { refreshToken: first });

      const replay = await post('refresh', { refreshToken: first });
      const unknown = await post('refresh', { refreshToken: 'x'.repeat(43) });

      expect(replay.status).toBe(unknown.status);
      expect(replay.body.error?.code).toBe(unknown.body.error?.code);
      expect(replay.body.error?.message).toBe(unknown.body.error?.message);
    }, 30_000);

    it('logs out, and the token stops working', async () => {
      const token = await verifiedLogin();

      const logout = await post('logout', { refreshToken: token });
      expect(logout.status).toBe(204);

      expect((await post('refresh', { refreshToken: token })).status).toBe(401);
    }, 30_000);

    /** A different answer for an unknown token would confirm which exist. */
    it('returns 204 for an unknown token too', async () => {
      const response = await post('logout', { refreshToken: 'x'.repeat(43) });

      expect(response.status).toBe(204);
    });
  });

  describe('access tokens (6g)', () => {
    it('issues an access token naming the tenant and role', async () => {
      const payload = await loginPayload();

      expect(typeof payload.accessToken).toBe('string');
      expect(payload.tenantId).toBeTruthy();
      expect(payload.role).toBe('owner');
    }, 30_000);

    /**
     * The token must be readable enough to route on, and carry nothing else.
     * Anything secret in a JWT payload is public — it is signed, not encrypted.
     */
    it('carries only routing claims, and marks the tenant realm', async () => {
      const payload = await loginPayload();
      const claims = JSON.parse(
        Buffer.from(payload.accessToken.split('.')[1], 'base64url').toString(),
      );

      expect(claims.aud).toBe('tenant');
      expect(claims.tid).toBe(payload.tenantId);
      expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'role', 'sub', 'tid']);
    }, 30_000);

    /** The access token and the refresh token are different credentials. */
    it('issues an access token distinct from the refresh token', async () => {
      const payload = await loginPayload();

      expect(payload.accessToken).not.toBe(payload.refreshToken);
    }, 30_000);
  });

  describe('password reset', () => {
    it('answers identically for a known and unknown address', async () => {
      await post('register', { email: EMAIL, password: PASSWORD, name: 'Sam' });

      const known = await post('request-password-reset', { email: EMAIL });
      const unknown = await post('request-password-reset', { email: `${NS}-nobody@example.com` });

      expect(unknown.status).toBe(known.status);
      expect(unknown.body.data).toEqual(known.body.data);
    }, 30_000);

    it('refuses an invalid reset token', async () => {
      const response = await post('reset-password', {
        token: 'x'.repeat(43),
        password: PASSWORD,
      });

      expect(response.status).toBe(401);
    });
  });

  describe('verify-email', () => {
    it('refuses an unknown token without saying why', async () => {
      const response = await post('verify-email', { token: 'x'.repeat(43) });

      expect(response.status).toBe(401);
      expect(response.body.error?.message).toMatch(/no longer valid/i);
    });
  });
});
