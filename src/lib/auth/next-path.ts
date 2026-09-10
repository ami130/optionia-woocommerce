/**
 * Where to send someone after they sign in.
 *
 * ## Why this needs a function rather than a `searchParams.get()`
 *
 * `?next=` is a classic open-redirect: `?next=https://evil.example` hands an
 * attacker the post-login redirect, and a merchant who has just typed their
 * password lands on a convincing copy of this dashboard. The rule is that only a
 * **same-origin path** is ever followed — never an absolute URL, and never a
 * protocol-relative one.
 *
 * `//evil.example` is the case a naive `startsWith('/')` check misses: the
 * browser reads it as a protocol-relative URL and leaves the origin. Both the
 * leading slash **and** the absence of a second are required.
 *
 * Added in Phase 13 Stage 3 for the connection handshake: a merchant clicking
 * **Connect** in WordPress may not be signed in, and sending them to `/login`
 * without carrying `request` and `state` would silently abandon the handshake.
 */
const DEFAULT_DESTINATION = '/dashboard';

export function safeNextPath(next: string | null | undefined): string {
  if (next === null || next === undefined || next === '') {
    return DEFAULT_DESTINATION;
  }

  /*
   * A path, and only a path. `//host` is protocol-relative and leaves this
   * origin; `/\host` does the same in several browsers, which is why the second
   * character is checked rather than just the first.
   */
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return DEFAULT_DESTINATION;
  }

  /*
   * Anything the URL parser accepts as absolute is refused, whatever it looks
   * like -- `javascript:` and `data:` included. Parsed against a throwaway base
   * so a genuine path stays relative and an absolute value announces itself.
   */
  try {
    const parsed = new URL(next, 'https://placeholder.invalid');

    if (parsed.origin !== 'https://placeholder.invalid') {
      return DEFAULT_DESTINATION;
    }

    // Rebuilt from the parsed parts, so a value carrying `..` or an encoded
    // host cannot smuggle anything past the checks above.
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_DESTINATION;
  }
}

/** Build a sign-in URL that returns here afterwards. */
export function loginUrlReturningTo(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}
