import * as compression from 'compression';
import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware';
import { BODY_LIMIT } from '../src/common/http/body-limit';
import { flattenValidationErrors } from '../src/common/validation/flatten-validation-errors';
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
 *
 * It recurred. An audit after `[8b]` found four suites still bootstrapping by
 * hand with weaker pipes than `main.ts` ships: two omitted both
 * `forbidNonWhitelisted` and `enableImplicitConversion`, and `tenant-isolation`
 * — the permanent acceptance criterion for tenant scoping — ran with no
 * `whitelist` at all. Each would pass while the shipped pipe rejected the very
 * request under test. Copying four options correctly is not the kind of thing
 * that stays correct; calling one function is.
 *
 * `extraImports` exists for suites that mount a test-only controller, which is
 * why they had hand-rolled bootstraps in the first place. Taking modules here
 * lets them share this configuration instead of re-deriving it.
 */
export async function bootstrapTestApp(
  extraImports: readonly unknown[] = [],
): Promise<INestApplication> {
  loadDotenv();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...extraImports],
  } as never).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  const context = new RequestContextMiddleware();

  app.use(context.use.bind(context));

  /**
   * The same compression `main.ts` installs, with the same threshold.
   *
   * A harness that skipped it would leave every assertion about response
   * encoding untestable — and M9.1 requires the config document to be gzipped,
   * so "untestable" would mean "unverified" for a stated requirement.
   */
  app.use(compression({ threshold: 1024 }));

  /**
   * The same body limit `main.ts` installs (ADR-072).
   *
   * 🔴 **Found by a test that failed for the wrong reason.** Without this the
   * harness ran on Express's 100 kb default while production ran on 1 MB, so a
   * 529 kB batch — comfortably legal — answered `413` here and `200` there.
   * Every payload-size assertion was being made against a limit the product
   * does not have.
   *
   * ⚠️ **This bootstrap duplicates `main.ts` by hand**, which is why the drift
   * was possible at all. The compression note above states the principle: a
   * harness that skips what production installs makes the difference
   * untestable. The body limit is the same case, and was missed.
   *
   * 📌 **The limit is imported, never retyped** — a limit written out in two
   * files is a limit that drifts, which is the defect this block exists to
   * close.
   *
   * ✏️ An earlier version of this note claimed `app.use(json(…))` leaves a
   * second parser in the chain and that switching to `useBodyParser` fixed a
   * run of gate failures. **Both halves were wrong**: Nest filters its default
   * parsers by function name and `express.json()` is named `jsonParser`, so
   * either form suppresses it — and the failures had a cause this never found.
   */
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  app.setGlobalPrefix('v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },

      // The same factory `main.ts` installs, imported rather than re-written.
      // Without it the pipe emits flat strings and every suite asserting on
      // `{ field, message }` is asserting on a shape the application does not
      // produce — which is what `auth-http` was doing with its own copy.
      exceptionFactory: (errors) => new BadRequestException(flattenValidationErrors(errors)),
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
      /*
       * ⚠️ **The body alone is not enough when this fails.**
       *
       * An empty body here means the response was *truncated*, not refused —
       * every error this API produces carries `{error, meta}`. Content type and
       * raw text distinguish the two, and without them a truncated response
       * reads as a routing answer. That cost several audits: `404 {}` was read
       * as "route not found" when the real fault was a double write further up
       * the stack (see `ApiResponseInterceptor`).
       */
      throw new Error(
        `Harness failed to register ${email}: ${registered.status} ` +
          `${JSON.stringify(registered.body?.error ?? registered.body)} ` +
          `ctype=${JSON.stringify(registered.headers?.['content-type'])} ` +
          `raw=${JSON.stringify(String(registered.text ?? '').slice(0, 200))}`,
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

    await dataSource.query(`DELETE FROM email_deliveries WHERE recipient LIKE '${namespace}-%'`);
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
 * The access token from a login response, or a failure naming the status.
 *
 * 🔴 **An unchecked login is how a permission test passes for the wrong
 * reason.** A throttled login returns 429, `body.data` is undefined, the token
 * becomes `undefined`, and every request after it goes out as
 * `Bearer undefined` — so a test asserting "a viewer may read" fails with a
 * routing error, and one asserting "a viewer may not write" **passes without
 * sending a credential at all**.
 *
 * `createHarness` has guarded this since it was written. Six inline logins
 * across four suites had not, and between them they account for several
 * failures previously filed as environmental: 4 of 78 logins in one gate run
 * came back 429.
 *
 * Exported so the next inline login has somewhere to go that is shorter than
 * writing the check again.
 *
 * @param response The login response.
 * @param email Whose login it was, for the failure message.
 */
export function tokenFrom(response: request.Response, email: string): string {
  if (response.status !== 200) {
    throw new Error(
      `Failed to sign in ${email}: ${response.status} ` +
        `${JSON.stringify(response.body?.error ?? response.body)}`,
    );
  }

  return response.body.data.accessToken as string;
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
    /**
     * Name the request, not just the status.
     *
     * A long-standing intermittent failure reports `404 {}` and nothing else,
     * which says a parent was not visible but not *which* parent — and it has
     * now appeared in five different suites, each time unreproducible alone.
     * `option-authoring` grew per-fixture diagnostics for exactly this; every
     * other suite shares this helper and had none.
     *
     * `supertest` keeps the outgoing request on the response, so the path costs
     * nothing to include and turns "a fixture 404'd" into "creating a value
     * under `/v1/options/<id>/values` 404'd", which names the row to look for.
     */
    const req = (response as unknown as { req?: { method?: string; path?: string } }).req;
    const where = req?.path ? ` [${req.method ?? 'POST'} ${req.path}]` : '';

    throw new Error(
      `Fixture failed to create a ${what}: ${response.status}${where} ` +
        `${JSON.stringify(response.body?.error ?? response.body)}`,
    );
  }

  return response.body.data.id as string;
}

/** Authenticated request builders, so a suite does not repeat the header. */
export function client(app: INestApplication, token: string) {
  const auth = (test: request.Test): request.Test => test.set('Authorization', `Bearer ${token}`);

  return {
    get: (path: string) => auth(request(app.getHttpServer()).get(`/v1${path}`)),
    post: (path: string, body: object = {}) =>
      auth(request(app.getHttpServer()).post(`/v1${path}`)).send(body),
    patch: (path: string, body: object = {}) =>
      auth(request(app.getHttpServer()).patch(`/v1${path}`)).send(body),
    delete: (path: string) => auth(request(app.getHttpServer()).delete(`/v1${path}`)),
  };
}
