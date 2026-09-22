import { packIpAddress, unpackIpAddress } from './ip-address';

describe('packIpAddress', () => {
  it('packs IPv4 into 16 bytes', () => {
    const packed = packIpAddress('192.168.1.10');

    expect(packed).toHaveLength(16);
    expect(unpackIpAddress(packed)).toBe('192.168.1.10');
  });

  /**
   * The reason the column is binary rather than text. The same host reaching a
   * dual-stack socket two ways must not look like two visitors.
   */
  it('treats an IPv4-mapped address as identical to its IPv4 form', () => {
    expect(packIpAddress('127.0.0.1')).toEqual(packIpAddress('::ffff:127.0.0.1'));
  });

  it('packs IPv6, expanding the :: run', () => {
    const packed = packIpAddress('2001:db8::1');

    expect(packed).toHaveLength(16);
    expect(unpackIpAddress(packed)).toBe('2001:db8:0:0:0:0:0:1');
  });

  it('packs the all-zero and loopback v6 addresses', () => {
    expect(packIpAddress('::')).toEqual(Buffer.alloc(16));
    expect(unpackIpAddress(packIpAddress('::1'))).toBe('0:0:0:0:0:0:0:1');
  });

  it('packs a full, uncompressed v6 address', () => {
    const address = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';

    expect(unpackIpAddress(packIpAddress(address))).toBe('2001:db8:85a3:0:0:8a2e:370:7334');
  });

  /**
   * A malformed value in the IP column looks like evidence. A gap is visibly
   * missing. Prefer the gap.
   */
  it.each([
    ['empty', ''],
    ['not an address', 'not-an-ip'],
    ['a hostname', 'localhost'],
    ['an octet out of range', '999.1.1.1'],
    ['sql-ish junk', "1.1.1.1'; DROP TABLE audit_logs--"],
    ['a newline injection attempt', '1.1.1.1\nfake'],
  ])('returns null for %s', (_label, value) => {
    expect(packIpAddress(value)).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(packIpAddress(null)).toBeNull();
    expect(packIpAddress(undefined)).toBeNull();
  });
});

describe('unpackIpAddress', () => {
  it('returns null for null and for a wrong-width buffer', () => {
    expect(unpackIpAddress(null)).toBeNull();
    expect(unpackIpAddress(Buffer.alloc(4))).toBeNull();
  });

  it('round-trips every address it packed', () => {
    const addresses = ['0.0.0.0', '255.255.255.255', '10.0.0.1', '8.8.8.8'];

    addresses.forEach((address) => {
      expect(unpackIpAddress(packIpAddress(address))).toBe(address);
    });
  });
});
