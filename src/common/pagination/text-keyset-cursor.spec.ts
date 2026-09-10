import { DomainException } from '../errors/domain.exception';
import { decodeTextCursor, encodeTextCursor } from './text-keyset-cursor';

const ID = '0f3c9a1e-4b2d-4c6f-9a11-2e5d7c8b3f04';

describe('text keyset cursor', () => {
  it('round-trips a value and an id', () => {
    expect(decodeTextCursor(encodeTextCursor('Custom Hoodie', ID))).toEqual({
      value: 'Custom Hoodie',
      id: ID,
    });
  });

  /**
   * **The reason the value is length-prefixed rather than delimited.**
   *
   * `keyset-cursor.ts` splits on `|`, which is safe for an ISO timestamp and
   * unsafe for a product name — a merchant selling `Shirt | Large` would produce
   * a cursor that decoded into the wrong two halves, and paging would silently
   * skip or repeat rows from that point on.
   */
  it.each([
    ['a pipe', 'Shirt | Large'],
    ['a colon', 'Bundle: two shirts'],
    ['both', 'A|B:C'],
    ['unicode', 'Café — Größe'],
    ['an emoji', '🎁 Gift wrap'],
    ['a digit prefix', '12:34 Special'],
    ['empty', ''],
  ])('survives %s in the value', (_label, value) => {
    expect(decodeTextCursor(encodeTextCursor(value, ID))).toEqual({ value, id: ID });
  });

  it('treats an absent cursor as the first page', () => {
    expect(decodeTextCursor(undefined)).toBeNull();
  });

  /**
   * A malformed cursor must be **loud**.
   *
   * Treating it as "no cursor" returns page one with a 200, which a client
   * cannot tell from a genuine first page — so a cursor mangled in transit makes
   * a paging loop restart forever.
   */
  it.each([
    ['empty string', ''],
    ['not base64url', '!!!!'],
    ['no separator', Buffer.from('nonsense', 'utf8').toString('base64url')],
    ['non-numeric length', Buffer.from(`x:value${ID}`, 'utf8').toString('base64url')],
    ['exponent length', Buffer.from(`1e3:value${ID}`, 'utf8').toString('base64url')],
    ['negative length', Buffer.from(`-1:value${ID}`, 'utf8').toString('base64url')],
    ['length longer than the body', Buffer.from(`99:short${ID}`, 'utf8').toString('base64url')],
    ['id is not a uuid', Buffer.from('5:valuenot-a-uuid', 'utf8').toString('base64url')],
    ['missing id', Buffer.from('5:value', 'utf8').toString('base64url')],
    ['over the length cap', 'a'.repeat(513)],
  ])('refuses %s', (_label, cursor) => {
    expect(() => decodeTextCursor(cursor)).toThrow(DomainException);
  });

  /**
   * A short declared length would move part of the name into the id.
   *
   * Asserted specifically because it is the one corruption that could still
   * produce a *structurally valid* cursor — the tail happens to be a UUID — and
   * would then page from the wrong row rather than failing.
   */
  it('refuses a length that does not describe the value exactly', () => {
    const forged = Buffer.from(`3:Custom Hoodie${ID}`, 'utf8').toString('base64url');

    expect(() => decodeTextCursor(forged)).toThrow(DomainException);
  });
});
