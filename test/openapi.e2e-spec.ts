import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
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
