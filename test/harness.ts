import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';
import { deleteTenantsFor } from './cleanup-tenants';

/**
 * The shared e2e harness.
 *
 * ## Why this exists
 *
 * Before it, the same setup was written out in every suite: the bootstrap in
 * fourteen, `cleanup` in seventeen, `tenant()` in nine, `idOf` in eight. Three
 * shared helpers existed and every one had been added *reactively, after a bug*.
 *
 * That duplication is not a tidiness complaint — it produced a real defect.
 * Registration slugs a tenant from its **name**, so a suite registering as
 * "Sam Merchant" leaks a `sam-…` tenant that a cleanup matching its own
 * namespace never finds. Three suites had that bug and were fixed one at a time
 * across three rounds, while 6,900 orphaned rows accumulated and eventually
 * turned other suites' fixture creates into intermittent 404s.
 *
 * One implementation cannot be wrong in three places.
 */

/** Every suite uses the same password; complexity is tested where it belongs. */
export const PASSWORD = 'a-sufficiently-long-password';

export interface Harness {
  readonly app: INestApplication;
  readonly dataSource: DataSource;

  /** Register, verify and sign in a member of their own tenant. */
  tenant(which: string): Promise<string>;

  /** The tenant id behind a member created by `tenant()`. */
  tenantIdOf(which: string): Promise<string>;

  /** A connected store owned by that tenant. */
  store(which: string): Promise<string>;

  /** Remove everything this namespace created. */
  cleanup(): Promise<void>;

  close(): Promise<void>;
}

/**
 * Boot the application exactly as `main.ts` does.
 *
 * **The pipe configuration is the part that matters.** A suite that omits
 * `enableImplicitConversion` tests a pipe the application does not use — query
 * parameters arrive as strings, so `?limit=2` fails `@IsInt` and the suite
 * proves something about a configuration nobody ships. That was a real bug in
 * 7e, found only because a fixture happened to fail.
 */
export async function bootstrapTestApp(): Promise<INestApplication> {
  loadDotenv();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  const context = new RequestContextMiddleware();

  app.use(context.use.bind(context));
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.init();

  return app;
}

/**
 * A harness scoped to one namespace.
 *
 * `namespace` prefixes every email this suite creates, and is the only link
 * between a suite and the rows it must remove.
 */
