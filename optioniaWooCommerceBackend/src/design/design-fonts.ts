import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { TEXT_FONTS, type TextFont } from '../option-sets/types/text-fonts';

/**
 * Where the renderer's font files live, and whether they are actually there
 * (M26e.4).
 *
 * 🔴 **`resvg` renders with a MISSING font file and reports nothing.** Measured:
 * given `fontFiles: ['/does/not/exist.ttf']` it returned a 112-byte PNG without
 * throwing. So a mis-pathed font is not an error a caller discovers — it is a
 * blank print file a customer receives. Every path this module hands out is
 * checked to exist first.
 *
 * ⚠️ **The directory is OUTSIDE `src/`, and that is the whole point.**
 * `nest build` copies no non-TypeScript file, so a TTF under `src/` compiles to
 * nothing and `dist/` never sees it — proven by building with one in place.
 * An earlier version of the font gate pointed at `src/design/fonts` and would
 * have passed while production had no fonts at all.
 */

/** The file name a family is expected to ship under: its name without spaces. */
export function fontFileBase(font: TextFont): string {
  return font.replaceAll(' ', '');
}

/**
 * Resolve the configured directory to an absolute path.
 *
 * 📌 **Relative resolves against `process.cwd()`**, which `start:prod`
 * (`node dist/main.js`) and `start:dev` both run from the package root — the
 * same rule `PluginDownloadService` already follows for `PLUGIN_DIST_DIR`.
 */
export function resolveFontsDir(configured: string): string {
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/** What the renderer may draw with, and what is missing. */
export interface FontInventory {
  /** Absolute paths that exist, for `resvg`'s `fontFiles`. */
  readonly files: readonly string[];
  /**
   * Curated families with no file on disk.
   *
   * 🔴 **Reported rather than thrown.** A render missing one family should
   * still produce the rest — a merchant whose heading font is absent is better
   * served by a flagged file than by no file. The caller decides; this only
   * refuses to hide it.
   */
  readonly missing: readonly TextFont[];
}

/**
 * Every licensed font file present in a directory.
 *
 * ⚠️ **Matched by PREFIX, not an exact name.** Google ships `Roboto-Regular`,
 * `Roboto-Bold`, `Roboto-Italic` and more; `resvg` chains them and picks the
 * face a `font-weight` asks for. Demanding one exact file per family would
 * refuse the bold a design uses.
 *
 * 📌 **Only `.ttf` and `.otf`.** Those are what the licence sign-off covers and
 * what `resvg` reads; a `.woff2` in this directory is a packaging mistake worth
 * ignoring rather than feeding to the renderer.
 */
export function fontInventory(dir: string): FontInventory {
  if (!existsSync(dir)) {
    return { files: [], missing: [...TEXT_FONTS] };
  }

  const present = readdirSync(dir).filter((name) => /\.(ttf|otf)$/i.test(name));
  const files: string[] = [];
  const missing: TextFont[] = [];

  for (const font of TEXT_FONTS) {
    const base = fontFileBase(font).toLowerCase();
    const matches = present.filter((name) => name.toLowerCase().startsWith(base));

    if (matches.length === 0) {
      missing.push(font);

      continue;
    }

    for (const name of matches) {
      files.push(join(dir, name));
    }
  }

  return { files, missing };
}
