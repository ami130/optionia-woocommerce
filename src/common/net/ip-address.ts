import { isIP } from 'node:net';

/** `VARBINARY(16)` holds either family, so every address packs to 16 bytes. */
const ADDRESS_BYTES = 16;

/** The IPv4-mapped IPv6 prefix: `::ffff:a.b.c.d` (RFC 4291 §2.5.5.2). */
const V4_MAPPED_PREFIX = Buffer.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff,
]);

/**
 * Pack an IP address into the 16 bytes `audit_logs.ip` stores.
 *
 * **Binary rather than text**, because that is what the column is: one
 * `VARBINARY(16)` holding both families, so `10.0.0.1` and `::ffff:10.0.0.1`
 * — the same host reaching a dual-stack socket two ways — compare equal
 * instead of looking like two different visitors.
 *
 * IPv4 is stored in its v4-mapped form for exactly that reason.
 *
 * Returns `null` for anything that is not an address. An audit trail with a
 * malformed value in the IP column is worse than one with a gap: the gap is
 * visibly missing, the malformed value looks like evidence.
 */
export function packIpAddress(value: string | null | undefined): Buffer | null {
  if (!value) {
    return null;
  }

  const family = isIP(value);

  if (family === 4) {
    return Buffer.concat([V4_MAPPED_PREFIX, packV4(value)], ADDRESS_BYTES);
  }

  if (family === 6) {
    return packV6(value);
  }

  return null;
}

/**
 * Render packed bytes back to a readable address.
 *
 * Needed wherever a trail is shown to a human or exported for a GDPR subject
 * access request — a `VARBINARY` read straight out of MySQL is unreadable.
 */
export function unpackIpAddress(value: Buffer | null | undefined): string | null {
  if (!value || value.length !== ADDRESS_BYTES) {
    return null;
  }

  if (value.subarray(0, V4_MAPPED_PREFIX.length).equals(V4_MAPPED_PREFIX)) {
    return Array.from(value.subarray(12)).join('.');
  }

  const groups: string[] = [];

  for (let offset = 0; offset < ADDRESS_BYTES; offset += 2) {
    groups.push(value.readUInt16BE(offset).toString(16));
  }

  return groups.join(':');
}

function packV4(value: string): Buffer {
  return Buffer.from(value.split('.').map((octet) => Number(octet)));
}

/**
 * Pack IPv6, expanding the `::` run and any trailing dotted-quad.
 *
 * `isIP` has already confirmed the shape, so this handles form rather than
 * validity.
 */
function packV6(value: string): Buffer {
  let text = value;

  // A v6 address may end in dotted-quad form (`::ffff:127.0.0.1`). Convert that
  // tail to two hex groups so the rest of this function sees one notation.
  const dotted = text.lastIndexOf('.');

  if (dotted !== -1) {
    const separator = text.lastIndexOf(':');
    const quad = text.slice(separator + 1).split('.').map((octet) => Number(octet));
    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);
    text = `${text.slice(0, separator + 1)}${high}:${low}`;
  }

  const [head, tail] = text.split('::');
  const leading = head ? head.split(':').filter(Boolean) : [];
  const trailing = tail === undefined ? [] : tail.split(':').filter(Boolean);
  const gap = 8 - leading.length - trailing.length;
  const groups = [...leading, ...Array<string>(Math.max(gap, 0)).fill('0'), ...trailing];

  const packed = Buffer.alloc(ADDRESS_BYTES);

  groups.slice(0, 8).forEach((group, index) => {
    packed.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2);
  });

  return packed;
}
