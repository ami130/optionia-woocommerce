import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every enabled navigation item must have a page (M13.7, J3).
 *
 * 🔴 **Both `/products` and `/settings` shipped as live links to Next's
 * not-found page.** The disabled-item mechanism already existed and those two
 * items simply did not use it — a defect no type-check or render test can see,
 * because a `<Link>` to a missing route is valid TSX and only fails when a
 * merchant clicks it.
 *
 * This reads the route directory rather than the component's own list, so it
 * fails when a page is deleted as well as when a link is added.
 */
const APP_DIR = join(process.cwd(), 'src/app/(app)');

const SHELL = join(process.cwd(), 'src/components/layout/app-shell.tsx');

/**
 * The nav's hrefs, parsed from the source so the list and this test cannot drift.
 *
 * Only the `NAVIGATION` block is read: `<Link href="/dashboard">` in the header
 * is a link too, and matching it would assert against a route the list never
 * claimed to own.
 */
function hrefs(kind: 'enabled' | 'disabled'): string[] {
  const source = readFileSync(SHELL, 'utf8');
  const block = source.slice(
    source.indexOf('const NAVIGATION'),
    source.indexOf('export function AppShell'),
  );

  return block
    .split('\n')
    .filter((line) => line.includes("href: '"))
    .filter((line) => (kind === 'disabled' ? line.includes('phase:') : !line.includes('phase:')))
    .map((line) => line.split("href: '")[1].split("'")[0]);
}

describe('navigation', () => {
  it('parses the navigation list', () => {
    // Guards the parser itself: an empty list would make every case below vacuous.
    expect(hrefs('enabled').length).toBeGreaterThanOrEqual(4);
    expect(hrefs('disabled').length).toBeGreaterThanOrEqual(3);
  });

  it.each(hrefs('enabled'))('%s has a page', (href) => {
    const dir = join(APP_DIR, href.replace(/^\//, ''));

    expect(existsSync(join(dir, 'page.tsx'))).toBe(true);
  });

  /** A disabled item must NOT have a page — otherwise it is needlessly unreachable. */
  it('does not disable an item that is already built', () => {
    for (const href of hrefs('disabled')) {
      expect(existsSync(join(APP_DIR, href.replace(/^\//, ''), 'page.tsx'))).toBe(false);
    }
  });
});
