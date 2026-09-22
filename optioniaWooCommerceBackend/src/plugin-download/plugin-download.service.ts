import { createReadStream, existsSync, statSync, type ReadStream } from 'node:fs';
import { readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { Injectable, Optional } from '@nestjs/common';

import { loadConfig } from '../config/env';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';

/** A built plugin archive, ready to stream. */
export interface PluginArchive {
  version: string;
  filename: string;
  sizeBytes: number;
  stream: () => ReadStream;
}

/**
 * Built plugin zips are named `optionia-<version>.zip`.
 *
 * ⚠️ **Anchored at both ends, and digits-and-dots only.** This pattern is what
 * stops a request for `../../etc/passwd` becoming a filename: a version is
 * interpolated into a path, so anything that is not a version must not match.
 */
const ARCHIVE = /^optionia-(\d+\.\d+\.\d+)\.zip$/;

/**
 * Serves the plugin a merchant installs (M20b.3).
 *
 * ## Why the API serves a file at all
 *
 * The merchant is in a browser tab on the dashboard and must get a plugin into
 * their WordPress admin — the milestone calls this "the weakest link". WordPress
 * .org listing is [M35.2](../../../developePlan.md), fifteen phases out, whose
 * own text plans for review being "declined or slow" — so self-hosted download is
 * the **primary** path rather than a stopgap (ADR-095).
 */
@Injectable()
export class PluginDownloadService {
  /**
   * Where the zips live, resolved once.
   *
   * The configured value may be relative — it defaults to the plugin repo's own
   * `dist/` beside this one, which is where `bin/package.sh` writes — so it is
   * resolved against the working directory here rather than in `env.ts`, which
   * is deliberately import-free.
   */
  private readonly dir: string;

  /**
   * @param distDir Where the built zips live. Defaults to the configured value.
   *
   * ✏️ **Injectable so the guard can be unit-tested.** The first version read
   * `loadConfig()` unconditionally in its constructor, which meant the service
   * could not be instantiated without the whole environment — and the traversal
   * rules, which are the security-relevant part, could then only be exercised
   * over HTTP where the router refuses encoded slashes before they are reached.
   *
   * ⚠️ **`@Optional()` is required, not decoration.** Without it Nest reads the
   * parameter's design-time type and tries to resolve a `String` provider, which
   * does not exist — the container failed to start with
   * `dependencies: [Function: String]`. The decorator tells it to pass
   * `undefined` and let the default apply.
   */
  constructor(@Optional() distDir?: string) {
    const configured = distDir ?? loadConfig().pluginDistDir;

    this.dir = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }

  /**
   * The newest built archive, or null when none has been built.
   *
   * 📌 **Null rather than throwing.** A developer who has not run
   * `bin/package.sh` is not in an error state — the route answers 404 and the
   * dashboard says the download is unavailable, which is the truth.
   */
  latest(): PluginArchive | null {
    if (!existsSync(this.dir)) {
      return null;
    }

    const versions = readdirSync(this.dir)
      .map((name) => ARCHIVE.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ filename: match[0], version: match[1] }))
      .sort((a, b) => compareVersions(b.version, a.version));

    const newest = versions[0];

    return newest === undefined ? null : this.archive(newest.version, newest.filename);
  }

  /**
   * One archive by version.
   *
   * 🔴 **The version is validated against the filename pattern, not sanitised.**
   * A caller controls this string and it is interpolated into a path, so the
   * question is not "what should we strip?" but "does this look like a version
   * at all?" — anything else never reaches the filesystem.
   */
  byVersion(version: string): PluginArchive | null {
    const filename = `optionia-${version}.zip`;

    if (!ARCHIVE.test(filename)) {
      return null;
    }

    return this.archive(version, filename);
  }

  private archive(version: string, filename: string): PluginArchive | null {
    const path = join(this.dir, filename);

    /*
     * ⚠️ **Asserted after joining, not before.** The pattern above already makes
     * traversal unrepresentable, and this is the backstop that survives someone
     * loosening it: a resolved path that has left the directory is refused
     * whatever produced it.
     */
    if (!resolve(path).startsWith(resolve(this.dir))) {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, 'Invalid plugin version.');
    }

    if (!existsSync(path)) {
      return null;
    }

    return {
      version,
      filename,
      sizeBytes: statSync(path).size,
      stream: () => createReadStream(path),
    };
  }
}

/** Newest-first ordering over `major.minor.patch`, numerically per segment. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);

  for (let i = 0; i < 3; i += 1) {
    /*
     * ⚠️ Numeric, never lexicographic: `0.10.0` is newer than `0.9.0`, and a
     * string comparison says the opposite.
     */
    const diff = (left[i] ?? 0) - (right[i] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}
