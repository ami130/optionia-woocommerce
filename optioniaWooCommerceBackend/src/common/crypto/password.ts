import * as bcrypt from 'bcrypt';

/**
 * Password hashing.
 *
 * **Cost 12 is defined here and nowhere else.** It was previously a local
 * constant in the super-admin seed, which meant the number that decides how
 * expensive an offline attack is could drift between the seed and the auth flow
 * without anything noticing.
 *
 * Twelve is roughly 250ms on current hardware. That is deliberately slow: the
 * cost is paid once per login by one user, and once per *guess* by an attacker
 * holding a stolen database.
 */
export const BCRYPT_COST = 12;

/**
 * Maximum password length accepted.
 *
 * **bcrypt silently truncates at 72 bytes.** Without a limit, two different
 * passwords sharing their first 72 bytes are the same password — and a user who
 * pasted a 200-character passphrase would be far less protected than they
 * believe. Rejecting is honest; truncating is not.
 *
 * Bytes, not characters: an emoji is four bytes, so a 72-character limit would
 * still truncate.
 */
export const MAX_PASSWORD_BYTES = 72;

/** Minimum length. Server-side, because a client-side rule is a suggestion. */
export const MIN_PASSWORD_LENGTH = 12;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Hash a password for storage.
 *
 * Validates before hashing rather than after, so an unusable password never
 * reaches the database.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  assertUsablePassword(plaintext);

  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must not
 * turn a failed login into a 500, which would tell an attacker that this
 * account's row differs from every other.
 */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) {
    return false;
  }

  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Reject a password that cannot be stored safely.
 *
 * Length only. Composition rules — an uppercase, a digit, a symbol — push people
 * toward `Password1!` and away from length, which is the property that actually
 * resists guessing. M6.1 pairs this with a breached-password check, which catches
 * what a rule set cannot.
 */
export function assertUsablePassword(plaintext: string): void {
  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const bytes = Buffer.byteLength(plaintext, 'utf8');

  if (bytes > MAX_PASSWORD_BYTES) {
    throw new WeakPasswordError(
      `Password must be at most ${MAX_PASSWORD_BYTES} bytes (${bytes} given). ` +
        `Longer values are silently truncated by bcrypt, which would make this ` +
        `password weaker than it looks.`,
    );
  }
}
