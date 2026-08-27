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
import { IS_PUBLIC } from '../src/auth/guards/public.decorator';
import { buildOpenApiDocument } from '../src/common/openapi/openapi';

/** Below this, the spec is empty enough that the comparison proves nothing. */
const MINIMUM_PATHS = 20;

/**
 * A second floor, on a different dimension.
 *
 * The path floor passed while all 21 schemas were empty: routes were correct and
 * the spec's substance was not. A floor only protects the dimension it counts.
 */
const MINIMUM_SCHEMAS = 15;

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

/** Every operation in the document, with its route for reporting. */
function allOperations(
  document: ReturnType<typeof buildOpenApiDocument>,
): Array<{ route: string; operation: { security?: unknown; responses?: Record<string, unknown> } }> {
  const operations: Array<{
    route: string;
    operation: { security?: unknown; responses?: Record<string, unknown> };
  }> = [];

  Object.entries(document.paths ?? {}).forEach(([path, item]) => {
    ['get', 'post', 'patch', 'put', 'delete'].forEach((method) => {
      const operation = (item as Record<string, unknown>)[method];

      if (operation) {
        operations.push({
          route: `${method.toUpperCase()} ${path}`,
          operation: operation as { security?: unknown; responses?: Record<string, unknown> },
        });
      }
    });
  });

  return operations;
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
  const publicPrefixes = publicControllerPrefixes(app);

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

  /**
   * Declaring a scheme is not applying one.
   *
   * The first version of this check asserted the three schemes existed in
   * `components` and stopped there — and passed while **every one of 42
   * operations declared no security at all**. A generated client would have
   * treated the whole API as public. Defining a scheme nothing references is
   * precisely the shape of guard this codebase keeps finding.
   *
   * **Exemption follows `@Public()`, not a list of paths.** This excluded
   * `/auth/*` and `/health` by name, which failed the moment a public route
   * appeared anywhere else — and, far worse, would have kept excluding one that
   * *lost* its `@Public()`. The marker is the question that matters: a route is
   * exempt because it is public, and the moment it stops being public it must
   * declare a realm.
   */
  const operations = allOperations(document);
  const shouldBeSecured = operations.filter(({ route }) => !isPublicRoute(route, publicPrefixes));
  const unsecured = shouldBeSecured.filter(({ operation }) => !operation.security);

  if (unsecured.length > 0) {
    fail(
      'operations with no security scheme applied (a client would treat them as public):',
      unsecured.map(({ route }) => route).sort(),
    );
  } else {
    pass(`${shouldBeSecured.length} guarded operations declare a realm`);
  }

  /**
   * A schema that describes nothing.
   *
   * Every request body referenced a schema correctly, and all 21 of them were
   * `{"properties":{}}` — the shape a spec has when no property carries an
   * `@ApiProperty` and the CLI plugin is not running. Paths agreed with the
   * contract throughout, which is why the earlier route-count floor said
   * nothing: it measured the dimension that happened to be healthy.
   */
  const schemas = (document.components?.schemas ?? {}) as Record<
    string,
    { properties?: Record<string, unknown> }
  >;
  const emptySchemas = Object.entries(schemas)
    .filter(([, schema]) => Object.keys(schema.properties ?? {}).length === 0)
    .map(([name]) => name);

  if (Object.keys(schemas).length < MINIMUM_SCHEMAS) {
    fail(
      `only ${Object.keys(schemas).length} schemas - below the floor of ${MINIMUM_SCHEMAS}. ` +
        `A spec with no schemas describes no request bodies.`,
    );
  } else if (emptySchemas.length > 0) {
    fail('schemas that describe no properties:', emptySchemas.sort());
  } else {
    pass(`${Object.keys(schemas).length} schemas, all describing properties`);
  }

  /**
   * An operation with no success response.
   *
   * Adding an `ApiResponse` to a method suppresses the success response Nest
   * would otherwise infer, so declaring only errors leaves an operation
   * describing nothing but failure. That happened here — errors alone stripped
   * the `2xx` from all 33 guarded operations — and no assertion noticed.
   */
  const withoutSuccess = operations.filter(
    ({ operation }) =>
      !Object.keys(operation.responses ?? {}).some((code) => code.startsWith('2')),
  );

  if (withoutSuccess.length > 0) {
    fail(
      'operations describing no success response:',
      withoutSuccess.map(({ route }) => route).sort(),
    );
  } else {
    pass('every operation declares a success status');
  }

  /**
   * The contract documents sixteen error codes and their statuses. A spec that
   * describes only success is not a description a client can be generated from.
   */
  const statuses = new Set<string>();

  operations.forEach(({ operation }) =>
    Object.keys(operation.responses ?? {}).forEach((code) => statuses.add(code)),
  );

  const missingStatuses = ['400', '401', '403', '404'].filter(
    (code) => !statuses.has(code),
  );

  if (missingStatuses.length > 0) {
    fail('no operation documents these statuses:', missingStatuses);
  } else {
    pass(`${statuses.size} distinct response statuses described`);
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

/**
 * The base path of every controller carrying `@Public()`, plus the paths of
 * individually public handlers.
 *
 * Read from the container rather than hardcoded, so renaming or moving a public
 * controller cannot leave a stale exemption behind.
 */
function publicControllerPrefixes(app: NestExpressApplication): Set<string> {
  const container = (
    app as unknown as {
      container: {
        getModules(): Map<
          unknown,
          { controllers: Map<unknown, { metatype?: new (...args: never[]) => unknown }> }
        >;
      };
    }
  ).container;

  const prefixes = new Set<string>();

  for (const [, module] of container.getModules()) {
    for (const [, wrapper] of module.controllers) {
      const controller = wrapper.metatype;

      if (!controller) {
        continue;
      }

      // Class-level `@Public()`: every route of the controller is public.
      if (Reflect.getMetadata(IS_PUBLIC, controller) === true) {
        const base = Reflect.getMetadata('path', controller);

        if (typeof base === 'string') {
          prefixes.add(base.replace(/^\/+|\/+$/g, ''));
        }

        continue;
      }

      // Method-level `@Public()`: only the marked handlers are.
      const proto = controller.prototype as Record<string, unknown>;

      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') {
          continue;
        }

        const handler = proto[name];

        if (typeof handler === 'function' && Reflect.getMetadata(IS_PUBLIC, handler) === true) {
          const base = Reflect.getMetadata('path', controller);
          const route = Reflect.getMetadata('path', handler);

          if (typeof base === 'string' && typeof route === 'string') {
            prefixes.add(`${base.replace(/^\/+|\/+$/g, '')}/${route.replace(/^\/+/, '')}`);
          }
        }
      }
    }
  }

  return prefixes;
}

/** Whether a `"METHOD /v1/path"` route is one of the public ones. */
function isPublicRoute(route: string, prefixes: Set<string>): boolean {
  const path = route.split(' ')[1] ?? '';

  for (const prefix of prefixes) {
    if (path === `/${prefix}` || path === `/v1/${prefix}` || path.startsWith(`/v1/${prefix}/`)) {
      return true;
    }
  }

  return false;
}
