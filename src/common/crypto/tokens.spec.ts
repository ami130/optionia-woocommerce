import {
  expiresIn,
  generateToken,
  hasExpired,
  hashToken,
  TOKEN_PREFIX_LENGTH,
  tokensMatch,
} from './tokens';

describe('tokens', () => {
  describe('generateToken', () => {
    it('returns a plaintext, its hash, and a prefix of the plaintext', () => {
      const token = generateToken();

      expect(token.hash).toBe(hashToken(token.plaintext));
      expect(token.prefix).toBe(token.plaintext.slice(0, TOKEN_PREFIX_LENGTH));
      expect(token.prefix).toHaveLength(TOKEN_PREFIX_LENGTH);
    });

    /** The stored value must never be usable as the token itself. */
    it('never stores the plaintext in the hash', () => {
      const token = generateToken();

      expect(token.hash).not.toContain(token.plaintext);
    });

    /**
     * If two tokens could collide, one user's link would authenticate another.
     * 32 bytes makes that impossible in practice; this catches a generator that
     * was accidentally made deterministic.
     */
    it('produces a distinct value every time', () => {
      const seen = new Set(Array.from({ length: 500 }, () => generateToken().plaintext));

      expect(seen.size).toBe(500);
    });

    /**
     * A token that needs percent-encoding breaks when a mail client rewrites the
     * link, so it must be URL-safe as generated.
     */
    it('is URL-safe without escaping', () => {
      for (let i = 0; i < 100; i += 1) {
        const { plaintext } = generateToken();

        expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(encodeURIComponent(plaintext)).toBe(plaintext);
      }
    });

    it('carries enough entropy to be unguessable', () => {
      // 32 bytes -> 43 base64url characters.
      expect(generateToken().plaintext.length).toBeGreaterThanOrEqual(43);
    });
  });

  describe('hashToken', () => {
    it('is a SHA-256 hex digest, matching char(64)', () => {
      expect(hashToken('anything')).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic, so a presented token can be looked up', () => {
      expect(hashToken('same-input')).toBe(hashToken('same-input'));
    });

    it('differs completely for a one-character change', () => {
      expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
    });
  });

  describe('tokensMatch', () => {
    it('matches identical values and rejects different ones', () => {
      const hash = hashToken('x');

      expect(tokensMatch(hash, hash)).toBe(true);
      expect(tokensMatch(hash, hashToken('y'))).toBe(false);
    });

    /**
     * `timingSafeEqual` throws on mismatched buffer lengths, and a thrown
     * comparison is a much louder signal than a slow one.
     */
    it('returns false rather than throwing on different lengths', () => {
      expect(() => tokensMatch('short', hashToken('x'))).not.toThrow();
      expect(tokensMatch('short', hashToken('x'))).toBe(false);
      expect(tokensMatch('', '')).toBe(true);
    });
  });

  describe('expiry', () => {
    it('computes a future instant from minutes', () => {
      const before = Date.now();
      const at = expiresIn(30).getTime();

      expect(at - before).toBeGreaterThanOrEqual(29 * 60_000);
      expect(at - before).toBeLessThanOrEqual(31 * 60_000);
    });

    it('treats the exact expiry instant as expired', () => {
      const at = new Date('2026-01-01T00:00:00Z');

      expect(hasExpired(at, at)).toBe(true);
      expect(hasExpired(at, new Date('2025-12-31T23:59:59Z'))).toBe(false);
      expect(hasExpired(at, new Date('2026-01-01T00:00:01Z'))).toBe(true);
    });
  });
});
