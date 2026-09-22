import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { IS_PUBLIC } from '../src/auth/guards/public.decorator';
import { buildOpenApiDocument, serveOpenApi } from '../src/common/openapi/openapi';

/**
 * The generated OpenAPI spec (step 7m, the phase exit criterion).
 *
 * The spec is a **description** of the controllers, not the contract — that is
 * `docs/API-CONTRACT.md`, written first. These tests assert the description is
 * complete and honest, and that serving it is disabled where it would be a
 * liability.
 */
describe('openapi (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    loadDotenv();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1', { exclude: ['health'] });
    serveOpenApi(app, true);
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('the document', () => {
    it('describes every route the router registers', () => {
      const document = buildOpenApiDocument(app);
      const paths = Object.keys(document.paths ?? {});

      // A floor, not an exact count: the check script asserts the precise
      // comparison against the contract. Here the point is that generation
      // produced something, because an empty spec passes every shape assertion
      // below without meaning anything.
      expect(paths.length).toBeGreaterThan(20);
    }, 60_000);

    /**
     * Three realms that must never blur (AC8). A store token must not be
     * accepted on `/option-sets`, and modelling them as one scheme would let a
     * generated client offer either interchangeably.
     */
    it('declares the three identity realms separately', () => {
      const schemes = buildOpenApiDocument(app).components?.securitySchemes ?? {};

      expect(Object.keys(schemes).sort()).toEqual(['platform', 'store', 'tenant']);
    }, 60_000);

    it('is valid OpenAPI 3 with a version and a title', () => {
      const document = buildOpenApiDocument(app);

      expect(document.openapi).toMatch(/^3\./);
      expect(document.info.title).toContain('Optionia');
      expect(document.info.version).toBe('1');
    }, 60_000);

    /** Paths carry the global prefix, or a generated client calls the wrong URL. */
    it('includes the /v1 prefix on API paths', () => {
      const paths = Object.keys(buildOpenApiDocument(app).paths ?? {});
      const versioned = paths.filter((path) => path.startsWith('/v1/'));

      expect(versioned.length).toBeGreaterThan(20);
    }, 60_000);

    /**
     * `/health` is excluded from the prefix (ADR-011) because a probe should
     * not track API versions. If that ever changes, monitoring breaks quietly.
     */
    it('keeps health outside the version prefix', () => {
      const paths = Object.keys(buildOpenApiDocument(app).paths ?? {});

      expect(paths).toContain('/health');
      expect(paths).not.toContain('/v1/health');
    }, 60_000);

    /**
     * The spec passed every earlier assertion while all 21 schemas were
     * `{"properties":{}}` — paths were right and the substance was empty. Route
     * counts measure the dimension that happened to be healthy.
     */
    it('describes properties for every schema', () => {
      const schemas = (buildOpenApiDocument(app).components?.schemas ?? {}) as Record<
        string,
        { properties?: Record<string, unknown> }
      >;

      expect(Object.keys(schemas).length).toBeGreaterThan(15);
      Object.entries(schemas).forEach(([name, schema]) => {
        expect({ name, properties: Object.keys(schema.properties ?? {}).length }).toEqual({
          name,
          properties: expect.any(Number),
        });
        expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
      });
    }, 60_000);

    /**
     * Defining a scheme is not applying one. Every operation declared no
     * security while all three realms sat in `components`, so a generated client
     * would have treated the API as public.
     *
     * **Exemption is decided by `@Public()`, not by a list of paths.** This
     * originally skipped `/v1/auth/` and `/health` by name, which meant adding a
     * genuinely public route anywhere else failed the check, and — far worse —
     * that a route which *lost* its `@Public()` would still be skipped by the
     * path list. Reading the metadata asks the question that matters: a route is
     * exempt because it is public, and the moment it stops being public it must
     * declare a realm.
     */
    it('applies a realm to every guarded operation', () => {
      const document = buildOpenApiDocument(app);
      const publicPaths = publicRoutes(app);
      const unsecured: string[] = [];

      Object.entries(document.paths ?? {}).forEach(([path, item]) => {
        ['get', 'post', 'patch', 'delete'].forEach((method) => {
          const operation = (item as Record<string, unknown>)[method] as
            | { security?: unknown }
            | undefined;

          if (operation && !operation.security && !publicPaths.has(`${method} ${path}`)) {
            unsecured.push(`${method.toUpperCase()} ${path}`);
          }
        });
      });

      expect(unsecured).toEqual([]);
    }, 60_000);

    /**
     * The exemption must not be able to swallow everything.
     *
     * A bug making `publicRoutes` return every route would turn the check above
     * into a no-op that still passes — the failure mode this codebase keeps
     * meeting. Asserted on the *documented* operations rather than on router
     * internals: a guarded route must carry a realm, so if most operations
     * stopped declaring one the count would collapse.
     */
    it('still requires a realm on the great majority of operations', () => {
      const document = buildOpenApiDocument(app);
      let secured = 0;
      let total = 0;

      Object.values(document.paths ?? {}).forEach((item) => {
        ['get', 'post', 'patch', 'delete'].forEach((method) => {
          const operation = (item as Record<string, unknown>)[method] as
            | { security?: unknown }
            | undefined;

          if (!operation) {
            return;
          }

          total += 1;

          if (operation.security) {
            secured += 1;
          }
        });
      });

      // 37 of 47 today: the ten without a realm are `/v1/auth/*` and
      // `/connect/initiate`, every one of them genuinely `@Public()`. The floor
      // is well below that so adding public routes does not fail the build,
      // while a collapse — a realm decorator lost across the board — would.
      expect(total).toBeGreaterThan(30);
      expect(secured).toBeGreaterThan(total * 0.7);
    }, 60_000);

    /**
     * Adding an `ApiResponse` suppresses the success response Nest infers, so
     * declaring only errors leaves an operation describing nothing but failure.
     */
    it('declares a success status on every operation', () => {
      const document = buildOpenApiDocument(app);
      const withoutSuccess: string[] = [];

      Object.entries(document.paths ?? {}).forEach(([path, item]) => {
        ['get', 'post', 'patch', 'delete'].forEach((method) => {
          const operation = (item as Record<string, unknown>)[method] as
            | { responses?: Record<string, unknown> }
            | undefined;

          if (
            operation &&
            !Object.keys(operation.responses ?? {}).some((code) => code.startsWith('2'))
          ) {
            withoutSuccess.push(`${method.toUpperCase()} ${path}`);
          }
        });
      });

      expect(withoutSuccess).toEqual([]);
    }, 60_000);

    /** The contract documents sixteen error codes; the spec described none. */
    it('describes the failures a caller must handle', () => {
      const document = buildOpenApiDocument(app);
      const statuses = new Set<string>();

      Object.values(document.paths ?? {}).forEach((item) => {
        ['get', 'post', 'patch', 'delete'].forEach((method) => {
          const operation = (item as Record<string, unknown>)[method] as
            | { responses?: Record<string, unknown> }
            | undefined;

          Object.keys(operation?.responses ?? {}).forEach((code) => statuses.add(code));
        });
      });

      ['400', '401', '403', '404', '409'].forEach((code) =>
        expect([...statuses]).toContain(code),
      );
    }, 60_000);

    it('names the contract as the authority, not itself', () => {
      expect(buildOpenApiDocument(app).info.description).toContain('API-CONTRACT.md');
    }, 60_000);
  });

  describe('serving it', () => {
    it('serves the explorer and the raw document', async () => {
      expect((await request(app.getHttpServer()).get('/docs')).status).toBeLessThan(400);

      const json = await request(app.getHttpServer()).get('/docs/openapi.json');

      expect(json.status).toBe(200);
      expect(json.body.openapi).toMatch(/^3\./);
      expect(Object.keys(json.body.paths).length).toBeGreaterThan(20);
    }, 60_000);

    /**
     * The spec itself is harmless — every path is known to anyone holding the
     * plugin. The **explorer** issues live requests, and one pointed at
     * production data is a footgun handed to whoever finds the URL.
     */
    it('is not served when disabled', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const closed = moduleRef.createNestApplication();

      closed.setGlobalPrefix('v1', { exclude: ['health'] });
      serveOpenApi(closed, false);
      await closed.init();

      try {
        expect((await request(closed.getHttpServer()).get('/docs')).status).toBe(404);
        expect((await request(closed.getHttpServer()).get('/docs/openapi.json')).status).toBe(404);
      } finally {
        await closed.close();
      }
    }, 120_000);
  });

  describe('the check that reads the disagreement', () => {
    /**
     * The plan's reasoning only holds if something compares the two. A spec
     * generated and never checked against the contract is a description nobody
     * reads.
     */
    it('exists, and states why', () => {
      const script = readFileSync('bin/check-openapi.ts', 'utf8');

      expect(script).toContain('the disagreement is');
      expect(script).toContain('MINIMUM_PATHS');
    });

    it('is wired into the verification scripts', () => {
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      };

      expect(JSON.stringify(packageJson.scripts)).toContain('check-openapi');
    });
  });
});

