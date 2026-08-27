/**
 * Assert the generated OpenAPI spec still describes the same surface as the
 * contract.
 *
 * ## Why this exists
 *
 * `docs/API-CONTRACT.md` is the **design**, written before any controller. The
 * spec is a **description**, generated from the controllers. The plan is
 * explicit that they will occasionally disagree and that *the disagreement is
 * the signal* — a controller drifted from what was agreed.
 *
 * A signal nobody reads is not a signal. `check-api-contract` compares the
 * contract to the router; this compares the **spec** to the contract, which
 * catches a different failure: a route that exists and is documented but is
 * missing from the spec, because a decorator was omitted or a controller never
 * reached `AppModule`. A generated client would simply lack the method, and
 * nobody would notice until someone needed it.
 *
 * ## The coverage floor
 *
 * Like every other check here, this fails when it inspects nothing. A spec with
 * zero paths satisfies every comparison trivially, and "all checks passed" over
 * an empty document is the exact failure this codebase keeps finding.
 */
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/common/openapi/openapi';

/** Below this, the spec is empty enough that the comparison proves nothing. */
const MINIMUM_PATHS = 20;

let failed = false;

function fail(message: string, items: string[] = []): void {
  failed = true;
  console.error(`  x ${message}`);
  items.forEach((item) => console.error(`      ${item}`));
}

function pass(message: string): void {
  console.log(`  ok    ${message}`);
}

/**
 * Routes the spec declares, as `METHOD /v1/path`.
 *
 * OpenAPI writes parameters as `{id}`; the contract and the router write `:id`.
 * Normalised here so the comparison is textual rather than a guess at how a
 * name was derived.
 */
function specRoutes(document: ReturnType<typeof buildOpenApiDocument>): Set<string> {
  const routes = new Set<string>();

  Object.entries(document.paths ?? {}).forEach(([path, item]) => {
    const normalised = path.replace(/\{([^}]+)\}/g, ':$1');

    ['get', 'post', 'patch', 'put', 'delete'].forEach((method) => {
      if ((item as Record<string, unknown>)[method]) {
        routes.add(`${method.toUpperCase()} ${normalised}`);
      }
    });
  });

  return routes;
}

/** Routes the contract marks `[built]`. Mirrors `check-api-contract`'s parser. */
function contractRoutes(markdown: string): Set<string> {
  const deferredAt = markdown.indexOf('## Deferred to later phases');
  const active = deferredAt === -1 ? markdown : markdown.slice(0, deferredAt);
  const routes = new Set<string>();

  for (const rawLine of active.split('\n')) {
    if (!rawLine.includes('[built]')) {
      continue;
    }

    for (const match of rawLine.matchAll(/\b(GET|POST|PATCH|DELETE)\s+(\/[a-z0-9/:_.-]+)/gi)) {
      const routePath = match[2].startsWith('/v1') ? match[2] : `/v1${match[2]}`;

      routes.add(`${match[1].toUpperCase()} ${routePath.replace(/\?.*$/, '')}`);
    }
  }

  return routes;
}

async function main(): Promise<void> {
  console.log('\nChecking the generated OpenAPI spec...\n');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Keep the dependency-resolution error: without it a module missing an
    // import exits silently and the reader has to boot the app by hand.
    logger: ['error'],
  });
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  await app.init();

  const document = buildOpenApiDocument(app);
  const spec = specRoutes(document);

  await app.close();

  // The floor. An empty spec satisfies every comparison below.
  if (spec.size < MINIMUM_PATHS) {
    fail(
      `only ${spec.size} routes in the spec - below the floor of ${MINIMUM_PATHS}. ` +
        `Generation is probably broken, and an empty spec passes every other check here.`,
    );
  } else {
    pass(`${spec.size} routes described`);
  }

  const contract = contractRoutes(
    readFileSync(join(__dirname, '..', 'docs', 'API-CONTRACT.md'), 'utf8'),
  );

  /**
   * A route the contract calls built, absent from the spec.
   *
   * This is the drift the plan describes: the controller and the design have
   * parted company, or a controller is not reachable from `AppModule` at all.
   */
  const missingFromSpec = [...contract].filter((route) => !spec.has(route));

  if (missingFromSpec.length > 0) {
    fail('documented as [built] but missing from the generated spec:', missingFromSpec.sort());
  } else {
    pass('every [built] route appears in the spec');
  }

  /**
   * A route in the spec the contract does not describe.
   *
   * `check-api-contract` catches this against the router; repeating it against
   * the spec costs one comparison and catches the case where the two derive
   * their route lists differently.
   */
  const undocumented = [...spec].filter(
    (route) => !contract.has(route) && !route.startsWith('GET /health'),
  );

  if (undocumented.length > 0) {
    fail('in the spec but not documented as [built]:', undocumented.sort());
  } else {
    pass('every spec route is documented');
  }

  /** Three realms, declared separately (AC8). */
  const schemes = Object.keys(document.components?.securitySchemes ?? {});
  const missingSchemes = ['tenant', 'platform', 'store'].filter(
    (scheme) => !schemes.includes(scheme),
  );

  if (missingSchemes.length > 0) {
    fail('security schemes missing - the three realms must stay distinct:', missingSchemes);
  } else {
    pass('all three identity realms are declared');
  }

  if (failed) {
    console.error('\nOpenAPI checks failed.\n');
    process.exitCode = 1;

    return;
  }

  console.log(
    `\nAll OpenAPI checks passed. ${spec.size} routes described, ${contract.size} built.\n`,
  );
}

main().catch((error: unknown) => {
  console.error(`\ncheck-openapi failed to run: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
