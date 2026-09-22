import { Controller, Get, INestApplication, Module, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { StoreRoute } from '../src/auth/guards/store-route.decorator';
import { StoreTokenGuard } from '../src/auth/guards/store-token.guard';
import { TenantGuard } from '../src/auth/guards/tenant.guard';
import { getContext, requireTenantId } from '../src/common/context/request-context';
import { generateToken, hashToken } from '../src/common/crypto/tokens';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * The store realm (M8.6, `[8c]`).
 *
 * A store authenticates with an **opaque credential**, not a JWT, and this suite
 * exists to prove the boundary rather than the happy path: the three columns that
 * make revocation immediate, and the two directions of cross-realm rejection.
 *
 * It probes through a controller rather than calling the guard, because that is
 * the path an attacker has — a guard proven in isolation says nothing about
 * whether the global `JwtAuthGuard` lets a store request reach it.
 */
@Controller('store-probe')
@StoreRoute()
@UseGuards(StoreTokenGuard)
class StoreProbeController {
  /** Echoes the context so the tests can assert what the guard established. */
  @Get()
  whoAmI(): { realm?: string; tenantId?: string; storeId?: string; userId?: string } {
    const ctx = getContext();

    return {
      realm: ctx?.realm,
      tenantId: ctx?.tenantId,
      storeId: ctx?.storeId,
      userId: ctx?.userId,
    };
  }
}

/**
 * A tenant-realm route, for the opposite direction: a store credential must not
 * open a route meant for a signed-in merchant.
 */
@Controller('tenant-probe')
@UseGuards(JwtAuthGuard, TenantGuard)
class TenantProbeController {
  @Get()
  ok(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * `@StoreRoute()` with **no** `StoreTokenGuard` — the mistake the marker has to
 * survive.
 *
 * `@Public()` could not be used for store routes precisely because forgetting
 * the guard behind it would leave a route open to anyone. This controller is the
 * standing proof that `@StoreRoute()` does not have that shape: it reaches the
 * handler unauthenticated, but with no realm, no tenant and no store in context,
 * so it is unusable rather than unprotected — any tenant-scoped query it
 * attempted would throw instead of returning another tenant's rows.
 */
@Controller('unguarded-store-probe')
@StoreRoute()
class UnguardedStoreProbeController {
  @Get()
  context(): { realm?: string; tenantId?: string; storeId?: string } {
    const ctx = getContext();

    return { realm: ctx?.realm, tenantId: ctx?.tenantId, storeId: ctx?.storeId };
  }

  /**
   * What a real handler on such a route would do: ask for the tenant.
   *
   * The empty context above is only half the argument — it shows nothing was
   * established, not that the absence is *safe*. This is the other half, and it
   * is the half that matters: the scoped repository layer calls
   * `requireTenantId()` on every query, and it throws rather than returning
   * unscoped rows. Asserted rather than reasoned about, because "it would throw"
   * is exactly the kind of claim this codebase has been wrong about before.
   */
  @Get('scoped-read')
  scopedRead(): { tenantId: string } {
    return { tenantId: requireTenantId() };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [
    StoreProbeController,
    TenantProbeController,
    UnguardedStoreProbeController,
  ],
})
class StoreProbeModule {}

describe('store realm (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  let tenantToken = '';
  let storeId = '';
  let plaintext = '';

  /** Issue a credential for `storeId` and return its plaintext. */
  async function issueCredential(
    overrides: { revokedAt?: string | null; expiresAt?: string | null } = {},
  ): Promise<string> {
    const token = generateToken();

    await dataSource.query(
      `INSERT INTO store_credentials
         (id, storeId, tokenHash, tokenPrefix, scopes, revokedAt, expiresAt, createdAt, updatedAt)
       VALUES (UUID(), ?, ?, ?, '', ?, ?, NOW(3), NOW(3))`,
      [
        storeId,
        token.hash,
        token.prefix,
        overrides.revokedAt ?? null,
        overrides.expiresAt ?? null,
      ],
    );

    return token.plaintext;
  }

  beforeAll(async () => {
    app = await bootstrapTestApp([StoreProbeModule]);
    harness = await createHarness('storerealm');
    dataSource = app.get(DataSource);

    await harness.cleanup();

    tenantToken = await harness.tenant('a');
    storeId = await harness.store('a');
    plaintext = await issueCredential();
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  const probe = (token?: string): request.Test => {
    const call = request(app.getHttpServer()).get('/v1/store-probe');

    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  describe('a valid credential', () => {
    it('authenticates and establishes the store realm', async () => {
      const response = await probe(plaintext);

      expect(response.status).toBe(200);
      expect(response.body.data.realm).toBe('store');
      expect(response.body.data.storeId).toBe(storeId);
    });

    /**
     * The tenant is reached through the store, because the credential carries
     * none of its own. Without this the scoped repository layer has nothing to
     * scope by and every store-realm query would throw.
     */
    it('resolves the tenant through the store', async () => {
      const response = await probe(plaintext);
      const tenantId = await harness.tenantIdOf('a');

      expect(response.body.data.tenantId).toBe(tenantId);
    });

    /**
     * A store is not a person. Inventing an actor here would put a fabricated
     * user id on every audit entry a store-authenticated write produces.
     */
    it('leaves the user unset', async () => {
      const response = await probe(plaintext);

      expect(response.body.data.userId).toBeUndefined();
    });
  });

  describe('rejection', () => {
    it('refuses a request with no credential', async () => {
      expect((await probe()).status).toBe(401);
    });

    it('refuses an unknown credential', async () => {
      expect((await probe(generateToken().plaintext)).status).toBe(401);
    });

    it('refuses a malformed authorization header', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/store-probe')
        .set('Authorization', plaintext);

      expect(response.status).toBe(401);
    });

    /**
     * The reason the credential is not a JWT (M8.6): revocation has to take
     * effect on the very next request, and a JWT cannot be un-issued.
     */
    it('refuses a revoked credential immediately', async () => {
      const revoked = await issueCredential();

      expect((await probe(revoked)).status).toBe(200);

      await dataSource.query(
        `UPDATE store_credentials SET revokedAt = NOW(3) WHERE tokenHash = ?`,
        [hashToken(revoked)],
      );

      expect((await probe(revoked)).status).toBe(401);
    });

    it('refuses an expired credential', async () => {
      const expired = await issueCredential({
        expiresAt: new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '),
      });

      expect((await probe(expired)).status).toBe(401);
    });

    /**
     * A null `expires_at` means *no expiry*, not "expired at the epoch". Written
     * as its own test because a falsy check reads the two the same way and would
     * lock out every long-lived credential.
     */
    it('accepts a credential with no expiry', async () => {
      const perpetual = await issueCredential({ expiresAt: null });

      expect((await probe(perpetual)).status).toBe(200);
    });

    /**
     * Deleting a store must take its credentials with it.
     *
     * `store_credentials.store_id` is `ON DELETE CASCADE`, so the row is gone and
     * the request lands on the unknown-token path. Asserted explicitly because
     * the guard's `INNER JOIN` would *also* produce a 401 here — the two defences
     * are indistinguishable from the outside, and this names which one is doing
     * the work.
     */
    it('refuses a credential whose store was deleted, and removes the row', async () => {
      const orphanStore = await harness.store('a');
      const token = generateToken();

      await dataSource.query(
        `INSERT INTO store_credentials
           (id, storeId, tokenHash, tokenPrefix, scopes, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, '', NOW(3), NOW(3))`,
        [orphanStore, token.hash, token.prefix],
      );

      expect((await probe(token.plaintext)).status).toBe(200);

      await dataSource.query(`DELETE FROM stores WHERE id = ?`, [orphanStore]);

      const [survivor] = await dataSource.query(
        `SELECT id FROM store_credentials WHERE tokenHash = ?`,
        [token.hash],
      );

      expect(survivor).toBeUndefined();
      expect((await probe(token.plaintext)).status).toBe(401);
    });

    /**
     * The `INNER JOIN` itself, which the cascade above hides.
     *
     * A credential pointing at a store that does not exist cannot arise through
     * the schema — so it is created deliberately, with the constraint suspended,
     * to prove the guard refuses it rather than throwing on a missing tenant. A
     * `LEFT JOIN` here would return a row with a null `tenantId` and put an
     * unscoped request into the data layer.
     */
    it('refuses a credential whose store never existed', async () => {
      const token = generateToken();
      const ghost = randomUUID();

      await dataSource.query(`SET FOREIGN_KEY_CHECKS = 0`);

      try {
        await dataSource.query(
          `INSERT INTO store_credentials
             (id, storeId, tokenHash, tokenPrefix, scopes, createdAt, updatedAt)
           VALUES (UUID(), ?, ?, ?, '', NOW(3), NOW(3))`,
          [ghost, token.hash, token.prefix],
        );
      } finally {
        await dataSource.query(`SET FOREIGN_KEY_CHECKS = 1`);
      }

      try {
        expect((await probe(token.plaintext)).status).toBe(401);
      } finally {
        await dataSource.query(`DELETE FROM store_credentials WHERE tokenHash = ?`, [token.hash]);
      }
    });
  });

  /**
   * The realms must not blur in either direction (AC8). A credential from the
   * wrong realm is a 401, never a 403 — the route should not admit it exists.
   */
  describe('cross-realm', () => {
    it('refuses a tenant JWT on a store route', async () => {
      expect((await probe(tenantToken)).status).toBe(401);
    });

    it('refuses a store credential on a tenant route', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/tenant-probe')
        .set('Authorization', `Bearer ${plaintext}`);

      expect(response.status).toBe(401);
    });

    it('admits a tenant JWT on its own route', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/tenant-probe')
        .set('Authorization', `Bearer ${tenantToken}`);

      expect(response.status).toBe(200);
    });
  });

  /**
   * `@StoreRoute()` is not `@Public()`.
   *
   * The marker tells the global `JwtAuthGuard` to stand aside for a different
   * realm — it does not waive authentication. Losing that distinction is how a
   * store route becomes an anonymous one.
   */
  describe('@StoreRoute() without its guard', () => {
    it('establishes no realm, tenant or store', async () => {
      const response = await request(app.getHttpServer()).get('/v1/unguarded-store-probe');

      expect(response.body.data.realm).toBeUndefined();
      expect(response.body.data.tenantId).toBeUndefined();
      expect(response.body.data.storeId).toBeUndefined();
    });

    /**
     * The fail-closed half, and the reason `@StoreRoute()` is safe where
     * `@Public()` would not be.
     *
     * A route that reaches a handler with no tenant cannot quietly read another
     * tenant's rows — the first scoped query throws. A `500` here is the correct
     * outcome: the route is misconfigured, and failing loudly is what stops the
     * misconfiguration from becoming a data leak.
     */
    it('cannot perform a tenant-scoped read', async () => {
      const response = await request(app.getHttpServer()).get(
        '/v1/unguarded-store-probe/scoped-read',
      );

      expect(response.status).toBe(500);
    });

    /**
     * Not even a valid credential grants context here: only `StoreTokenGuard`
     * reads one, so the marker alone can never authenticate anybody.
     */
    it('grants nothing even to a valid credential', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/unguarded-store-probe')
        .set('Authorization', `Bearer ${plaintext}`);

      expect(response.body.data.realm).toBeUndefined();
      expect(response.body.data.tenantId).toBeUndefined();
    });
  });

  /**
   * `last_used_at` is throttled: the column answers "when did this store last
   * talk to us", asked in days, and writing on every request would make a read
   * path a write path.
   */
  describe('last_used_at', () => {
    async function lastUsed(token: string): Promise<Date | null> {
      const [row] = await dataSource.query(
        `SELECT lastUsedAt FROM store_credentials WHERE tokenHash = ?`,
        [hashToken(token)],
      );

      return row?.lastUsedAt ?? null;
    }

    it('is recorded on first use', async () => {
      const fresh = await issueCredential();

      expect(await lastUsed(fresh)).toBeNull();

      await probe(fresh);

      expect(await lastUsed(fresh)).not.toBeNull();
    });

    it('is not rewritten on an immediately following request', async () => {
      const fresh = await issueCredential();

      await probe(fresh);
      const first = await lastUsed(fresh);

      await probe(fresh);
      const second = await lastUsed(fresh);

      expect(second?.getTime()).toBe(first?.getTime());
    });
  });
});
