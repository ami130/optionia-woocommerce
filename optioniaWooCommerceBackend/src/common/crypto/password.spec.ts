import {
  assertUsablePassword,
  BCRYPT_COST,
  hashPassword,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
  WeakPasswordError,
} from './password';

describe('password', () => {
  const good = 'correct-horse-battery-staple';

  it('hashes and verifies', async () => {
    const hash = await hashPassword(good);

    expect(hash).not.toContain(good);
    await expect(verifyPassword(good, hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword(good);

    await expect(verifyPassword('wrong-horse-battery-staple', hash)).resolves.toBe(false);
  });

  /** Two users with the same password must not share a hash. */
  it('salts, so identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword(good), hashPassword(good)]);

    expect(a).not.toBe(b);
    await expect(verifyPassword(good, a)).resolves.toBe(true);
    await expect(verifyPassword(good, b)).resolves.toBe(true);
  });

  /**
   * The cost decides what an offline attack against a stolen database costs. It
   * is asserted because a drop to 4 would be invisible — every test would still
   * pass, and only an attacker would notice.
   */
  it('uses the configured cost', async () => {
    expect(BCRYPT_COST).toBeGreaterThanOrEqual(12);

    const hash = await hashPassword(good);

    expect(hash.startsWith(`$2b$${BCRYPT_COST}$`)).toBe(true);
  });

  describe('length rules', () => {
    it('rejects a password shorter than the minimum', () => {
      expect(() => assertUsablePassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
        WeakPasswordError,
      );
    });

    it('accepts exactly the minimum', () => {
      expect(() => assertUsablePassword('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
    });

    /**
     * bcrypt silently truncates at 72 bytes, so without this two different
     * passwords sharing their first 72 bytes are the same password — and a user
     * who pasted a long passphrase is far less protected than they believe.
     */
    it('rejects beyond 72 bytes rather than truncating', () => {
      expect(() => assertUsablePassword('x'.repeat(MAX_PASSWORD_BYTES + 1))).toThrow(
        /silently truncated/,
      );
    });

    it('accepts exactly 72 bytes', () => {
      expect(() => assertUsablePassword('x'.repeat(MAX_PASSWORD_BYTES))).not.toThrow();
    });

    /** An emoji is four bytes, so a character count would still truncate. */
    it('counts bytes, not characters', () => {
      // 20 emoji = 80 bytes but only 20 characters.
      expect(() => assertUsablePassword('🔐'.repeat(20))).toThrow(/bytes/);
    });

    it('refuses to hash a password it would reject', async () => {
      await expect(hashPassword('short')).rejects.toThrow(WeakPasswordError);
    });
  });

  describe('verification is defensive', () => {
    /**
     * A corrupt row must not turn a failed login into a 500 — that would tell an
     * attacker this account's row differs from every other.
     */
    it('returns false for a malformed hash instead of throwing', async () => {
      await expect(verifyPassword(good, 'not-a-bcrypt-hash')).resolves.toBe(false);
    });

    it('returns false for empty input', async () => {
      const hash = await hashPassword(good);

      await expect(verifyPassword('', hash)).resolves.toBe(false);
      await expect(verifyPassword(good, '')).resolves.toBe(false);
    });
  });
});
