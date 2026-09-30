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
/**
 * ⚠️ **Route GROUPS, not one directory.** This read `src/app/(app)` alone, which
 * assumed every navigation item lives in the merchant group. It stopped being
 * true when the Platform section arrived in `(admin)`: the page existed and this
 * test reported it missing, because it was looking in one place.
 *
 * 📌 Parenthesised directories do not appear in the URL, so a href resolves
 * under whichever group owns it — which is exactly why the path cannot be
 * derived from the href alone.
 */
const APP_ROOT = join(process.cwd(), 'src/app');
const ROUTE_GROUPS = ['(app)', '(admin)'] as const;

/** Where a nav href's page lives, or null when nothing serves it. */
function pageFor(href: string): string | null {
  const relative = href.replace(/^\//, '');

  for (const group of ROUTE_GROUPS) {
    const candidate = join(APP_ROOT, group, relative, 'page.tsx');

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

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

  /*
   * 🔴 **Every href on a line, not the first.** `split("href: '")[1]` returned
   * one match per line, so two entries written on one line made the second
   * INVISIBLE — a nav item pointing at a page that does not exist would have
   * passed this test silently. Found by probing the test itself: adding a
   * deliberate ghost route did not fail it.
   */
  return block
    .split('\n')
    .filter((line) => (kind === 'disabled' ? line.includes('phase:') : !line.includes('phase:')))
    .flatMap((line) => [...line.matchAll(/href: '([^']+)'/g)].map((m) => m[1]));
}

describe('navigation', () => {
  it('parses the navigation list', () => {
    // Guards the parser itself: an empty list would make every case below vacuous.
    expect(hrefs('enabled').length).toBeGreaterThanOrEqual(4);

    /*
     * ✏️ **Lowered from 3 to 2 when Analytics shipped (2026-09-28).** This is a
     * floor on the PARSER, not a claim about how much is unbuilt — a disabled
     * count that only ever rises would mean the product never finishes anything.
     * Two keeps both branches of the `phase:` filter exercised, which is all
     * this case is for.
     */
    expect(hrefs('disabled').length).toBeGreaterThanOrEqual(2);
  });

  it.each(hrefs('enabled'))('%s has a page', (href) => {
    expect(pageFor(href)).not.toBeNull();
  });

  /** A disabled item must NOT have a page — otherwise it is needlessly unreachable. */
  it('does not disable an item that is already built', () => {
    for (const href of hrefs('disabled')) {
      expect(pageFor(href)).toBeNull();
    }
  });
});
