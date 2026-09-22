import { describe, expect, it } from 'vitest';

import { loginUrlReturningTo, safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it('follows a same-origin path', () => {
    expect(safeNextPath('/stores')).toBe('/stores');
  });

  it('keeps the query and hash a handshake needs', () => {
    expect(safeNextPath('/connect?request=abc&state=xyz')).toBe('/connect?request=abc&state=xyz');
  });

  it.each([undefined, null, ''])('falls back for %s', (value) => {
    expect(safeNextPath(value)).toBe('/dashboard');
  });

  /**
   * 🔴 **The open redirect this function exists to prevent.**
   *
   * A merchant who has just typed their password is exactly the person an
   * attacker wants to land on a convincing copy of this dashboard.
   *
   * `//evil.example` is the case a naive `startsWith('/')` misses: the browser
   * reads it as protocol-relative and leaves the origin.
   */
  it.each([
    ['absolute https', 'https://evil.example/steal'],
    ['absolute http', 'http://evil.example'],
    ['protocol-relative', '//evil.example'],
    ['backslash-relative', '/\\evil.example'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['no leading slash', 'dashboard'],
  ])('refuses %s', (_label, value) => {
    expect(safeNextPath(value)).toBe('/dashboard');
  });

  /** A returned value is always something the router can navigate to. */
  it.each([
    'https://evil.example',
    '//evil.example',
    '/stores',
    '/connect?request=a&state=b',
  ])('always returns a path for %s', (value) => {
    const result = safeNextPath(value);

    expect(result.startsWith('/')).toBe(true);
    expect(result.startsWith('//')).toBe(false);
  });

  it('normalises a traversal rather than following it', () => {
    expect(safeNextPath('/a/../../etc/passwd')).toBe('/etc/passwd');
  });
});

describe('loginUrlReturningTo', () => {
  it('encodes the destination so its query survives', () => {
    const url = loginUrlReturningTo('/connect?request=abc&state=xyz');

    expect(url).toBe('/login?next=%2Fconnect%3Frequest%3Dabc%26state%3Dxyz');

    // And the round trip is what the sign-in screen actually does.
    const next = new URLSearchParams(url.split('?')[1]).get('next');
    expect(safeNextPath(next)).toBe('/connect?request=abc&state=xyz');
  });
});
