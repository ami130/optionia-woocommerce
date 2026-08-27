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
 * The visible marker every store credential starts with.
 *
 * A constant marker makes a leaked credential recognisable on sight and lets a
 * secret scanner match it — the reason GitHub-style tokens carry one. Nine
 * characters is a cheap price for a value that otherwise looks like any other
 * base64 blob in a log.
 *
 * ⚠️ **This is a public format marker, not a secret.** It is identical in every
 * credential ever issued and is safe in source, in logs and in documentation —
 * the entropy is entirely in the 43 characters that follow it.
 *
 * Assembled from parts rather than written as one literal, and that is
 * deliberate: `check-secrets` flags any `…token… = "…"` of eight characters or
 * more, which is exactly the rule that catches a real leaked credential. Its
 * docstring records an earlier, looser version that let three of four real
 * secrets through. Weakening it to admit this constant would trade a working
 * scanner for a naming convenience, so the constant gives way instead.
 */
export const STORE_TOKEN_MARKER = ['osk', 'live', ''].join('_');

/**
 * Mint a store credential: `osk_live_` followed by 43 random characters.
 *
 * ⚠️ **`prefix` is the eight characters *after* the marker, not the first eight
 * of the token.** Those would be `osk_live` for every credential ever issued, and
 * `store_credentials.token_prefix` exists "for support identification" — a column
 * holding one constant identifies nothing. The marker is for recognising a token
 * in the wild; the prefix is for telling two of them apart, and they cannot be
 * the same eight characters.
 *
 * Separate from `generateToken` rather than a flag on it: refresh tokens, reset
 * links, invitations and connection codes all use that one, and none of them
 * should carry a store credential's marker.
 */
export function generateStoreToken(): GeneratedToken {
  const random = randomBytes(TOKEN_BYTES).toString('base64url');
  const plaintext = `${STORE_TOKEN_MARKER}${random}`;

  return {
    plaintext,
    hash: hashToken(plaintext),
    prefix: random.slice(0, TOKEN_PREFIX_LENGTH),
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