export async function createHarness(namespace: string): Promise<Harness> {
  const app = await bootstrapTestApp();
  const dataSource = app.get(DataSource);

  async function tenantIdOf(which: string): Promise<string> {
    const [row] = await dataSource.query(
      `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email = ?`,
      [`${namespace}-${which}@example.com`],
    );

    if (!row) {
      throw new Error(
        `No tenant for ${namespace}-${which}@example.com — was tenant('${which}') called?`,
      );
    }

    return row.id as string;
  }

  async function tenant(which: string): Promise<string> {
    const email = `${namespace}-${which}@example.com`;

    const registered = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: which, tenantName: `${namespace}-${which}` });

    if (registered.status !== 202 && registered.status !== 201) {
      throw new Error(
        `Harness failed to register ${email}: ${registered.status} ` +
          `${JSON.stringify(registered.body?.error ?? registered.body)}`,
      );
    }

    await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [email]);

    /**
     * The slug is rewritten to the namespace.
     *
     * Registration derives it from the tenant *name*, and a suite passing
     * anything else leaks a tenant no namespace cleanup can find. Rewriting it
     * here means every suite's rows are findable by one rule.
     */
    await dataSource.query(
      `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
         JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
      [`${namespace}-${which}`, email],
    );

    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD });

    if (login.status !== 200) {
      throw new Error(
        `Harness failed to sign in ${email}: ${login.status} ` +
          `${JSON.stringify(login.body?.error ?? login.body)}`,
      );
    }

    return login.body.data.accessToken as string;
  }

  async function store(which: string): Promise<string> {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                           createdAt, updatedAt)
       VALUES (?, ?, 'woocommerce', ?, ?, 'connected', 0, NOW(3), NOW(3))`,
      // The URL carries the store id: `uq_stores_tenant_url` forbids a second
      // store on one tenant with the same address, and a suite creating two
      // would otherwise fail on a constraint that has nothing to do with it.
      [id, await tenantIdOf(which), which, `https://${which}-${id}.example.com`],
    );

    return id;
  }

  /**
   * Remove every row this namespace created, children first.
   *
   * Ordering is by foreign key, not by convenience: `option_values` references
   * `options`, which references `option_groups`, and so on up. Deleting a parent
   * first fails on the constraint.
   */
  async function cleanup(): Promise<void> {
    const tenants = `SELECT id FROM tenants WHERE slug LIKE '${namespace}-%'`;
    const stores = `SELECT id FROM stores WHERE tenantId IN (${tenants})`;

    await dataSource.query(`DELETE FROM audit_logs WHERE tenantId IN (${tenants})`);
    await dataSource.query(
      `DELETE os FROM order_selections os JOIN order_events oe ON oe.id = os.orderEventId
        WHERE oe.storeId IN (${stores})`,
    );
    await dataSource.query(`DELETE FROM order_events WHERE storeId IN (${stores})`);
    await dataSource.query(
      `DELETE vv FROM option_set_versions vv JOIN option_sets s ON s.id = vv.optionSetId
        WHERE s.tenantId IN (${tenants})`,
    );
    await dataSource.query(
      `DELETE r FROM option_rules r JOIN option_sets s ON s.id = r.optionSetId
        WHERE s.tenantId IN (${tenants})`,
    );
    await dataSource.query(
      `DELETE a FROM option_set_assignments a JOIN option_sets s ON s.id = a.optionSetId
        WHERE s.tenantId IN (${tenants})`,
    );
    await dataSource.query(
      `DELETE p FROM presentational_items p JOIN option_groups g ON g.id = p.optionGroupId
         JOIN option_sets s ON s.id = g.optionSetId WHERE s.tenantId IN (${tenants})`,
    );
    await dataSource.query(
      `DELETE v FROM option_values v JOIN options o ON o.id = v.optionId
         JOIN option_groups g ON g.id = o.optionGroupId
         JOIN option_sets s ON s.id = g.optionSetId WHERE s.tenantId IN (${tenants})`,
    );
    await dataSource.query(
      `DELETE o FROM options o JOIN option_groups g ON g.id = o.optionGroupId
         JOIN option_sets s ON s.id = g.optionSetId WHERE s.tenantId IN (${tenants})`,
    );
    await dataSource.query(
      `DELETE g FROM option_groups g JOIN option_sets s ON s.id = g.optionSetId
        WHERE s.tenantId IN (${tenants})`,
    );
    await dataSource.query(`DELETE FROM option_sets WHERE tenantId IN (${tenants})`);
    await dataSource.query(`DELETE FROM stores WHERE tenantId IN (${tenants})`);

    // Finds tenants through their members, which is the only link that survives
    // a suite passing a tenant name of its own.
    await deleteTenantsFor(dataSource, namespace);

    await dataSource.query(
      `DELETE FROM email_deliveries WHERE recipient LIKE '${namespace}-%'`,
    );
    await dataSource.query(`DELETE FROM users WHERE email LIKE '${namespace}-%'`);
    await dataSource.query(`DELETE FROM tenants WHERE slug LIKE '${namespace}-%'`);
  }

  return {
    app,
    dataSource,
    tenant,
    tenantIdOf,
    store,
    cleanup,
    close: () => app.close(),
  };
}

/**
 * A created resource's id, insisting the create worked.
 *
 * Reading `.body.data.id` from a failed response yields `undefined`, and the
 * test then runs against a resource that does not exist — where a duplicate key
 * does not collide and a scoped read finds nothing. That turns a fixture problem
 * into a false assertion about the product, which is how an intermittent
 * "duplicate key returned 201" reached this suite.
 */
export function idOf(response: request.Response, what: string): string {
  if (response.status !== 201) {
    throw new Error(
      `Fixture failed to create a ${what}: ${response.status} ` +
        `${JSON.stringify(response.body?.error ?? response.body)}`,
    );
  }

  return response.body.data.id as string;
}

/** Authenticated request builders, so a suite does not repeat the header. */
export function client(app: INestApplication, token: string) {
  const auth = (test: request.Test): request.Test =>
    test.set('Authorization', `Bearer ${token}`);

  return {
    get: (path: string) => auth(request(app.getHttpServer()).get(`/v1${path}`)),
    post: (path: string, body: object = {}) =>
      auth(request(app.getHttpServer()).post(`/v1${path}`)).send(body),
    patch: (path: string, body: object = {}) =>
      auth(request(app.getHttpServer()).patch(`/v1${path}`)).send(body),
    delete: (path: string) => auth(request(app.getHttpServer()).delete(`/v1${path}`)),
  };
}
