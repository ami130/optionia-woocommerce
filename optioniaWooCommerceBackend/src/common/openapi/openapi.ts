import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * The generated OpenAPI description.
 *
 * ## This is a description, not the contract
 *
 * `docs/API-CONTRACT.md` is the **design**: written before a controller exists,
 * because the plugin is a client that cannot be redeployed across thousands of
 * merchant sites and an endpoint shaped by an implementation accident becomes
 * permanent. This spec is **derived from the controllers** — it says what the
 * code does, not what was agreed.
 *
 * They will sometimes disagree, and that disagreement is the point: it is the
 * signal that a controller drifted. `bin/check-openapi.ts` compares the two and
 * fails on a route present in one and not the other, which is only useful
 * because the spec is generated rather than written.
 *
 * A generated spec presented *as* the contract would hide exactly that.
 */

/** Named so a client generator produces sensible method names. */
export const OPENAPI_TITLE = 'Optionia for WooCommerce API';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(OPENAPI_TITLE)
    .setDescription(
      'Advanced product options for WooCommerce. `docs/API-CONTRACT.md` is the ' +
        'authoritative design; this spec is generated from the controllers and ' +
        'describes what they currently do.',
    )
    .setVersion('1')
    /**
     * Three realms, declared separately (AC8).
     *
     * A store token must never be accepted on a `/option-sets` route and a user
     * JWT must never be accepted on `/store/config`. Modelling them as one
     * scheme would let a generated client offer either interchangeably, which
     * is the confusion the separation exists to prevent.
     */
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'A tenant member’s access token. `aud: tenant`.',
      },
      'tenant',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Platform staff. `aud: platform`.',
      },
      'platform',
    )
    /**
     * Deliberately **no `bearerFormat`**, because this one is not a JWT.
     *
     * A store presents an opaque credential whose SHA-256 lives in
     * `store_credentials`, checked against the database on every request — M8.6
     * requires revocation to be immediate and a JWT cannot be un-issued.
     * Declaring a format here would tell a generated client to expect a
     * decodable token and invite it to read claims that do not exist.
     */
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description:
          'A store credential, issued to a plugin install. An **opaque token**, ' +
          'not a JWT — it carries no claims and has no `aud`. Revoking it in ' +
          '`store_credentials` takes effect on the next request.',
      },
      'store',
    )
    .build();

  return SwaggerModule.createDocument(app, config, {
    // Route paths as declared, so a comparison against the contract is textual
    // rather than a guess at how a name was derived.
    ignoreGlobalPrefix: false,
  });
}

/**
 * Serve the spec and its explorer.
 *
 * Behind the same authentication as everything else? **No** — and deliberately.
 * The spec describes the shape of the API, not its data: every path is already
 * public knowledge to anyone holding the plugin, which ships with the client
 * that calls these routes. Gating it would protect nothing and would stop the
 * one thing it is for, which is a developer reading it.
 *
 * It is disabled in production all the same, because an explorer that issues
 * live requests against a production database is a footgun handed to anyone who
 * finds the URL.
 */
export function serveOpenApi(app: INestApplication, enabled: boolean): void {
  if (!enabled) {
    return;
  }

  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
    jsonDocumentUrl: 'docs/openapi.json',
    swaggerOptions: {
      // Persist a token across page reloads: without this, testing three
      // consecutive endpoints means pasting a JWT three times.
      persistAuthorization: true,
    },
  });
}
