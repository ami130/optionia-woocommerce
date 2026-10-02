import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEXT_FONTS } from '@shared/design/design-geometry.types';
import { fontFileBase, fontInventory, resolveFontsDir } from './design-fonts';

/**
 * 🔴 **The module that stops a blank print file.** `resvg` renders a missing
 * font without complaint — 112 bytes, no throw — so what is on disk has to be
 * established before the renderer is handed anything.
 */
describe('fontFileBase', () => {
  it('drops the space from a two-word family', () => {
    expect(fontFileBase('Open Sans')).toBe('OpenSans');
    expect(fontFileBase('Playfair Display')).toBe('PlayfairDisplay');
  });

  it('leaves a one-word family alone', () => {
    expect(fontFileBase('Roboto')).toBe('Roboto');
  });
});

describe('resolveFontsDir', () => {
  it('keeps an absolute path', () => {
    expect(resolveFontsDir('/opt/fonts')).toBe('/opt/fonts');
  });

  /*
   * 📌 **Relative resolves against `process.cwd()`**, which `start:prod`
   * (`node dist/main.js`) runs from the package root — the same rule
   * `PluginDownloadService` follows for `PLUGIN_DIST_DIR`.
   */
  it('resolves a relative path against the working directory', () => {
    expect(resolveFontsDir('assets/fonts')).toBe(join(process.cwd(), 'assets/fonts'));
  });
});

describe('fontInventory', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'optionia-fonts-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ship(name: string): void {
    writeFileSync(join(dir, name), 'not really a font');
  }

  function shipAll(): void {
    for (const font of TEXT_FONTS) ship(`${fontFileBase(font)}-Regular.ttf`);
  }

  /*
   * 🔴 **A directory that does not exist is the production defect this module
   * was written for.** The font gate once pointed at `src/design/fonts`, which
   * `nest build` never copies — so `dist/` had none and `resvg` drew nothing.
   */
  it('reports every family missing when the directory is absent', () => {
    const inventory = fontInventory(join(dir, 'nowhere'));

    expect(inventory.files).toEqual([]);
    expect(inventory.missing).toEqual([...TEXT_FONTS]);
  });

  it('reports every family missing when the directory is empty', () => {
    expect(fontInventory(dir).missing).toEqual([...TEXT_FONTS]);
  });

  it('finds every licensed family when all are shipped', () => {
    shipAll();

    const inventory = fontInventory(dir);

    expect(inventory.missing).toEqual([]);
    expect(inventory.files).toHaveLength(TEXT_FONTS.length);
  });

  it('returns absolute paths the renderer can open', () => {
    shipAll();

    for (const file of fontInventory(dir).files) {
      expect(file.startsWith(dir)).toBe(true);
    }
  });

  it('names exactly the family that is missing', () => {
    shipAll();
    rmSync(join(dir, 'Pacifico-Regular.ttf'));

    expect(fontInventory(dir).missing).toEqual(['Pacifico']);
  });

  /*
   * ⚠️ **Matched by PREFIX**, because Google ships a file per face and `resvg`
   * chains them. Demanding one exact name per family would refuse the bold a
   * design uses.
   */
  it('collects every face of a family', () => {
    ship('Roboto-Regular.ttf');
    ship('Roboto-Bold.ttf');
    ship('Roboto-Italic.ttf');

    const roboto = fontInventory(dir).files.filter((f) => f.includes('Roboto'));

    expect(roboto).toHaveLength(3);
  });

  it('accepts a two-word family under its spaceless name', () => {
    ship('OpenSans-Regular.ttf');

    expect(fontInventory(dir).missing).not.toContain('Open Sans');
  });

  it('accepts an OTF as well as a TTF', () => {
    ship('Roboto-Regular.otf');

    expect(fontInventory(dir).missing).not.toContain('Roboto');
  });

  /*
   * 📌 **A `.woff2` is a packaging mistake, not a font to render with.** The
   * sign-off covers TTF and OTF, and those are what `resvg` reads.
   */
  it('ignores a web font format the renderer cannot read', () => {
    ship('Roboto-Regular.woff2');

    expect(fontInventory(dir).missing).toContain('Roboto');
    expect(fontInventory(dir).files).toEqual([]);
  });

  it('ignores an unrelated file in the directory', () => {
    shipAll();
    writeFileSync(join(dir, 'LICENSE.txt'), 'OFL');

    expect(fontInventory(dir).files).toHaveLength(TEXT_FONTS.length);
  });
});
