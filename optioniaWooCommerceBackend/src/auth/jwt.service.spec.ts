import { JwtService } from '@nestjs/jwt';

import { AuthJwtService, TokenAudience } from './jwt.service';

/**
 * Access tokens and realm separation.
 *
 * The `aud` claim is what keeps the three identity realms apart (M6.5). A
 * merchant's token authenticating a platform admin route would collapse the
 * separation the whole permission model rests on.
 */
describe('AuthJwtService', () => {
  const SECRET = 'x'.repeat(48);

  function build(ttlSeconds = 900): AuthJwtService {
    return new AuthJwtService(new JwtService({ secret: SECRET }), ttlSeconds);
  }

  it('round-trips the claims it was given', () => {
    const token = build().signTenantAccess('user-1', 'tenant-1', 'owner');
    const claims = build().verify(token, TokenAudience.TENANT);

    expect(claims?.sub).toBe('user-1');
    expect(claims?.tid).toBe('tenant-1');
    expect(claims?.role).toBe('owner');
  });

  /**
   * The separation that matters. A token minted for a merchant must not
   * authenticate a platform route, and the check happens before any role logic.
   *
   * `'store'` is asserted as a **literal**, not through `TokenAudience`, because
   * `[8c]` removed that member — a store presents an opaque credential, never a
   * JWT. The assertion is kept rather than deleted with the enum: the property
   * under test is that a tenant token is refused for the `store` audience, and
   * that must hold whether or not this codebase has a name for the value. Asking
   * it of the literal is in fact the stronger question, since it no longer
   * depends on us having declared it.
   */
  it('refuses a token presented to the wrong realm', () => {
    const token = build().signTenantAccess('user-1', 'tenant-1', 'owner');

    expect(build().verify(token, TokenAudience.PLATFORM)).toBeNull();
    expect(build().verify(token, 'store' as TokenAudience)).toBeNull();
    expect(build().verify(token, TokenAudience.TENANT)).not.toBeNull();
  });

  /** A token signed with a different secret is a forgery. */
  it('refuses a token signed with another secret', () => {
    const foreign = new AuthJwtService(new JwtService({ secret: 'y'.repeat(48) }), 900);
    const token = foreign.signTenantAccess('user-1', 'tenant-1', 'owner');

    expect(build().verify(token, TokenAudience.TENANT)).toBeNull();
  });

  it('refuses an expired token', async () => {
    const token = build(1).signTenantAccess('user-1', 'tenant-1', 'owner');

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(build().verify(token, TokenAudience.TENANT)).toBeNull();
  }, 10_000);

  /**
   * Returning null rather than throwing is what lets the guard give one uniform
   * 401 — distinguishing "expired" from "bad signature" tells an attacker which
   * part of their forgery worked.
   */
  it('returns null rather than throwing on anything malformed', () => {
    const service = build();

    expect(service.verify('', TokenAudience.TENANT)).toBeNull();
    expect(service.verify('not-a-token', TokenAudience.TENANT)).toBeNull();
    expect(service.verify('a.b.c', TokenAudience.TENANT)).toBeNull();
  });

  /** The token must not carry anything a reader should not see. */
  it('carries no secret material in its payload', () => {
    const token = build().signTenantAccess('user-1', 'tenant-1', 'owner');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'role', 'sub', 'tid']);
  });
});
