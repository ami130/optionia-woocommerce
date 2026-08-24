import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque tokens: refresh tokens, verification links, reset links.
 *
 * **Not JWTs.** These need to be revocable and single-use, which means the server
 * has to look them up anyway — and once it does, a signed self-describing token
 * buys nothing while adding a way to leak claims into a URL that lands in browser
 * history, referrer headers and mail-client prefetch logs.
 *
 * The value is random, stored as a SHA-256 hash, and never recoverable.
 */

/**
 * 32 bytes of entropy.
 *
 * base64url-encoded this is 43 characters — short enough to survive a mail
 * client's line wrapping, long enough that guessing is not a strategy.
 */
const TOKEN_BYTES = 32;

/** Characters of the token kept in plaintext for support identification. */
export const TOKEN_PREFIX_LENGTH = 8;

export interface GeneratedToken {
  /** Returned to the caller once. Never stored, never logged. */
  readonly plaintext: string;
  /** SHA-256 hex digest, `char(64)` — what the database holds. */
  readonly hash: string;
  /** First characters of the plaintext, for "the token ending in…" support. */
  readonly prefix: string;
}

/**
 * Mint a token.
 *
 * `randomBytes` is the CSPRNG. `Math.random` is seeded predictably and is not
 * suitable for anything anyone would want to guess.
 *
 * base64url rather than hex: same entropy in two-thirds the characters, and safe
 * in a URL without escaping — a token that needs percent-encoding is a token that
 * breaks when a mail client rewrites the link.
 */
export function generateToken(): GeneratedToken {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');

  return {
    plaintext,
    hash: hashToken(plaintext),
    prefix: plaintext.slice(0, TOKEN_PREFIX_LENGTH),
  };
}

/**
 * Hash a token for storage or lookup.
 *
 * SHA-256, not bcrypt — deliberately. bcrypt's cost exists to slow down guessing
 * of low-entropy human passwords. A 256-bit random value has nothing to guess, so
 * a work factor would only tax every refresh and every link click for no gain.
 */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Compare two hashes without leaking where they diverge.
 *
 * A plain `===` on strings exits at the first differing byte, and the timing
 * difference is measurable across enough requests. That matters far less for
 * hashes than for secrets, but the correct comparison costs nothing and removes
 * the question.
 *
 * Length is checked first because `timingSafeEqual` throws on mismatched buffers,
 * and a thrown comparison is a far louder signal than a slow one.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

/**
 * When a token expires.
 *
 * Expressed as a helper so every call site states a duration rather than doing
 * date arithmetic inline, where an hours/minutes slip produces a link that lives
 * sixty times too long.
 */
export function expiresIn(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

/** True when `expiresAt` is in the past. */
export function hasExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
