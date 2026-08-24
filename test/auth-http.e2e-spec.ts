import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';

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

  const EMAIL = 'http-auth@example.com';
  const PASSWORD = 'a-sufficiently-long-password';

  beforeAll(async () => {
    loadDotenv();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts. Without the prefix every request 404s, and without the
    // pipe the validation tests would pass for the wrong reason.
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    dataSource = app.get(DataSource);
  }, 60_000);

  afterAll(async () => {
    await dataSource?.query(`DELETE FROM users WHERE email LIKE '%@example.com'`);
    await dataSource?.query(`DELETE FROM email_deliveries WHERE recipient LIKE '%@example.com'`);
    await app?.close();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM users WHERE email LIKE '%@example.com'`);
  });

  const post = (path: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/v1/auth/${path}`).send(body);

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
        email: 'nobody@example.com',
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

  describe('password reset', () => {
    it('answers identically for a known and unknown address', async () => {
      await post('register', { email: EMAIL, password: PASSWORD, name: 'Sam' });

      const known = await post('request-password-reset', { email: EMAIL });
      const unknown = await post('request-password-reset', { email: 'nobody@example.com' });

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
