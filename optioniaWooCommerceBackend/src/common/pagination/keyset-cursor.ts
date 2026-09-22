import { DomainException } from '../errors/domain.exception';

/** An encoded cursor is ~60 bytes; this bounds the work a junk value can cause. */
const MAX_CURSOR_LENGTH = 256;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sort key a keyset cursor encodes: a timestamp, then an id to break ties. */
export interface CursorKey {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * Encode a keyset cursor.
 *
 * base64url of the sort key. Opaque by construction rather than by convention:
 * a client cannot read it, so it cannot come to depend on the ordering, and
 * changing that ordering later does not break anyone.
 *
 * Shared rather than per-repository, so the malformed-cursor defect found in 7e
 * has one home rather than one per list endpoint.
 *
 * ⚠️ **One consumer today.** The audit trail pages on a monotonic `BIGINT` id
 * and needs no timestamp tie-break, so it deliberately does not use this — which
 * means the duplication this was extracted to prevent has not yet happened. The
 * reasoning holds for the next list endpoint keyed on `(createdAt, id)`; it is
 * recorded here rather than left as a claim the code does not yet demonstrate.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor. **Rejects a malformed one rather than ignoring it.**
 *
 * Silently treating an unusable cursor as "no cursor" returns page one with a
 * 200, which a client cannot distinguish from a genuine first page — so a
 * cursor mangled in transit makes a paging loop restart forever, re-processing
 * the same rows and never reaching the end. A truncated cursor is precisely the
 * case that has to be loud.
 *
 * This is an API, not a link a person edits by hand: the contract says the
 * cursor is opaque and clients must not construct one, so the only callers are
 * machines that either echo `meta.pagination.cursor` back verbatim or have a bug
 * worth surfacing.
 */
export function decodeCursor(cursor?: string): CursorKey | null {
  if (cursor === undefined) {
    return null;
  }

  const decoded = decodeCursorOrNull(cursor);

  if (!decoded) {
    throw DomainException.validation([{ field: 'cursor', code: 'INVALID_CURSOR' }]);
  }

  return decoded;
}

/** The parse itself, separated so the failure is one branch rather than three. */
function decodeCursorOrNull(cursor: string): CursorKey | null {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    return null;
  }

  try {
    const [timestamp, id, ...extra] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');

    if (extra.length > 0 || !timestamp || !id || !UUID_PATTERN.test(id)) {
      return null;
    }

    const createdAt = new Date(timestamp);

    // `new Date('2020')` parses, so the round-trip confirms the value was a
    // full ISO timestamp of the shape `encodeCursor` writes.
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== timestamp) {
      return null;
    }

    return { createdAt, id };
  } catch {
    return null;
  }
}
