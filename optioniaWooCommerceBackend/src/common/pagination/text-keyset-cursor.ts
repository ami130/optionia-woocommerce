import { DomainException } from '../errors/domain.exception';

/** An encoded cursor is ~80 bytes; this bounds the work a junk value can cause. */
const MAX_CURSOR_LENGTH = 512;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sort key a text cursor encodes: a sort value, then an id to break ties. */
export interface TextCursorKey {
  readonly value: string;
  readonly id: string;
}

/**
 * Encode a keyset cursor over a **text** column.
 *
 * The sibling of `keyset-cursor.ts`, which keys on `(createdAt, id)`. Two
 * modules rather than one generic helper because the validation differs in the
 * part that matters: a timestamp cursor round-trips through `toISOString()` to
 * prove it was a full timestamp, and a text cursor has no such invariant to
 * check. Collapsing them would mean a parameter deciding which validation ran,
 * which is the shape of a helper that eventually validates neither.
 *
 * ## Why a product list keys on name rather than time
 *
 * `store_products` has exactly one useful index: `ix_store_products_search
 * (storeId, name)`. Paging on `(createdAt, id)` would sort by a column that
 * index cannot serve, so every page would filesort the whole catalogue — and it
 * would present a merchant's products in import order, which is not an order
 * anyone can navigate. Alphabetical is both what the index supports and what a
 * picker should show.
 *
 * ## Base64url, and why the delimiter is not a pipe
 *
 * A product name may contain any character, `|` included, so the timestamp
 * module's `value|id` split would break on a product literally called
 * `Shirt | Large`. The value is length-prefixed instead: `<len>:<value><id>`,
 * which cannot be ambiguous whatever the name contains.
 */
export function encodeTextCursor(value: string, id: string): string {
  return Buffer.from(`${value.length}:${value}${id}`, 'utf8').toString('base64url');
}

/**
 * Decode a text cursor. **Rejects a malformed one rather than ignoring it.**
 *
 * The same refusal as `decodeCursor()`, for the same reason: treating an
 * unusable cursor as "no cursor" returns page one with a `200`, which a client
 * cannot distinguish from a genuine first page — so a cursor mangled in transit
 * makes a paging loop restart forever, re-processing the same rows and never
 * reaching the end.
 */
export function decodeTextCursor(cursor?: string): TextCursorKey | null {
  if (cursor === undefined) {
    return null;
  }

  const decoded = decodeTextCursorOrNull(cursor);

  if (!decoded) {
    throw DomainException.validation([{ field: 'cursor', code: 'INVALID_CURSOR' }]);
  }

  return decoded;
}

/** The parse itself, separated so the failure is one branch rather than five. */
function decodeTextCursorOrNull(cursor: string): TextCursorKey | null {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    return null;
  }

  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = raw.indexOf(':');

    if (separator <= 0) {
      return null;
    }

    const declared = Number(raw.slice(0, separator));

    // `Number('')` is 0 and `Number('1e3')` is 1000, so the length must be a
    // plain non-negative integer and nothing else.
    if (!/^\d+$/.test(raw.slice(0, separator)) || !Number.isSafeInteger(declared)) {
      return null;
    }

    const body = raw.slice(separator + 1);
    const value = body.slice(0, declared);
    const id = body.slice(declared);

    /*
     * The declared length must describe the value exactly.
     *
     * ⚠️ **Redundant with the UUID check, and proven so rather than assumed.**
     * `value` is `body.slice(0, declared)`, so `value.length !== declared` can
     * only hold when `declared` overruns the body — and every such case leaves
     * `id` empty or truncated, which the UUID test already refuses. Measured:
     * deleting this clause passes all 20 tests, and no input reaches it first.
     *
     * Kept anyway. It states the invariant the parse depends on, and it is the
     * clause that stays correct if the id ever stops being a UUID — at which
     * point the other half of this condition would quietly stop guarding
     * anything.
     */
    if (value.length !== declared || !UUID_PATTERN.test(id)) {
      return null;
    }

    return { value, id };
  } catch {
    return null;
  }
}
