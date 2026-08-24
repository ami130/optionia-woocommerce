import { Controller, Get, INestApplication, Module, UseGuards, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { TenantGuard } from '../src/auth/guards/tenant.guard';
import { Capability } from '../src/auth/permissions/capabilities';
import { CapabilityGuard } from '../src/auth/permissions/capability.guard';
import { RequireCapability } from '../src/auth/permissions/require-capability.decorator';
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

/**
 * Routes declaring the two capabilities the matrix separates most sharply.
 * Editing is safe; publishing changes a live storefront and what customers pay.
 */
@Controller('capability-probe')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
class CapabilityProbeController {
  @Get('edit')
  @RequireCapability(Capability.OPTION_SETS_EDIT)
  edit(): { ok: boolean } {
    return { ok: true };
  }

  @Get('publish')
  @RequireCapability(Capability.OPTION_SETS_PUBLISH)
  publish(): { ok: boolean } {
    return { ok: true };
  }

  @Get('billing')
  @RequireCapability(Capability.BILLING_MANAGE)
  billing(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [GuardProbeController, CapabilityProbeController],
})
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

  describe('the permission matrix, enforced over HTTP (M6.5)', () => {
    /**
     * Roles are set on the membership row rather than minted into a token,
     * because `TenantGuard` reads the stored role — which is the same path a
     * real demotion takes.
     */
    async function tokenAs(role: string): Promise<string> {
      // A distinct address per role *and* per suite section. The demotion test
      // rewrites its user's role, and an earlier test asserting `owner` on a
      // shared address failed because of it — a real conflict, not a code fault.
      const email = `${NS}-cap-${role}@example.com`;
      const token = await tokenFor(email);

      await dataSource.query(
        `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
            SET tm.role = ? WHERE u.email = ?`,
        [role, email],
      );

      return token;
    }

    const call = (path: string, token: string) =>
      request(app.getHttpServer())
        .get(`/v1/capability-probe/${path}`)
        .set('Authorization', `Bearer ${token}`);

    /**
     * The single most important line in the matrix, asserted through the API
     * rather than against the table — a client hiding the button is a courtesy,
     * this is the rule.
     */
    it('lets an editor edit but not publish', async () => {
      const token = await tokenAs('editor');

      expect((await call('edit', token)).status).toBe(200);
      expect((await call('publish', token)).status).toBe(403);
    }, 40_000);

    it('lets an owner do both', async () => {
      const token = await tokenAs('owner');

      expect((await call('edit', token)).status).toBe(200);
      expect((await call('publish', token)).status).toBe(200);
    }, 40_000);

    it('refuses a viewer everything that changes state', async () => {
      const token = await tokenAs('viewer');

      expect((await call('edit', token)).status).toBe(403);
      expect((await call('publish', token)).status).toBe(403);
    }, 40_000);

    /** A bookkeeper needs invoices, not the option builder. */
    it('gives billing money but not configuration', async () => {
      const token = await tokenAs('billing');

      expect((await call('billing', token)).status).toBe(200);
      expect((await call('edit', token)).status).toBe(403);
    }, 40_000);

    /** Ownership acts stay with the owner. */
    it('refuses an admin the billing capability', async () => {
      const token = await tokenAs('admin');

      expect((await call('edit', token)).status).toBe(200);
      expect((await call('billing', token)).status).toBe(403);
    }, 40_000);

    /**
     * 403, not 404. The caller is a legitimate member and the resource plainly
     * exists — hiding that would make "why can't I publish?" unanswerable.
     * Cross-*tenant* access is the case that gets a 404; this is cross-*role*.
     */
    it('answers with INSUFFICIENT_ROLE rather than pretending the route is missing', async () => {
      const token = await tokenAs('viewer');
      const response = await call('publish', token);

      expect(response.status).toBe(403);
      expect(response.body.error?.code).toBe('INSUFFICIENT_ROLE');
    }, 40_000);

    /**
     * The window that matters when someone is removed for cause: the token still
     * says `owner`, and the stored role no longer does.
     */
    it('applies a demotion on the next request, not when the token expires', async () => {
      const token = await tokenAs('owner');
      expect((await call('publish', token)).status).toBe(200);

      await dataSource.query(
        `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
            SET tm.role = 'viewer' WHERE u.email = ?`,
        [`${NS}-cap-owner@example.com`],
      );

      // Same token, same second.
      expect((await call('publish', token)).status).toBe(403);
    }, 40_000);
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
