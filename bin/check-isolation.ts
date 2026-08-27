/**
 * Assert every tenant-scoped route has a negative test.
 *
 * ## Why a script rather than a test
 *
 * M6.6 asks that *"every tenant-scoped endpoint has a passing negative test"*.
 * Twelve suites already contain a cross-tenant assertion, and that was the
 * problem: no single place could answer whether the set was **complete**, so a
 * route added without one joined a green suite unnoticed.
 *
 * `isolation-matrix.e2e-spec.ts` drives every route it knows about. This asserts
 * it knows about every route the router registers — the part a test of the
 * routes cannot check about itself.
 *
 * A new tenant-scoped endpoint fails here until someone adds a probe, which is
 * the property M6.6 asks for and no scattered assertion provides.
 */
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { IS_PUBLIC } from '../src/auth/guards/public.decorator';

/** Below this, the enumeration is broken and every comparison is vacuous. */
const MINIMUM_ROUTES = 25;

/**
 * Routes with no foreign id to refuse.
 *
 * A collection cannot answer 404 for a resource it was never asked about, so
 * these are covered by asserting the opposite property — that tenant B's
 * results never contain tenant A's rows. Each is named here so the exemption is
 * a decision rather than an oversight, and the matrix suite tests each one.
 */
const COVERED_BY_LEAKAGE_TEST = new Set([
  'GET /v1/option-sets',
  'GET /v1/audit-logs',
  'POST /v1/option-sets',
  /**
   * `authorize` names a connection request, not a tenant's resource.
   *
   * There is no foreign id to refuse: a request id belongs to a pending
   * handshake that has no tenant until this call gives it one, so the
   * cross-tenant probe the matrix runs has nothing to ask for. The property that
   * matters instead — that one tenant's approval cannot reach another tenant's
   * store at the same URL — is asserted directly in
   * `connect-handshake.e2e-spec`, and mutation-proven there by dropping
   * `tenantId` from the reuse lookup.
   */
  'POST /v1/connect/authorize',
]);

let failed = false;

function fail(message: string, items: string[] = []): void {
  failed = true;
  console.error(`  x ${message}`);
  items.forEach((item) => console.error(`      ${item}`));
}

function pass(message: string): void {
  console.log(`  ok    ${message}`);
}

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

async function tenantScopedRoutes(): Promise<string[]> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error'],
  });
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  await app.init();

  const server = app.getHttpAdapter().getInstance() as {
    router?: { stack: RouterLayer[] };
    _router?: { stack: RouterLayer[] };
  };
  const stack = server.router?.stack ?? server._router?.stack ?? [];
  const publicPaths = publicRoutePaths(app);
  const routes = new Set<string>();

  for (const layer of stack) {
    const route = layer.route;

    if (!route) {
      continue;
    }

    // Nest's catch-all 404 across every verb, the bare prefix, and the probe.
    if (route.path.includes('*') || /^\/v1\$?$/.test(route.path) || route.path === '/health') {
      continue;
    }

    /**
     * A `@Public()` route has no tenant to cross.
     *
     * Decided by the marker rather than by path. This read
     * `startsWith('/v1/auth/')`, which was right while `/auth/*` was the only
     * unauthenticated realm and wrong the moment `/connect/initiate` appeared —
     * and would have gone on exempting an `/auth` route that *lost* its
     * `@Public()` and became tenant-scoped without a negative test.
     */
    if (publicPaths.has(route.path)) {
      continue;
    }

    Object.keys(route.methods).forEach((method) =>
      routes.add(`${method.toUpperCase()} ${route.path}`),
    );
  }

  await app.close();

  return [...routes].sort();
}

async function main(): Promise<void> {
  console.log('\nChecking tenant isolation coverage...\n');

  const routes = await tenantScopedRoutes();

  if (routes.length < MINIMUM_ROUTES) {
    fail(
      `only ${routes.length} tenant-scoped routes found - below the floor of ` +
        `${MINIMUM_ROUTES}. Enumeration is probably broken, and an empty list ` +
        `satisfies every comparison below.`,
    );
  } else {
    pass(`${routes.length} tenant-scoped routes registered`);
  }

  const matrix = readFileSync(
    join(__dirname, '..', 'test', 'isolation-matrix.e2e-spec.ts'),
    'utf8',
  );

  const unprobed = routes.filter(
    (route) => !COVERED_BY_LEAKAGE_TEST.has(route) && !matrix.includes(`'${route}'`),
  );

  if (unprobed.length > 0) {
    fail(
      'tenant-scoped routes with no negative test (add a probe to the matrix, ' +
        'or name it in COVERED_BY_LEAKAGE_TEST with a reason):',
      unprobed,
    );
  } else {
    pass('every tenant-scoped route has a negative test');
  }

  /**
   * The other half: an exemption must name a route that exists.
   *
   * Without this, the exemption list is a way to silence the check rather than
   * satisfy it — a stale name would sit there covering nothing.
   */
  const staleExemptions = [...COVERED_BY_LEAKAGE_TEST].filter(
    (route) => !routes.includes(route),
  );

  if (staleExemptions.length > 0) {
    fail('exemptions naming routes that no longer exist:', staleExemptions);
  } else {
    pass(`${COVERED_BY_LEAKAGE_TEST.size} collection routes covered by leakage tests`);
  }

  if (failed) {
    console.error('\nIsolation coverage checks failed.\n');
    process.exitCode = 1;

    return;
  }

  console.log(`\nAll isolation checks passed. ${routes.length} routes, every one probed.\n`);
}

main().catch((error: unknown) => {
  console.error(`\ncheck-isolation failed to run: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

/**
 * Paths reachable without authentication, from `@Public()` rather than a list.
 *
 * Covers both placements: the marker on a controller (`/health`, `/auth/*`) and
 * on an individual handler (`/connect/initiate`).
 */
function publicRoutePaths(app: {
  container: {
    getModules(): Map<
      unknown,
      { controllers: Map<unknown, { metatype?: new (...args: never[]) => unknown }> }
    >;
  };
}): Set<string> {
  const paths = new Set<string>();

  const add = (base: unknown, route?: unknown): void => {
    if (typeof base !== 'string') {
      return;
    }

    const prefix = base.replace(/^\/+|\/+$/g, '');

    if (typeof route === 'string') {
      paths.add(`/v1/${prefix}/${route.replace(/^\/+/, '')}`.replace(/\/+$/, ''));

      return;
    }

    paths.add(`/${prefix}`);
    paths.add(`/v1/${prefix}`);
  };

  for (const [, module] of app.container.getModules()) {
    for (const [, wrapper] of module.controllers) {
      const controller = wrapper.metatype;

      if (!controller) {
        continue;
      }

      const base = Reflect.getMetadata('path', controller);

      if (Reflect.getMetadata(IS_PUBLIC, controller) === true) {
        add(base);

        // Class-level: every handler's full path is public too.
        const proto = controller.prototype as Record<string, unknown>;

        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name !== 'constructor' && typeof proto[name] === 'function') {
            add(base, Reflect.getMetadata('path', proto[name]));
          }
        }

        continue;
      }

      const proto = controller.prototype as Record<string, unknown>;

      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];

        if (
          name !== 'constructor' &&
          typeof handler === 'function' &&
          Reflect.getMetadata(IS_PUBLIC, handler) === true
        ) {
          add(base, Reflect.getMetadata('path', handler));
        }
      }
    }
  }

  return paths;
}
