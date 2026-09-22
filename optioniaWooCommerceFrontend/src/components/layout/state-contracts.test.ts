import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The invariants the state audit *relied on*, asserted rather than assumed.
 *
 * ## Why this file exists
 *
 * Stage 6 reported that the four states are "compiler-enforced" and that the
 * plan's rule — *an empty state that says "No data" is a defect* — is
 * "structurally unviolatable". Both were true when written and **defended by
 * nothing**: marking one prop optional passed the whole suite *and* `tsc`, and
 * silently removed the guarantee from every screen at once.
 *
 * The same held for the components behind the screens with no tests of their
 * own. Deleting `AuthForm`'s entire error display, or its submit button's
 * disabled state, passed 261 tests — while five auth screens depend on it and
 * losing the disabled state means double-submit on login and register.
 *
 * So: an audit that verifies what the code does, without verifying what keeps it
 * doing that, is a snapshot. These are the load-bearing lines.
 */
const root = (relative: string) => join(process.cwd(), relative);

const STATES = root('src/components/layout/states.tsx');
const ALERT = root('src/components/ui/alert.tsx');
const AUTH_FORM = root('src/components/forms/auth-form.tsx');

/** Source with comments stripped, so prose explaining a rule cannot satisfy it. */
const code = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

describe('AsyncState', () => {
  /**
   * 🔴 O1. Every state is required, which is what makes forgetting one a
   * *compile* error rather than a blank panel. A single `?` here would end that
   * for every screen at once, with a green suite.
   */
  it.each(['isLoading', 'error', 'data', 'empty', 'children'])(
    'requires `%s`',
    (prop) => {
      const source = code(STATES);
      const props = source.slice(source.indexOf('export function AsyncState'));

      expect(props).toMatch(new RegExp(`\\b${prop}\\??:`));
      expect(props).not.toMatch(new RegExp(`\\b${prop}\\?:`));
    },
  );

  /** `isRefreshing` is the one deliberate optional — L1's fix, added later. */
  it('keeps `isRefreshing` optional so existing call sites stay valid', () => {
    expect(code(STATES)).toMatch(/isRefreshing\?:/);
  });
});

describe('EmptyState', () => {
  /**
   * 🔴 O1. *"An empty state that says 'No data' is a defect"* — M13.1. The rule
   * is enforced by `action` being required: a screen cannot render an empty
   * state without offering the thing that fills it.
   */
  it.each(['title', 'description', 'action'])('requires `%s`', (prop) => {
    const source = code(STATES);
    const block = source.slice(
      source.indexOf('export function EmptyState'),
      source.indexOf('export function ErrorState'),
    );

    expect(block).toMatch(new RegExp(`\\b${prop}\\??:`));
    expect(block).not.toMatch(new RegExp(`\\b${prop}\\?:`));
  });
});

describe('accessibility of the state components', () => {
  /**
   * 🟡 O4. A skeleton and an error are both *announcements*. Without a role a
   * screen reader is told nothing changed — the page simply differs, silently.
   */
  it('announces loading', () => {
    expect(code(STATES)).toMatch(/role="status"/);
  });

  it('announces every alert', () => {
    expect(code(ALERT)).toMatch(/role="alert"/);
  });
});

describe('AuthForm', () => {
  const source = code(AUTH_FORM);

  /**
   * 🔴 O2. Five screens — login, register, forgot-password, reset-password —
   * carry no state handling of their own because it lives here. Centralising a
   * rule concentrates the risk of losing it.
   */
  it('shows a form-level error', () => {
    /*
     * ⚠️ Asserted as the *assignment of a message*, not as the presence of the
     * two names. An earlier version checked only that `setFormError` and
     * `formLevelMessage` appeared somewhere — and a mutant that deleted the line
     * setting the message **passed**, because `setFormError(null)` on reset and
     * the import both survived. A failed sign-in would have rendered nothing.
     */
    expect(source).toMatch(/setFormError\(\s*formLevelMessage\(/);

    /* And the message must actually reach the DOM. */
    expect(source).toMatch(/\{formError\}/);
  });

  /** Without `disabled`, a slow login accepts a second submit — and a second sign-in. */
  it('disables submit while submitting', () => {
    expect(source).toMatch(/disabled=\{[^}]*isSubmitting/);
  });

  it('says it is working rather than looking frozen', () => {
    expect(source).toMatch(/isSubmitting \? pendingLabel/);
  });

  /** Errors must reach a screen reader, not only a sighted user. */
  it('announces its errors', () => {
    expect(source).toMatch(/role="alert"/);
  });
});

/**
 * 🔴 O3. M13.1 names **error boundaries**, and Stage 1 shipped none: a
 * render-time throw unmounted the tree and left a blank white page with no
 * message and no way back. Every state Stage 6 audited assumed the render
 * succeeded.
 */
describe('route-level boundaries', () => {
  it('catches a render-time throw', () => {
    const path = root('src/app/error.tsx');

    expect(existsSync(path)).toBe(true);

    const source = code(path);
    expect(source).toContain("'use client'");
    expect(source).toMatch(/reset/);
  });

  it('answers an unknown route', () => {
    expect(existsSync(root('src/app/not-found.tsx'))).toBe(true);
  });

  /**
   * 🔴 P3. The root boundary replaces the **whole page**, `AppShell` and its
   * navigation included — so a merchant whose Products screen threw lost every
   * route out of it, and a broken screen looked like a broken product. A
   * segment boundary renders inside the layout, keeping the shell.
   */
  it('scopes a dashboard error to the dashboard', () => {
    const path = root('src/app/(app)/error.tsx');

    expect(existsSync(path)).toBe(true);

    const source = code(path);
    expect(source).toContain("'use client'");
    expect(source).toMatch(/reset/);

    /* It renders into the shell's content area, so it must not claim the viewport. */
    expect(source).not.toContain('min-h-screen');
  });
});
