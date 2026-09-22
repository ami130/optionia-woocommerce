import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { bootstrapTestApp } from './harness';

/**
 * Rate limiting on the auth endpoints (M6.1).
 *
 * **This suite exists because none of it worked.** The limits were declared with
 * `@Throttle({ default: ... })` while no bucket named `default` was configured,
 * so every override matched nothing and silently did nothing — 25 registrations
 * against a limit of 5/hour all succeeded, and no test noticed for two steps.
 *
 * An unknown bucket name is not an error in @nestjs/throttler, which is exactly
 * the kind of failure only a behavioural test catches.
 */
describe('auth rate limiting (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'rl';

  beforeAll(async () => {
    // Shared bootstrap: same pipe as `main.ts`, same context middleware.
    app = await bootstrapTestApp();

    dataSource = app.get(DataSource);
    await cleanup();
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(
      `DELETE tm FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email LIKE '${NS}-%'`,
    );
    await dataSource.query(`DELETE FROM users WHERE email LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM tenants WHERE name LIKE '${NS}-%'`);
  }

  /** Statuses from N sequential calls, so ordering is meaningful. */
  async function hammer(
    path: string,
    body: Record<string, unknown>,
    times: number,
  ): Promise<number[]> {
    const statuses: number[] = [];

    for (let i = 0; i < times; i += 1) {
      const response = await request(app.getHttpServer())
        .post(`/v1/auth/${path}`)
        .send(body);
      statuses.push(response.status);
    }

    return statuses;
  }

  /**
   * The property M6.1 asks for. Ten attempts is enough for someone who cannot
   * remember which password they used; it is nowhere near enough to work through
   * a list.
   */
  it('throttles repeated login attempts on one account', async () => {
    const statuses = await hammer(
      'login',
      { email: `${NS}-login@example.com`, password: 'a-long-enough-password' },
      12,
    );

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // The limit engages after the allowance, not before it.
    expect(statuses[0]).not.toBe(429);
  }, 60_000);

  /**
   * The reason the guard keys on the account rather than the IP alone.
   *
   * With IP-only keying, one attacker locks out every account behind a shared
   * address — an office, a university, a mobile carrier's NAT. Failing this test
   * means a denial-of-service against a whole building costs one attacker ten
   * requests.
   */
  it('does not let one account exhaust another account’s budget', async () => {
    await hammer(
      'login',
      { email: `${NS}-victim-a@example.com`, password: 'a-long-enough-password' },
      12,
    );

    const other = await hammer(
      'login',
      { email: `${NS}-victim-b@example.com`, password: 'a-long-enough-password' },
      3,
    );

    expect(other).not.toContain(429);
  }, 60_000);

  /**
   * Registration is expensive — a bcrypt hash and an email — and nobody
   * legitimately registers the same address repeatedly.
   */
  it('throttles repeated registration for one address', async () => {
    const statuses = await hammer(
      'register',
      { email: `${NS}-reg@example.com`, password: 'a-long-enough-password', name: 'x' },
      8,
    );

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * The email-bombing vector M6.1 names: an endpoint that sends mail to an
   * address the caller chooses, with a tight limit for that reason.
   */
  it('throttles the resend endpoint hardest', async () => {
    const statuses = await hammer(
      'resend-verification',
      { email: `${NS}-resend@example.com` },
      6,
    );

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  }, 60_000);

  it('throttles password reset requests', async () => {
    const statuses = await hammer(
      'request-password-reset',
      { email: `${NS}-reset@example.com` },
      6,
    );

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  }, 60_000);

  /** A probe must never be throttled: it has no credentials and runs forever. */
  it('never throttles the health endpoint', async () => {
    for (let i = 0; i < 30; i += 1) {
      const response = await request(app.getHttpServer()).get('/health');

      expect(response.status).toBe(200);
    }
  }, 60_000);
});
