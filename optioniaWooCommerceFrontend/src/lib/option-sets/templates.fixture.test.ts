import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STARTER_TEMPLATES, templateDocument } from './templates';

/**
 * The backend's copy of the starter templates matches what this repository ships.
 *
 * ## Why the fixture exists
 *
 * `optioniaWooCommerceBackend/test/fixtures/dashboard/starter-templates.json` is
 * what proves every starter template survives the real import endpoint. The
 * backend cannot import `templates.ts`, so it reads a copy — and a copy that has
 * drifted tests a document no merchant will ever send.
 *
 * 🔴 **The version this replaced had already drifted.** The engraving document was
 * pasted into a backend e2e by hand and carried **one** option where the real
 * template carries two.
 *
 * ## Why the comparison lives here rather than in the shell gate
 *
 * ✏️ **`bin/check-template-fixture.sh` compares ids, names and non-emptiness —
 * and missed the drift it was written for.** Removing an option from engraving,
 * exactly the failure above, left it reporting success. Verified, not assumed.
 *
 * Only this repository can regenerate the documents, because only it can execute
 * `templateDocument()`. So the *content* comparison belongs here, where the real
 * values are in hand; the shell gate keeps its structural checks, which run even
 * when this suite does not.
 *
 * ## Regenerating
 *
 * ```sh
 * UPDATE_TEMPLATE_FIXTURE=1 npx vitest run src/lib/option-sets/templates.fixture.test.ts
 * ```
 *
 * 📌 **An env var rather than a separate script.** A generator nobody can run is
 * how the fixture became unmaintainable the first time — the instructions said
 * `npx tsx <emit script>` and no such script existed. This one is committed, has
 * no dependency beyond `vitest`, and is exercised by every `npm run check`.
 */
const FIXTURE = join(
  process.cwd(),
  '..',
  'optioniaWooCommerceBackend',
  'test',
  'fixtures',
  'dashboard',
  'starter-templates.json',
);

/** What the fixture should contain, built from the templates themselves. */
const expected = (): string => {
  const documents = Object.fromEntries(
    STARTER_TEMPLATES.map((template) => [template.id, templateDocument(template)]),
  );

  return `${JSON.stringify(documents, null, 2)}\n`;
};

describe('the backend template fixture', () => {
  it('matches the templates this repository ships', () => {
    const wanted = expected();

    if (process.env.UPDATE_TEMPLATE_FIXTURE === '1') {
      writeFileSync(FIXTURE, wanted);
    }

    const actual = readFileSync(FIXTURE, 'utf8');

    /*
     * ⚠️ Compared as parsed objects, not as text: key order and indentation are
     * `JSON.stringify`'s business, and a whitespace-only difference should not
     * fail a merchant's build. The *content* is what the backend imports.
     */
    expect(JSON.parse(actual)).toEqual(JSON.parse(wanted));
  });

  /**
   * A fixture that had lost a template would still "match" if this suite only
   * compared what it found — so the count is pinned against the plan's four.
   */
  it('carries every template the dashboard offers', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

    expect(Object.keys(fixture).sort()).toEqual(
      STARTER_TEMPLATES.map((template) => template.id).sort(),
    );
    expect(STARTER_TEMPLATES).toHaveLength(4);
  });
});
