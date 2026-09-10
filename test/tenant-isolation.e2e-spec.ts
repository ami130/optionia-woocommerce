import {
  Body,
  Controller,
  Delete,
  Get,
  INestApplication,
  Module,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import * as request from 'supertest';
import { DataSource, Repository } from 'typeorm';

import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { TenantGuard } from '../src/auth/guards/tenant.guard';
import { TenantScopedRepository } from '../src/common/tenancy/tenant-scoped.repository';
import { OptionSet } from '../src/option-sets/entities/option-set.entity';
import { bootstrapTestApp, tokenFrom } from './harness';

/**
 * Tenant isolation, permanently (M6.6).
 *
 * **This suite is the acceptance criterion for AC5 and runs forever.** Two
 * tenants with real object graphs, and every vector M6.6 names asserted through
 * HTTP: direct id, list, nested resources, update, delete, bulk, filter/search
 * parameters, and sort parameters.
 *
 * It deliberately attacks through a controller rather than calling the
 * repository, because that is the path an attacker has. A repository test proves
 * the predicate is applied; this proves nothing above it can remove one.
 */
class ScopedSets extends TenantScopedRepository<OptionSet> {
  constructor(repository: Repository<OptionSet>) {
    super(repository);
  }
}

/**
 * A controller that passes caller input through to the data layer as
 * permissively as anything realistic would — filters, sort, relations and
 * pagination all reach the repository. If isolation depends on a controller
 * being careful, it is not isolation.
 */
@Controller('isolation')
@UseGuards(JwtAuthGuard, TenantGuard)
class IsolationController {
  constructor(private readonly sets: ScopedSets) {}

  @Get()
  async list(@Query() query: Record<string, string>): Promise<{ ids: string[] }> {
    const rows = await this.sets.find({
      // A caller-supplied tenantId is passed straight through, exactly as a
      // careless controller would. Isolation must not depend on this being
      // filtered here — if it does, the next controller written is the hole.
      ...(query.name || query.tenantId
        ? {
            where: {
              ...(query.name ? { name: query.name } : {}),
              ...(query.tenantId ? { tenantId: query.tenantId } : {}),
            } as never,
          }
        : {}),
      ...(query.sort ? { order: { [query.sort]: 'DESC' } as never } : {}),
      ...(query.relations ? { relations: { tenant: true } as never } : {}),
      ...(query.take ? { take: Number(query.take) } : {}),
    });

    return { ids: rows.map((r) => r.id) };
  }

  @Get(':id')
  async byId(@Param('id') id: string): Promise<{ id: string } | null> {
    const row = await this.sets.findById(id);

    return row ? { id: row.id } : null;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ affected: number }> {
    const result = await this.sets.update({ id } as never, body as never);

    return { affected: result.affected ?? 0 };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ affected: number }> {
    const result = await this.sets.delete({ id } as never);

    return { affected: result.affected ?? 0 };
  }

  /** Bulk: the shape most likely to lose a predicate somewhere in a loop. */
  @Patch()
  async bulk(@Body() body: { ids: string[] }): Promise<{ affected: number }> {
    let affected = 0;

    for (const id of body.ids ?? []) {
      const result = await this.sets.update({ id } as never, { name: 'bulk-renamed' } as never);
      affected += result.affected ?? 0;
    }

    return { affected };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [IsolationController],
  providers: [
    {
      provide: ScopedSets,
      inject: [DataSource],
      useFactory: (dataSource: DataSource): ScopedSets =>
        new ScopedSets(dataSource.getRepository(OptionSet)),
    },
  ],
})
class IsolationModule {}

describe('tenant isolation (M6.6)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'iso';
  const PASSWORD = 'a-sufficiently-long-password';

  let tokenA = '';
  let tenantA = '';
  let tenantB = '';

  /** Ids of B's rows, which A must never reach by any route. */
  const B_IDS = [`${NS}-b-set-1`, `${NS}-b-set-2`];
  const A_IDS = [`${NS}-a-set-1`, `${NS}-a-set-2`];

  beforeAll(async () => {
    // Bootstrapped through the shared harness so the pipe matches `main.ts`.
    // This suite previously ran `new ValidationPipe({ transform: true })` — no
    // `whitelist`, no `forbidNonWhitelisted` — which meant the permanent
    // acceptance criterion for tenant scoping was asserting against a pipe
    // strictly weaker than the one shipped.
    app = await bootstrapTestApp([IsolationModule]);

    dataSource = app.get(DataSource);
    await cleanup();

    tenantA = await register('a');
    tenantB = await register('b');
    tokenA = await login('a');

    await seedSets(tenantA, 'a');
    await seedSets(tenantB, 'b');
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM option_sets WHERE id LIKE '${NS}-%'`);
    await dataSource.query(`DELETE FROM stores WHERE id LIKE '${NS}-%'`);
    await dataSource.query(
      `DELETE tm FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email LIKE '${NS}-%'`,
    );
    await dataSource.query(`DELETE FROM users WHERE email LIKE '${NS}-%'`);
    await dataSource.query(
      `DELETE t FROM tenants t WHERE t.slug LIKE '${NS}-%' OR t.name LIKE '${NS}-%'`,
    );
  }

  async function register(which: string): Promise<string> {
    const email = `${NS}-${which}@example.com`;

    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: `${NS}-${which}` });
    await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [email]);

    const [row] = await dataSource.query(
      `SELECT tm.tenantId AS id FROM tenant_members tm
         JOIN users u ON u.id = tm.userId WHERE u.email = ?`,
      [email],
    );

    return row.id;
  }

  async function login(which: string): Promise<string> {
    const email = `${NS}-${which}@example.com`;
    const response = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD });

    return tokenFrom(response, email);
  }

  async function seedSets(tenantId: string, which: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                           createdAt, updatedAt)
       VALUES (?, ?, 'woocommerce', ?, ?, 'connected', 0, NOW(3), NOW(3))`,
      [`${NS}-${which}-store`, tenantId, which, `https://${which}.example.com`],
    );

    for (const n of [1, 2]) {
      await dataSource.query(
        `INSERT INTO option_sets
           (id, tenantId, storeId, name, status, version, rowVersion,
            publishedConfigVersion, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, 'draft', 1, 1, 0, NOW(3), NOW(3), '1970-01-01 00:00:00.000')`,
        [`${NS}-${which}-set-${n}`, tenantId, `${NS}-${which}-store`, `shared-name-${n}`],
      );
    }
  }

  const asA = (method: 'get' | 'patch' | 'delete', path: string) =>
    request(app.getHttpServer())[method](`/v1/isolation${path}`).set(
      'Authorization',
      `Bearer ${tokenA}`,
    );

  it('sets up two tenants with distinct data', () => {
    expect(tenantA).toBeTruthy();
    expect(tenantB).toBeTruthy();
    expect(tenantA).not.toBe(tenantB);
  });

  describe('direct id access', () => {
    it('returns A’s own row', async () => {
      const response = await asA('get', `/${A_IDS[0]}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(A_IDS[0]);
    });

    /**
     * The most direct attack: an id handed over in a support ticket or guessed
     * from a sequence. It must be indistinguishable from an id that never
     * existed — a 403 would confirm the row is real (ADR-010).
     */
    it('refuses B’s id exactly as it refuses a nonexistent one', async () => {
      const foreign = await asA('get', `/${B_IDS[0]}`);
      const missing = await asA('get', '/no-such-id-at-all');

      expect(foreign.status).toBe(missing.status);
      expect(foreign.body.data).toEqual(missing.body.data);
    });
  });

  describe('list endpoints', () => {
    it('lists only A’s rows', async () => {
      const response = await asA('get', '');

      expect(response.body.data.ids.sort()).toEqual([...A_IDS].sort());
    });

    it('never includes a B id in any listing', async () => {
      const response = await asA('get', '?take=100');

      B_IDS.forEach((id) => expect(response.body.data.ids).not.toContain(id));
    });
  });

  describe('filter and search parameters', () => {
    /**
     * Both tenants have rows named `shared-name-1`. A filter that matches both
     * must still return only A's — this is the vector where a `where` merged in
     * the wrong order leaks everything.
     */
    it('filters within the tenant, not across it', async () => {
      const response = await asA('get', '?name=shared-name-1');

      expect(response.body.data.ids).toEqual([A_IDS[0]]);
    });

    it('returns nothing rather than B’s row for a filter only B matches', async () => {
      const response = await asA('get', '?name=shared-name-2&take=1');

      expect(response.body.data.ids.every((id: string) => id.startsWith(`${NS}-a-`))).toBe(true);
    });
  });

  describe('a caller naming another tenant directly', () => {
    /**
     * The vector a filter test alone misses. If the predicate is merged *before*
     * the caller's `where`, a supplied `tenantId` overwrites it and the endpoint
     * returns another tenant's rows in full.
     *
     * Added after a mutation that reversed the merge order passed the entire
     * suite — every other test filters on a column the attacker does not control
     * the meaning of.
     */
    it('cannot read B by naming B’s tenant id', async () => {
      const response = await asA('get', `?tenantId=${tenantB}`);

      B_IDS.forEach((id) => expect(response.body.data.ids).not.toContain(id));
    });

    it('still returns only A’s rows when naming B', async () => {
      const response = await asA('get', `?tenantId=${tenantB}`);

      response.body.data.ids.forEach((id: string) =>
        expect(id.startsWith(`${NS}-a-`)).toBe(true),
      );
    });

    it('cannot combine a name filter with another tenant’s id', async () => {
      const response = await asA('get', `?name=shared-name-1&tenantId=${tenantB}`);

      expect(response.body.data.ids).not.toContain(B_IDS[0]);
    });
  });

  describe('sort parameters', () => {
    /** Ordering must not widen the result set, only rearrange it. */
    it('sorts within the tenant', async () => {
      const response = await asA('get', '?sort=name');

      expect(response.body.data.ids.sort()).toEqual([...A_IDS].sort());
    });

    it('sorting by any column still excludes B', async () => {
      for (const column of ['name', 'createdAt', 'status']) {
        const response = await asA('get', `?sort=${column}`);

        B_IDS.forEach((id) => expect(response.body.data.ids).not.toContain(id));
      }
    });
  });

  describe('nested resources', () => {
    /** A relation traversal must not become a route into another tenant. */
    it('loading relations does not widen the result set', async () => {
      const response = await asA('get', '?relations=1');

      expect(response.body.data.ids.sort()).toEqual([...A_IDS].sort());
    });
  });

  describe('update', () => {
    it('updates A’s own row', async () => {
      const response = await asA('patch', `/${A_IDS[0]}`).send({ name: 'renamed-by-a' });

      expect(response.body.data.affected).toBe(1);
    });

    it('cannot touch B’s row', async () => {
      const response = await asA('patch', `/${B_IDS[0]}`).send({ name: 'hijacked' });

      expect(response.body.data.affected).toBe(0);

      const [row] = await dataSource.query(`SELECT name FROM option_sets WHERE id = ?`, [
        B_IDS[0],
      ]);
      expect(row.name).toBe('shared-name-1');
    });

    /** Moving a row into another tenant is a write leak and just as damaging. */
    it('cannot move a row into another tenant', async () => {
      await asA('patch', `/${A_IDS[1]}`).send({ tenantId: tenantB });

      const [row] = await dataSource.query(`SELECT tenantId FROM option_sets WHERE id = ?`, [
        A_IDS[1],
      ]);
      expect(row.tenantId).toBe(tenantA);
    });
  });

  describe('delete', () => {
    it('cannot delete B’s row', async () => {
      const response = await asA('delete', `/${B_IDS[1]}`);

      expect(response.body.data.affected).toBe(0);

      const [row] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM option_sets WHERE id = ?`,
        [B_IDS[1]],
      );
      expect(Number(row.n)).toBe(1);
    });
  });

  describe('bulk operations', () => {
    /**
     * The shape most likely to lose a predicate: a loop where one iteration
     * takes a different path. A mixed batch must apply to A's ids and silently
     * skip B's.
     */
    it('applies to A’s ids and skips B’s in a mixed batch', async () => {
      const response = await asA('patch', '').send({ ids: [...A_IDS, ...B_IDS] });

      expect(response.body.data.affected).toBe(A_IDS.length);

      const rows = await dataSource.query(
        `SELECT id FROM option_sets WHERE name = 'bulk-renamed' ORDER BY id`,
      );
      const renamed = rows.map((r: { id: string }) => r.id);

      B_IDS.forEach((id) => expect(renamed).not.toContain(id));
    });
  });

  describe('without authentication', () => {
    it('refuses every route', async () => {
      const paths: Array<['get' | 'patch' | 'delete', string]> = [
        ['get', ''],
        ['get', `/${A_IDS[0]}`],
        ['patch', `/${A_IDS[0]}`],
        ['delete', `/${A_IDS[0]}`],
      ];

      for (const [method, path] of paths) {
        const response = await request(app.getHttpServer())[method](`/v1/isolation${path}`);

        expect(response.status).toBe(401);
      }
    });
  });
});
