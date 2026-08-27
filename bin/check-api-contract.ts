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
import { Capability } from '../src/auth/permissions/capabilities';
import { ErrorCode } from '../src/common/errors/error-codes';

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
  /**
   * `logger: false` silences Nest's boot chatter, which would otherwise bury
   * this check's output — but it also silences the dependency-resolution error
   * that explains a failure to boot. `errorLogger` keeps the one that matters:
   * without it a module missing an import exits 1 with no message at all, and
   * the reader is left running the app by hand to find out why.
   */
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error'],
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

    /**
     * `/health` is registered across every verb by the terminus module and is
     * deliberately outside the contract's surface.
     *
     * Excluded here rather than at the comparison, so the reported count is the
     * number of API routes rather than that plus ten framework entries — a count
     * that does not match what a reader can see is a count they stop trusting.
     */
    if (layer.route.path === '/health') {
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
function documentedRoutes(markdown: string): {
  all: Set<string>;
  built: Set<string>;
  marked: Set<string>;
} {
  const deferredAt = markdown.indexOf('## Deferred to later phases');
  const active = deferredAt === -1 ? markdown : markdown.slice(0, deferredAt);

  const all = new Set<string>();
  const built = new Set<string>();
  const marked = new Set<string>();
  const unmarkedDeclarations = new Set<string>();

  /**
   * A marker belongs on a **declaration**, and only declarations are checked.
   *
   * A route is declared on a table row (`| … |`) or a heading (`### …`). It is
   * also *mentioned* in the prose explaining it, and prose must not need a
   * marker — `GET /option-sets/:id/publish-check` is declared in its table and
   * referenced three sections later.
   *
   * The first rule here took the strongest mention, so a marked heading hid an
   * unmarked table row: removing `[7f]` from the `GET /option-sets` row left the
   * check passing. Restricting the requirement to declarations catches that
   * without failing on every explanatory sentence.
   */
  for (const rawLine of active.split('\n')) {
    const line = rawLine.trim();
    const isDeclaration = line.startsWith('|') || line.startsWith('###');
    const isBuilt = line.includes('[built]');
    // `[built]`, `[7a]`…`[7n]`, or `[phase N]`.
    /**
     * `[built]`, a step marker like `[7a]` or `[8d]`, or `[phase N]`.
     *
     * The step pattern was `[7a-n]` — correct while Phase 7 was the only phase
     * with steps, and silently wrong the moment Phase 8 documented `[8d]`. A
     * marker the checker does not recognise reads as *missing*, so the first
     * Phase 8 contract entry failed a gate that was really out of date.
     */
    const hasMarker = isBuilt || /\[\d+[a-z]\]|\[phase \d+\]/i.test(line);

    for (const match of line.matchAll(/\b(GET|POST|PATCH|DELETE)\s+(\/[a-z0-9/:_.-]+)/gi)) {
      const method = match[1].toUpperCase();
      // The contract writes paths with and without the /v1 prefix; normalise.
      const routePath = match[2].startsWith('/v1') ? match[2] : `/v1${match[2]}`;
      const key = `${method} ${routePath.replace(/\?.*$/, '')}`;

      all.add(key);

      if (isBuilt) {
        built.add(key);
      }

      // Only a declaration can satisfy the requirement, and an *unmarked*
      // declaration removes it — otherwise one marked mention covers for a row
      // that lost its marker.
      if (isDeclaration) {
        if (hasMarker) {
          marked.add(key);
        } else {
          unmarkedDeclarations.add(key);
        }
      }
    }
  }

  // A route declared anywhere without a marker fails, even if another
  // declaration carries one.
  for (const key of unmarkedDeclarations) {
    marked.delete(key);
  }

  return { all, built, marked };
}

/**
 * Capability names the contract mentions, from table cells.
 *
 * The contract names a required capability per route, and `CapabilityGuard` fails
 * closed — so a misspelled name is not a documentation typo, it is a route nobody
 * can call. The failure surfaces as a merchant reporting a 403 on a button that
 * should work.
 *
 * Read from backticked cells rather than prose, because prose discusses
 * capabilities in the abstract ("editor cannot publish") without naming one.
 */
function referencedCapabilities(markdown: string): Set<string> {
  const found = new Set<string>();

  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) {
      continue;
    }

    for (const match of line.matchAll(/`([a-z_]+:[a-z_]+)`/g)) {
      found.add(match[1]);
    }
  }

  return found;
}

