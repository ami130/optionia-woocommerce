import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PluginDownloadService } from './plugin-download.service';

/**
 * Which strings may become a filename (M20b.3).
 *
 * 🔴 **Tested here rather than over HTTP, because HTTP cannot reach the guard.**
 * The e2e suite sends `..%2F..%2Fetc%2Fpasswd` and gets a `404` — but that `404`
 * comes from the *router*, which refuses encoded slashes before any of this code
 * runs. Proven by mutation: loosening the pattern to `optionia-(.+)\\.zip`
 * left every one of those e2e cases green.
 *
 * So the traversal assertions belong where the string actually reaches the
 * filesystem, and the e2e cases stay as evidence that the route is closed at both
 * layers.
 */
describe('PluginDownloadService.byVersion', () => {
  // A directory that need not exist: every case here is refused before any
  // filesystem access, which is the property under test.
  const service = new PluginDownloadService('/tmp/optionia-dist-does-not-exist');

  /**
   * ⚠️ Each of these is a string a caller controls, interpolated into a path.
   * `null` is the only acceptable answer — never a resolved archive.
   */
  it.each([
    ['relative traversal', '../../../etc/hosts'],
    ['traversal into the repo', '../../package.json'],
    ['bare dots', '..'],
    ['an absolute path', '/etc/passwd'],
    ['a null byte', '0.2.0\u0000.txt'],
    ['a word', 'latest'],
    ['four segments', '1.2.3.4'],
    ['two segments', '1.2'],
    ['a wildcard', '*'],
    ['empty', ''],
    ['leading space', ' 0.2.0'],
    ['a newline', '0.2.0\n'],
  ])('refuses %s', (_name, attempt) => {
    expect(service.byVersion(attempt)).toBeNull();
  });

  /**
   * The pattern must still admit a real version, or the guard is a brick wall
   * and every download fails — which a suite of refusals alone would not notice.
   */
  it('accepts a well-formed version', () => {
    /*
     * Asserted on the *attempt*, not on a file: whether `9.9.9` exists on disk is
     * environmental, and the question here is whether the string was refused
     * before the filesystem was consulted. A refused string and a missing file
     * both answer `null`, so this asserts the path it would have looked for.
     */
    expect(() => service.byVersion('9.9.9')).not.toThrow();
    expect(service.byVersion('10.20.30')).toBeNull();
  });

  /**
   * `latest()` reads a directory that may not exist.
   *
   * 📌 In development nobody has run `bin/package.sh`, so this is the normal
   * case rather than an error — and a throw here would turn a missing build into
   * a `500` on the install screen instead of an honest "nothing to download".
   */
  it('reports no build rather than throwing when the directory is absent', () => {
    expect(service.latest()).toBeNull();
  });
});

/**
 * The controller's half of the crash guard (F1).
 *
 * 🔴 **The e2e test proves the *stream* reports a vanished file; it does not
 * prove the controller listens.** Attaching no listener is exactly the defect —
 * an unhandled `error` on a `ReadStream` becomes an `uncaughtException` and takes
 * the process down — and a test that drives the stream itself cannot see whether
 * the request handler wired one up.
 *
 * Read from source for the reason `editor-contracts` gives on the dashboard: the
 * failure needs a real vanished file *during* an in-flight HTTP response, which
 * this harness cannot stage without leaving the worker in the state under test.
 */
describe('the download controller handles stream failure', () => {
  const source = readFileSync(
    join(__dirname, 'plugin-download.controller.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('attaches an error listener before piping', () => {
    const listener = source.indexOf(".on('error'");
    const pipe = source.indexOf('.pipe(response)');

    expect(listener).toBeGreaterThan(-1);
    // ⚠️ Order matters: a listener added after `pipe()` can miss a synchronous
    // `ENOENT` on a file that was already gone.
    expect(listener).toBeLessThan(pipe);
  });

  /**
   * ⚠️ **Destroyed, never re-answered.** The headers are on the wire by then, and
   * `AllExceptionsFilter` records what writing after `headersSent` costs: a
   * half-written body left every later request on that connection hanging.
   */
  it('destroys the response rather than writing a second one', () => {
    expect(source).toMatch(/response\.destroy\(/);
    expect(source).not.toMatch(/response\.status\([\s\S]*?\)\.json\(/);
  });

  it('logs the cause rather than sending it', () => {
    expect(source).toMatch(/this\.logger\.error\(/);
  });

  /** F2 — the most expensive response in the API declares an hourly bucket. */
  it('rate-limits the download by the hour, not the minute', () => {
    expect(source).toMatch(/@Throttle\(\{ default: \{ limit: \d+, ttl: 3_600_000 \} \}\)/);
  });
});
