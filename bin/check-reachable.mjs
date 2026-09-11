/**
 * Every module must be reachable from something the app renders.
 *
 * 🔴 **Written because three rule modules sat with no caller.** `vocabulary.ts`,
 * `summary.ts` and the tester client shipped in M17.10's first half and were
 * imported by nothing but their own tests until the builder screen arrived. Not
 * dead — the screen is their caller — but nothing here could tell *pending* from
 * *dead*, and a reader had no way to know which.
 *
 * The backend gained the same gate in M17.10, after its rule evaluator sat
 * unreferenced from M17.4. The plugin has had one since Stage 6, where it has
 * fired twice. This is the third repository to get it and the last to need it.
 *
 * ## What counts as reachable
 *
 * Imported by a file under `src/` that is not itself a test. A module reached
 * only from tests is code the product does not run, whatever its tests say.
 *
 * ## Entry points
 *
 * Next.js routes by file system, so `page`, `layout`, `error`, `not-found`,
 * `template`, `loading` and `route` files are entered by the framework and
 * imported by nothing. Config at the root is the same. Narrowing that would
 * report a rendering page as unreachable, and a gate with false positives is a
 * gate somebody switches off.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', 'src');

/**
 * Exemptions, **listed by name and never by pattern**.
 *
 * A pattern is an exemption that quietly widens; a name expires the moment
 * somebody asks why it is here. Each entry must say what it waits for and which
 * stage removes it.
 */
const EXEMPT = new Map([]);

const ROUTE_FILES = new Set([
  'page',
  'layout',
  'error',
  'not-found',
  'template',
  'loading',
  'route',
  'default',
  'global-error',
]);

const isTest = (rel) => rel.includes('.test.') || rel.includes('.spec.');

function isEntry(rel) {
  const base = rel.split('/').pop() ?? '';
  const stem = base.replace(/\.(ts|tsx)$/, '');

  return ROUTE_FILES.has(stem) || base.endsWith('.d.ts');
}

function everyFileUnder(dir) {
  const found = [];

  for (const name of readdirSync(dir)) {
    const full = join(dir, name);

    if (statSync(full).isDirectory()) {
      found.push(...everyFileUnder(full));

      continue;
    }

    if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      found.push(full);
    }
  }

  return found;
}

const files = everyFileUnder(ROOT);

/**
 * Every path imported by production code.
 *
 * ⚠️ **Both specifier styles are resolved to a real path.** `@/lib/rules/schema`
 * and `./schema` name the same file from different places, and a gate comparing
 * the strings would call the second an unrelated module.
 */
const imported = new Set();

for (const file of files) {
  if (isTest(relative(ROOT, file))) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
  const here = dirname(file);

  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];

    const base = specifier.startsWith('@/')
      ? resolve(ROOT, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(here, specifier)
        : null;

    if (base === null) {
      continue;
    }

    for (const candidate of [
      `${base}.ts`,
      `${base}.tsx`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
    ]) {
      imported.add(candidate);
    }
  }
}

const unreached = files
  .map((file) => relative(ROOT, file))
  .filter((rel) => !isTest(rel) && !isEntry(rel) && !EXEMPT.has(rel))
  .filter((rel) => !imported.has(join(ROOT, rel)));

const total = files.filter((file) => !isTest(relative(ROOT, file))).length;

if (unreached.length > 0) {
  process.stdout.write(
    `\x1b[31mFAIL\x1b[0m  ${unreached.length} module(s) are reached only from tests, or not at all:\n`,
  );
  unreached.forEach((rel) => process.stdout.write(`        ${rel}\n`));
  process.stdout.write(
    '        A module nothing renders is code the product does not run.\n' +
      '        Give it its caller, delete it, or exempt it BY NAME with a reason\n' +
      '        and the stage that removes the exemption.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `\x1b[32mok\x1b[0m    all ${total} module(s) are reachable from something the app renders\n`,
);