/**
 * Every route path exempt from declaring a realm, because it is `@Public()`.
 *
 * Two sources, because `@Public()` may sit on a method **or** on a controller:
 * the handler carries method-level metadata, and the container carries the
 * class-level kind that `/health` and `/auth/*` use. Nest's own guard resolves
 * both via `getAllAndOverride`; this mirrors that rather than picking one and
 * silently missing the other — checking only the handler reported `/health` as
 * unguarded, which is how this was found.
 */
function publicRoutes(app: INestApplication): Set<string> {
  const found = new Set<string>();

  // Class-level: every route of a controller marked `@Public()`.
  const container = (app as unknown as { container: ClassContainer }).container;

  /**
   * The base path of every controller marked `@Public()`.
   *
   * Derived from the controller's own `@Controller('…')` metadata rather than
   * hardcoded, so moving or renaming one cannot leave a stale exemption behind.
   * `/health` is excluded from the global prefix, which is why both shapes are
   * accepted.
   */
  const publicPrefixes: string[] = [];

  for (const [, module] of container.getModules()) {
    for (const [, wrapper] of module.controllers) {
      if (!wrapper.metatype || Reflect.getMetadata(IS_PUBLIC, wrapper.metatype) !== true) {
        continue;
      }

      const base = Reflect.getMetadata('path', wrapper.metatype);

      if (typeof base === 'string' && base.length > 0) {
        publicPrefixes.push(base.replace(/^\/+|\/+$/g, ''));
      }
    }
  }

  const server = app.getHttpServer() as RouterHost;
  const router = server._events?.request?.router ?? server._events?.request?._router;

  for (const layer of router?.stack ?? []) {
    const handler = layer.route?.stack?.[0]?.handle;
    const path = layer.route?.path;

    if (!handler || typeof path !== 'string') {
      continue;
    }

    const isPublic =
      // Method-level `@Public()`, which the handler carries directly.
      Reflect.getMetadata(IS_PUBLIC, handler) === true ||
      // Class-level, matched on the controller's own base path.
      publicPrefixes.some(
        (prefix) => path === `/${prefix}` || path.startsWith(`/v1/${prefix}/`),
      );

    if (isPublic) {
      /*
       * ✏️ **Recorded in OpenAPI's parameter syntax, not Express's.**
       *
       * The router reports `/v1/plugin/download/:version`; the generated document
       * says `/v1/plugin/download/{version}`. The caller compares against the
       * document, so a parameterised public route never matched and was reported
       * as an unsecured operation.
       *
       * 🔴 Invisible until M20b.3, because **no public route had ever taken a
       * path parameter** — `/auth/*`, `/store/config` and `/health` are all
       * fixed paths. The first one that did failed a gate it satisfied.
       */
      const documented = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

      Object.keys(layer.route?.methods ?? {}).forEach((method) => {
        found.add(`${method} ${path}`);
        found.add(`${method} ${documented}`);
      });
    }
  }

  return found;
}

interface ClassContainer {
  getModules(): Map<unknown, { controllers: Map<unknown, { metatype?: { name: string } }> }>;
}

interface RouterHost {
  _events?: {
    request?: {
      router?: { stack?: RouterLayer[] };
      _router?: { stack?: RouterLayer[] };
    };
  };
}

interface RouterLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack?: Array<{ handle?: unknown }>;
  };
}
