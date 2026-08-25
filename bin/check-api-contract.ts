/**
 * Compare docs/API-CONTRACT.md against the routes the application registers.
 *
 * `docs/DATABASE.md` drifted from the schema twice in Phase 5, both times found
 * by a person reading it. The API contract is consumed by PHP that ships to
 * merchant sites and cannot be redeployed, so it deserves the same treatment
 * rather than the same discovery.
 *
 * Checks two directions:
 *   - every registered route appears in the contract
 *   - every route the contract documents is registered
 *
 * Routes belonging to later phases are listed in the contract's "Deferred"
 * section and are deliberately absent from the application, so they are excluded
 * by reading that section rather than by a hardcoded list here.
 */
import * as fs from 'fs';
import * as path from 'path';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../src/app.module';

/** The verbs this API uses. Anything else is framework plumbing. */
const DOCUMENTED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

interface Route {
  readonly method: string;
  readonly path: string;
}

/** Routes Express has registered, normalised to `METHOD /v1/path`. */
async function registeredRoutes(): Promise<Route[]> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
  });
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  await app.init();

  // Express 5 exposes `app.router`; Express 4 used the private `_router`. Read
  // both, because reading only the old one is how the first version of this
  // check found zero routes and reported success.
  const server = app.getHttpAdapter().getInstance() as {
    router?: { stack: RouterLayer[] };
    _router?: { stack: RouterLayer[] };
  };

  const stack = server.router?.stack ?? server._router?.stack ?? [];
  const routes: Route[] = [];

  for (const layer of stack) {
    if (!layer.route) {
      continue;
    }

    // Nest registers a catch-all across every verb for its 404, and a bare `/v1$`
    // entry for the global prefix. Neither is an endpoint.
    if (layer.route.path.includes('*') || /^\/v1\$?$/.test(layer.route.path)) {
      continue;
    }

    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled && DOCUMENTED_METHODS.has(method.toUpperCase())) {
        routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    }
  }

  await app.close();

  return routes;
}

/**
 * Routes the contract documents.
 *
 * Read from the tables and headings rather than prose: a route is documented when
 * it appears as `METHOD /path`, which is how every table row and heading writes
 * one.
 */
function documentedRoutes(markdown: string): Set<string> {
  const deferredAt = markdown.indexOf('## Deferred to later phases');
  const active = deferredAt === -1 ? markdown : markdown.slice(0, deferredAt);

  const found = new Set<string>();

  for (const match of active.matchAll(/\b(GET|POST|PATCH|DELETE)\s+(\/[a-z0-9/:_.-]+)/gi)) {
    const method = match[1].toUpperCase();
    // The contract writes paths with and without the /v1 prefix; normalise.
    const routePath = match[2].startsWith('/v1') ? match[2] : `/v1${match[2]}`;

    found.add(`${method} ${routePath.replace(/\?.*$/, '')}`);
  }

  return found;
}

async function main(): Promise<void> {
  const contractPath = path.join(__dirname, '..', 'docs', 'API-CONTRACT.md');
  const contract = fs.readFileSync(contractPath, 'utf8');

  const documented = documentedRoutes(contract);
  const registered = await registeredRoutes();

  const failures: string[] = [];

  for (const route of registered) {
    // `/health` is deliberately unversioned and outside the contract's surface.
    if (route.path === '/health') {
      continue;
    }

    if (!documented.has(`${route.method} ${route.path}`)) {
      failures.push(
        `${route.method} ${route.path} is registered but absent from docs/API-CONTRACT.md`,
      );
    }
  }

  /**
   * A check that inspects nothing must fail rather than pass.
   *
   * The first version read `_router`, which Express 5 removed, so it found zero
   * routes and reported `All API contract checks passed. -1 routes registered`.
   * A green check that examined nothing is worse than no check, because it stops
   * anyone looking — the same failure the schema doc checker had (ADR-020).
   */
  if (registered.length === 0) {
    failures.push(
      'no routes were discovered at all — the router shape has changed and this ' +
        'check is inspecting nothing',
    );
  }

  if (failures.length > 0) {
    console.error('\ndocs/API-CONTRACT.md disagrees with the registered routes:\n');
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    console.error('');
    process.exitCode = 1;

    return;
  }

  console.log(
    `All API contract checks passed. ${registered.length - 1} routes registered, ` +
      `${documented.size} documented.`,
  );
}

main().catch((error: unknown) => {
  console.error(`\ncheck-api-contract failed to run: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