async function main(): Promise<void> {
  const contractPath = path.join(__dirname, '..', 'docs', 'API-CONTRACT.md');
  const contract = fs.readFileSync(contractPath, 'utf8');

  const documented = documentedRoutes(contract);
  const registered = await registeredRoutes();
  const registeredKeys = new Set(registered.map((r) => `${r.method} ${r.path}`));

  const failures: string[] = [];

  /**
   * A route marked `[built]` that no longer exists.
   *
   * This is the direction the first version claimed to check and did not: its own
   * header said "every route the contract documents is registered" while the code
   * only looped the other way, so a fabricated endpoint added to the document
   * passed silently. The third time in this project a comment asserted a check
   * that was not implemented.
   */
  for (const key of documented.built) {
    if (!registeredKeys.has(key)) {
      failures.push(
        `${key} is marked [built] in docs/API-CONTRACT.md but no route is registered`,
      );
    }
  }

  for (const route of registered) {
    if (!documented.all.has(`${route.method} ${route.path}`)) {
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
  /**
   * Every registered route must be marked `[built]`.
   *
   * Otherwise a new endpoint can be documented as a future step while already
   * being live, and the marker stops describing anything.
   */
  for (const route of registered) {
    const key = `${route.method} ${route.path}`;

    if (documented.all.has(key) && !documented.built.has(key)) {
      failures.push(`${key} is registered but not marked [built] in the contract`);
    }
  }

  /**
   * Every documented route carries a build marker.
   *
   * The contract states this about itself, and it was false for 31 of 39 routes
   * when the marker system was introduced — only the eight built ones were
   * marked. An unmarked route is neither verifiable nor refutable: it cannot be
   * checked against the application in either direction, which is the whole
   * reason markers exist.
   */
  for (const key of documented.all) {
    if (!documented.marked.has(key)) {
      failures.push(
        `${key} is documented without a build marker ([built], [8d] or [phase N])`,
      );
    }
  }

  /**
   * Every capability the contract names must exist in the permission matrix.
   *
   * A name that does not appear there cannot be granted to any role, so the route
   * is refused for everyone including an owner.
   */
  const known = new Set<string>(Object.values(Capability));

  for (const capability of referencedCapabilities(contract)) {
    if (!known.has(capability)) {
      failures.push(
        `capability \`${capability}\` is named in the contract but does not exist ` +
          `in the permission matrix — CapabilityGuard fails closed, so that route ` +
          `would be uncallable`,
      );
    }
  }

  /**
   * Every error code the API can return is mentioned somewhere in the contract.
   *
   * Deliberately "somewhere" rather than "in the table": a code explained in the
   * prose of the endpoint that returns it is documented, and requiring the table
   * specifically would fail on a correct document. What must not happen is a code
   * the API sends that appears nowhere — a plugin author meeting an error they
   * were never told about, in a client that cannot be redeployed.
   */
  const realCodes = new Set<string>(Object.values(ErrorCode));
  const namedCodes = new Set<string>();

  for (const match of contract.matchAll(/`([A-Z][A-Z_]{3,})`/g)) {
    if (realCodes.has(match[1])) {
      namedCodes.add(match[1]);
    }
  }

  for (const code of realCodes) {
    if (!namedCodes.has(code)) {
      failures.push(`error code ${code} exists but is not documented in the contract`);
    }
  }

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
    `All API contract checks passed. ${registered.length} routes registered, ` +
      `${documented.all.size} documented, ${documented.built.size} built, ${documented.marked.size} marked.`,
  );
}

main().catch((error: unknown) => {
  console.error(`\ncheck-api-contract failed to run: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
