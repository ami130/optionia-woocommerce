import type { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginDownloadService } from '../src/plugin-download/plugin-download.service';
import { bootstrapTestApp } from './harness';

/**
 * Collect a binary response as real bytes.
 *
 * ✏️ **`.buffer(true)` alone is not enough.** Supertest only builds a Buffer when
 * a parser is registered for the content type; with none for `application/zip` it
 * falls back to reading the stream as a *binary string* on `res.text`. The first
 * attempt at these tests asserted on `response.body` and failed against a
 * perfectly good archive — the bytes were right (`50 4b 03 04`), the container
 * was not — and `text.length` reported 418,596 for a 440,657-byte file, which
 * reads exactly like truncation and is not.
 */
const asBytes = (test: request.Test) =>
  test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];

    res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });

/**
 * The plugin a merchant installs (M20b.3).
 *
 * 🔴 **The API's first binary response**, and its first public file route — so
 * the things asserted here are the ones no other route exercises: the headers a
 * browser needs to save a file, that the archive arrives intact rather than
 * mangled by the JSON interceptor, and that a caller-controlled string reaching
 * the filesystem cannot leave the directory.
 */
describe('plugin download (e2e)', () => {
  let app: INestApplication;

  /** The version `bin/package.sh` builds from the plugin's own header. */
  let version = '';

  beforeAll(async () => {
    app = await bootstrapTestApp();

    const latest = await request(app.getHttpServer()).get('/v1/plugin/latest');

    /*
     * ⚠️ **Asserted, not assumed.** Every test below depends on a build existing;
     * without this they would pass vacuously against 404s and prove nothing.
     * `bash bin/package.sh` in the plugin repo is what makes them meaningful.
     */
    expect(latest.status).toBe(200);
    version = latest.body.data.version as string;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  describe('GET /v1/plugin/latest', () => {
    it('names the version, the file and its size', async () => {
      const response = await request(app.getHttpServer()).get('/v1/plugin/latest');

      expect(response.status).toBe(200);
      expect(response.body.data.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(response.body.data.filename).toBe(`optionia-${version}.zip`);
      expect(response.body.data.sizeBytes).toBeGreaterThan(0);
    }, 30_000);

    /** The install screen follows this rather than building a path itself. */
    it('points at the download route for that version', async () => {
      const response = await request(app.getHttpServer()).get('/v1/plugin/latest');

      expect(response.body.data.downloadUrl).toBe(`/v1/plugin/download/${version}`);
    }, 30_000);

    /**
     * 🔴 **Public, and that is the decision** (ADR-095). The plugin carries no
     * secret by design (AC8), and a merchant may be installing from a WordPress
     * admin on a machine where they are not signed in to the dashboard.
     */
    it('needs no authentication', async () => {
      const response = await request(app.getHttpServer()).get('/v1/plugin/latest');

      expect(response.status).not.toBe(401);
      expect(response.status).toBe(200);
    }, 30_000);
  });

  describe('GET /v1/plugin/download/:version', () => {
    it('serves the archive with the headers a browser needs to save it', async () => {
      const response = await asBytes(request(app.getHttpServer()).get(`/v1/plugin/download/${version}`));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/zip');
      // `attachment`, or a browser renders a page of binary at the merchant.
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="optionia-${version}.zip"`,
      );
      expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
    }, 30_000);

    /**
     * 🔴 **A real zip, not JSON describing one.**
     *
     * Every other route in this API is wrapped by `ApiResponseInterceptor` into
     * `{data, meta}`. If that reached this one the body would be a JSON string
     * and a merchant's download would be a corrupt file — which looks like a
     * working route until someone tries to install it. The four bytes below are
     * the zip magic number, so this asserts the bytes rather than the status.
     */
    it('returns the archive bytes, unwrapped by the response envelope', async () => {
      const response = await asBytes(request(app.getHttpServer()).get(`/v1/plugin/download/${version}`));

      const body = response.body as Buffer;

      expect(Buffer.isBuffer(body)).toBe(true);
      expect([...body.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    }, 30_000);

    it('serves the whole file, not a truncated one', async () => {
      const [latest, download] = await Promise.all([
        request(app.getHttpServer()).get('/v1/plugin/latest'),
        asBytes(request(app.getHttpServer()).get(`/v1/plugin/download/${version}`)),
      ]);

      expect((download.body as Buffer).length).toBe(latest.body.data.sizeBytes);
    }, 30_000);

    it('answers 404 for a version that was never built', async () => {
      const response = await request(app.getHttpServer()).get('/v1/plugin/download/9.9.9');

      expect(response.status).toBe(404);
    }, 30_000);

    /**
     * 🔴 **The version is interpolated into a filesystem path.**
     *
     * So the question is not what to strip but whether the string looks like a
     * version at all. Each of these is refused before anything reaches the disk —
     * and none may answer `200`, whatever else it answers.
     */
    it.each([
      ['traversal, encoded', '..%2F..%2F..%2Fetc%2Fpasswd'],
      ['traversal, dotted', '..'],
      ['an absolute path', '%2Fetc%2Fpasswd'],
      ['a null byte', '0.2.0%00.txt'],
      ['not a version', 'latest'],
      ['four segments', '1.2.3.4'],
    ])('refuses %s', async (_name, attempt) => {
      const response = await request(app.getHttpServer()).get(`/v1/plugin/download/${attempt}`);

      expect(response.status).not.toBe(200);
    }, 30_000);
  });

  /**
   * 🔴 **A file that stops being readable must not take the process with it.**
   *
   * `existsSync` and `statSync` run a moment before the read, and the file can
   * still vanish in between — a deploy replacing `dist/`, a rotation, a
   * permissions change. In Node a `ReadStream` that emits `error` with **no
   * listener** becomes an `uncaughtException`, so the failure is not one
   * merchant's broken download but the whole API going down.
   *
   * Exercised against a real directory this test controls, because the only way
   * to create the race is to delete the file after the service has resolved it.
   */
  describe('a vanished archive', () => {
    let dir = '';

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'optionia-dist-'));
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('does not crash the process when the file disappears after it is found', async () => {
      const service = new PluginDownloadService(dir);
      const path = join(dir, 'optionia-1.2.3.zip');

      writeFileSync(path, 'not really a zip, but a real file');

      const archive = service.byVersion('1.2.3');
      expect(archive).not.toBeNull();

      // The race, made deterministic: resolved, then gone before the read.
      rmSync(path);

      /*
       * ⚠️ Asserted as a *handled* error rather than by watching for a crash:
       * an unhandled one would take this worker down and the suite would report
       * a worker failure rather than a test failure. A listener that receives
       * the error is exactly what stops that.
       */
      const failure = await new Promise<Error | null>((resolve) => {
        const stream = archive!.stream();

        stream.on('error', (error: Error) => resolve(error));
        stream.on('end', () => resolve(null));
      });

      expect(failure).not.toBeNull();
      expect((failure as NodeJS.ErrnoException).code).toBe('ENOENT');
    }, 30_000);

    it('reports no build when the directory holds no archive', () => {
      expect(new PluginDownloadService(dir).latest()).toBeNull();
    }, 30_000);
  });
});
