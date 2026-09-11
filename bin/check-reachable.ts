/**
 * Every production module must be reachable from production code.
 *
 * 🔴 **Written because an evaluator sat with no caller for four stages.**
 *
 * `common/rules/rule-evaluator.ts` was imported by its own two spec files and
 * nothing else from M17.4 to M17.10. It was not dead — M17.6's tester is its
 * caller — but nothing here could tell the difference between *pending* and
 * *dead*, and a reader had no way to know which.
 *
 * The plugin has had this gate since Stage 6, and it has produced exactly that
 * evidence twice: `Pricing`'s exemption was removed and the gate passed, proving
 * the class was pending rather than dead; `RuleEvaluator`'s was removed in 17-8
 * with the same result. The backend had no equivalent, which is why an
 * evaluator with no caller went unnoticed.
 *
 * ## What counts as reachable
 *
 * Imported by a file under `src/` that is not itself a spec. A module reached
 * only from tests is code the product does not run, whatever its tests say
 * about it.
 *
 * ## Entry points
 *
 * `main.ts` boots Nest and nothing imports it by design. A `*.module.ts` is
 * reached through Nest's own metadata rather than always through a plain
 * import, so modules count as entry points too — narrowing that would report a
 * correctly wired module as unreachable, and a gate with false positives is a
 * gate somebody switches off.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', 'src');

/**
 * Exemptions, **listed by name and never by pattern**.
 *
 * A pattern is an exemption that quietly widens. A name expires the moment
 * somebody asks why it is here — which is the point.
 *
 * Each entry must say what it is waiting for and which stage removes it.
 */
const EXEMPT = new Map<string, string>([
  /*
   * 🔴 **The cloud's half of the shared pricing contract, built in Phase 11
   * before anything on this side needed it.**
   *
   * `PRICING-SPEC.md` is executed by fixtures in **both** repositories, and
   * these are how the TypeScript side executes them. The plugin computes the
   * price a customer pays; the cloud computes the same numbers for the
   * dashboard's preview and for analytics, neither of which has shipped.
   *
   * ⚠️ **DELETE BOTH WHEN PHASE 21 LANDS.** Live preview is what gives them a
   * caller. If Phase 21 ships without importing them, they are dead rather than
   * pending and should go — the fixtures would then be proving a contract
   * nothing on this side keeps.
   */
  ['common/money/line-total.ts', 'Phase 21 — live preview is its caller'],
  ['common/money/price-config-delta.ts', 'Phase 21 — live preview is its caller'],
]);

const isTest = (rel: string): boolean => rel.includes('.spec.') || rel.includes('.test.');

/**
 * Reached by something other than a TypeScript import.
 *
 * Each category is here because a mechanism outside the import graph loads it,
 * and each claim was **verified against the code rather than assumed**:
 *
 * - `main.ts` boots Nest; nothing imports it by design.
 * - `*.module.ts` is reached through Nest's own metadata as well as imports.
 *   Narrowing this would report a correctly wired module as unreachable, and a
 *   gate with false positives is one somebody switches off.
 * - `*.entity.ts` and `migrations/*` are loaded by **glob**, not by import —
 *   `config/data-source.ts` registers
 *   `entities: [__dirname + '/../**' + '/*.entity{.ts,.js}']` and
 *   `migrations: [__dirname + '/../migrations/*{.ts,.js}']`.
 * - `seeds/run-*.ts` are npm entry points: `db:seed` and `db:seed:demo`.
 *
 * ⚠️ **This is not the exemption list.** These are reachable by a route this
 * gate cannot see. `EXEMPT` is for a module that genuinely has no caller yet,
 * and every entry there is a fuse with a stage attached.
 */
const isEntry = (rel: string): boolean =>
  rel === 'main.ts' ||
  rel.endsWith('.module.ts') ||
  rel.endsWith('.d.ts') ||
  rel.endsWith('.entity.ts') ||
  rel.startsWith('migrations/') ||
  /^seeds\/run-[\w-]+\.ts$/.test(rel);

function everyTsFileUnder(dir: string): string[] {
  const found: string[] = [];

  for (const name of readdirSync(dir)) {
    const full = join(dir, name);

    if (statSync(full).isDirectory()) {
      found.push(...everyTsFileUnder(full));

      continue;
    }

    if (name.endsWith('.ts')) {
      found.push(full);
    }
  }

  return found;
}

const files = everyTsFileUnder(ROOT);

/**
 * Every path imported by production code.
 *
 * ⚠️ **Resolved to a real path, not matched as text.** `./rules` from one
 * directory and `../common/rules` from another name the same file, and a gate
 * comparing the strings would call the second an unrelated module. Both
 * `<path>.ts` and `<path>/index.ts` are recorded because either may be what the
 * specifier meant.
 */
const imported = new Set<string>();

for (const file of files) {
  if (isTest(relative(ROOT, file))) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
  const here = dirname(file);

  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const base = resolve(here, match[1]);

    imported.add(`${base}.ts`);
    imported.add(join(base, 'index.ts'));
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
    '        A module the product never imports is code the product does not run.\n' +
      '        Give it its caller, delete it, or exempt it BY NAME with a reason\n' +
      '        and the stage that removes the exemption.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `\x1b[32mok\x1b[0m    all ${total} production module(s) are reachable from production code\n`,
);
