import { Controller, Get, INestApplication, Module, UseGuards, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { TenantGuard } from '../src/auth/guards/tenant.guard';
import { getContext } from '../src/common/context/request-context';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';

/**
 * The guards, applied to a route in another module.
 *
 * This suite exists because of a defect it would have caught: `TenantGuard`
 * injects a repository, and `AuthModule` exported the guard without exporting
 * `TypeOrmModule`. Every consumer failed at boot, in a message naming the
 * consumer rather than the cause — and no existing test noticed, because no test
 * had ever applied the guard anywhere.
 *
 * The probe controller is the point: guards are only proven by a route that uses
 * them.
 */
@Controller('guard-probe')
@UseGuards(JwtAuthGuard, TenantGuard)
class GuardProbeController {
  @Get()
  read(): { tenantId?: string; role?: string; userId?: string } {
    const context = getContext();

    return {
      tenantId: context?.tenantId,
      role: context?.tenantRole,
      userId: context?.userId,
    };
  }
}

@Module({ imports: [AuthModule], controllers: [GuardProbeController] })
class GuardProbeModule {}

describe('guards (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'guards';
  const EMAIL = `${NS}-owner@example.com`;
  const PASSWORD = 'a-sufficiently-long-password';

  beforeAll(async () => {
    loadDotenv();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, GuardProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // Mirrors main.ts. Without it the guards write into a context that does not
    // exist, and every assertion about the context would pass vacuously.
    const context = new RequestContextMiddleware();
    app.use(context.use.bind(context));

    app.setGlobalPrefix('v1', { exclude: ['health'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

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
  }

  async function tokenFor(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Owner' });
    await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [email]);

    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD });

    return login.body.data.accessToken as string;
  }

  const probe = (token?: string) => {
    const call = request(app.getHttpServer()).get('/v1/guard-probe');

    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  /**
   * The regression test for the export defect. If `AuthModule` stops exporting
   * the repository, this suite fails to boot rather than failing an assertion —
   * which is louder, and correct.
   */
  it('boots a module that applies TenantGuard', () => {
    expect(app).toBeDefined();
  });

  describe('public routes stay reachable', () => {
    /**
     * Authentication is global, so every unauthenticated route depends on a
     * marker. Health is the one that matters most: a load balancer has no
     * credentials, and a probe returning 401 looks identical to one returning
     * 500 — the orchestrator restarts a healthy service in a loop.
     *
     * Registering the global guard broke this immediately, which is the guard
     * working. This test is so it cannot break quietly next time.
     */
    it('serves /health without a token', async () => {
      const response = await request(app.getHttpServer()).get('/health');

      expect(response.status).toBe(200);
    });

    it('serves the auth endpoints without a token', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'a-long-enough-password' });

      // 401 for bad credentials, not for a missing token — the route is reached.
      expect(response.status).toBe(401);
      expect(response.body.error?.message).toMatch(/email or password/i);
    }, 20_000);
  });

  describe('rejects', () => {
    it('a request with no token', async () => {
      expect((await probe()).status).toBe(401);
    });

    it('a malformed token', async () => {
      expect((await probe('garbage')).status).toBe(401);
    });

    it('a token signed with another secret', async () => {
      // Header and payload are structurally valid; only the signature is wrong.
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(
          JSON.stringify({ sub: 'x', aud: 'tenant', tid: 'y', role: 'owner' }),
        ).toString('base64url'),
        'not-a-real-signature',
      ].join('.');

      expect((await probe(forged)).status).toBe(401);
    });

    /** Every failure gives the same answer, so none of them is a hint. */
    it('every bad token the same way', async () => {
      const none = await probe();
      const garbage = await probe('garbage');

      expect(garbage.status).toBe(none.status);
      expect(garbage.body.error?.code).toBe(none.body.error?.code);
      expect(garbage.body.error?.message).toBe(none.body.error?.message);
    });
  });

  describe('accepts', () => {
    it('a valid token, and populates the request context', async () => {
      const token = await tokenFor(EMAIL);

      const response = await probe(token);

      expect(response.status).toBe(200);
      expect(response.body.data.tenantId).toBeTruthy();
      expect(response.body.data.role).toBe('owner');
      expect(response.body.data.userId).toBeTruthy();
    }, 40_000);

    /**
     * An access token cannot be revoked, so a removed member would keep working
     * until it expired. `TenantGuard` reads the membership row on every request
     * precisely to close that window.
     */
    it('but stops accepting once the membership is revoked', async () => {
      const token = await tokenFor(`${NS}-revoked@example.com`);

      expect((await probe(token)).status).toBe(200);

      await dataSource.query(
        `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
            SET tm.revokedAt = NOW(3) WHERE u.email = ?`,
        [`${NS}-revoked@example.com`],
      );

      // Same token, same second — only the stored membership changed.
      expect((await probe(token)).status).toBe(401);
    }, 40_000);
  });
});
