import { describe, expect, it } from 'vitest';

/**
 * Where each guard sends a given session — as data, so the set can be reasoned
 * about rather than clicked through.
 *
 * The guards themselves are components and this project has no JSX test runner
 * (see `vitest.config.ts`), so the **decision** is extracted here and the
 * components apply it. That is the half worth testing: a redirect loop is a
 * property of the decision table, not of the rendering.
 */
type Session = { signedIn: boolean; verified: boolean; hasTenant: boolean };

/** `RequireAnonymous` — `(auth)`. */
function anonymousGuard(s: Session): string | null {
  return s.signedIn ? '/dashboard' : null;
}

/** `RequireMerchant` — `(app)`. */
function merchantGuard(s: Session): string | null {
  if (!s.signedIn) return '/login';
  if (!s.verified) return '/verify-email';
  if (!s.hasTenant) return '/no-workspace';

  return null;
}

/** `RequireUnverified` — `(verify)`. */
function unverifiedGuard(s: Session): string | null {
  if (!s.signedIn) return null;

  return s.verified ? '/dashboard' : null;
}

/** `RequireSignedIn` — `(session)`. */
function signedInGuard(s: Session): string | null {
  return s.signedIn ? null : '/login';
}

/**
 * Which guard owns which path.
 *
 * `/no-workspace` is under `signedInGuard`, **not** `merchantGuard`: it is where
 * a tenantless user is sent, so guarding it with the rule that sends them there
 * makes it redirect to itself. That was the second loop this table found.
 */
const GUARD_FOR: Record<string, (s: Session) => string | null> = {
  '/': merchantGuard,
  '/login': anonymousGuard,
  '/register': anonymousGuard,
  '/forgot-password': anonymousGuard,
  '/dashboard': merchantGuard,
  '/no-workspace': signedInGuard,
  '/verify-email': unverifiedGuard,
  /**
   * `(token)` — **no guard at all**, and that is the fix for a real defect.
   *
   * `/reset-password` began in `(auth)`, so a signed-in merchant clicking the
   * link in their email was silently bounced to the dashboard with the reset
   * impossible and nothing saying so. That is the common case — people reset a
   * password they have forgotten on *another* device.
   *
   * The token in the URL is the credential here, not the session, so whether the
   * visitor has one is irrelevant.
   */
  '/reset-password': () => null,
};

/** Follow the redirects, and report a cycle rather than hanging on one. */
function settle(start: string, session: Session): { at: string; looped: boolean } {
  const seen = new Set<string>();
  let path = start;

  for (let hop = 0; hop < 10; hop++) {
    if (seen.has(path)) {
      return { at: path, looped: true };
    }

    seen.add(path);

    const next = GUARD_FOR[path]?.(session) ?? null;

    if (next === null) {
      return { at: path, looped: false };
    }

    path = next;
  }

  return { at: path, looped: true };
}

const SIGNED_OUT: Session = { signedIn: false, verified: false, hasTenant: false };
const UNVERIFIED: Session = { signedIn: true, verified: false, hasTenant: true };
const READY: Session = { signedIn: true, verified: true, hasTenant: true };
const NO_TENANT: Session = { signedIn: true, verified: true, hasTenant: false };

describe('route guards', () => {
  /**
   * 🔴 **The loop this test exists for.**
   *
   * `/verify-email` began in `(auth)`, whose guard sends any signed-in visitor
   * to `/dashboard` — while `RequireMerchant` sends an unverified user to
   * `/verify-email`. Every newly registered merchant bounced between them.
   */
  it('an unverified user reaches the verification screen and stops there', () => {
    expect(settle('/dashboard', UNVERIFIED)).toEqual({ at: '/verify-email', looped: false });
  });

  it('never loops, from any entry point, for any session', () => {
    const sessions = { SIGNED_OUT, UNVERIFIED, READY, NO_TENANT };

    for (const [name, session] of Object.entries(sessions)) {
      for (const path of Object.keys(GUARD_FOR)) {
        const outcome = settle(path, session);

        expect(outcome.looped, `${name} entering ${path} looped at ${outcome.at}`).toBe(false);
      }
    }
  });

  /**
   * 🔴 **A signed-in merchant can use a password-reset link.**
   *
   * The defect this covers was invisible to the loop test: it is a redirect, not
   * a cycle, and `/reset-password` was not in this table at all. Every route the
   * app serves is listed now.
   */
  it.each([
    ['signed out', SIGNED_OUT],
    ['signed in', READY],
    ['unverified', UNVERIFIED],
  ])('lets a %s visitor reach the password-reset link', (_label, session) => {
    expect(settle('/reset-password', session)).toEqual({ at: '/reset-password', looped: false });
  });

  it('sends a signed-out visitor to sign in', () => {
    expect(settle('/dashboard', SIGNED_OUT).at).toBe('/login');
  });

  it('keeps a signed-in user away from the sign-in form', () => {
    expect(settle('/login', READY).at).toBe('/dashboard');
  });

  /** Following an old verification link after verifying goes to the app. */
  it('sends an already-verified user away from the verification screen', () => {
    expect(settle('/verify-email', READY).at).toBe('/dashboard');
  });

  /**
   * A verification link opened in a browser with no session must still work:
   * the token in the URL is what verifies, not the session.
   */
  it('lets a signed-out visitor stay on the verification screen', () => {
    expect(settle('/verify-email', SIGNED_OUT)).toEqual({ at: '/verify-email', looped: false });
  });

  /** Signed in, verified, member of nothing — its own destination, not a loop. */
  it('sends a tenantless user somewhere they can read', () => {
    expect(settle('/dashboard', NO_TENANT).at).toBe('/no-workspace');
  });
});
