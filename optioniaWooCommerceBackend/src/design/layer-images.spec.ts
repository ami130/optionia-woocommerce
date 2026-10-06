import { isPrivateAddress, rasterMimeOf } from './layer-images';

/**
 * The guards that make fetching a merchant's image safe (F173).
 *
 * 🔴 **The Stage 0 spike recorded `resvg` ignoring a remote href as a
 * BENEFIT** — *"No fetch, so no SSRF from a merchant-supplied SVG."* Inlining
 * images gives that back, so these are the checks that take its place.
 */
describe('layer image guards', () => {
  describe('addresses a render must never reach', () => {
    /*
     * 🔴 **`169.254.169.254` is the one that matters most.** It is the cloud
     * metadata endpoint on AWS, GCP and Azure alike, and reaching it is how
     * instance credentials leak.
     */
    it.each([
      ['cloud metadata', '169.254.169.254'],
      ['loopback', '127.0.0.1'],
      ['all-zeroes', '0.0.0.0'],
      ['private 10/8', '10.0.0.5'],
      ['private 172.16/12', '172.16.0.1'],
      ['private 172.31/12', '172.31.255.254'],
      ['private 192.168/16', '192.168.1.1'],
      ['carrier-grade NAT', '100.64.0.1'],
      ['multicast', '239.0.0.1'],
      ['IPv6 loopback', '::1'],
      ['IPv6 unique local', 'fd00::1'],
      ['IPv6 link-local', 'fe80::1'],
    ])('refuses %s', (_name, address) => {
      expect(isPrivateAddress(address)).toBe(true);
    });

    /*
     * ⚠️ **IPv4-mapped IPv6 is loopback wearing a different hat.** A check
     * reading only the text form would pass `::ffff:127.0.0.1` straight
     * through.
     */
    it.each([
      ['mapped loopback', '::ffff:127.0.0.1'],
      ['mapped metadata', '::ffff:169.254.169.254'],
      ['mapped private', '::ffff:10.1.2.3'],
    ])('refuses %s', (_name, address) => {
      expect(isPrivateAddress(address)).toBe(true);
    });

    it.each([
      ['a public host', '93.184.216.34'],
      ['another public host', '1.1.1.1'],
      ['public IPv6', '2606:4700:4700::1111'],
    ])('permits %s', (_name, address) => {
      expect(isPrivateAddress(address)).toBe(false);
    });

    /*
     * 📌 **172.15 and 172.32 are PUBLIC.** The private range is 172.16–172.31,
     * and an off-by-one at either edge either leaks or blocks a legitimate
     * host — which is why both edges are pinned.
     */
    it.each([
      ['172.15 is public', '172.15.255.255', false],
      ['172.16 is private', '172.16.0.0', true],
      ['172.31 is private', '172.31.255.255', true],
      ['172.32 is public', '172.32.0.0', false],
    ])('%s', (_name, address, expected) => {
      expect(isPrivateAddress(address)).toBe(expected);
    });
  });

  describe('what may be inlined', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39]);

    it.each([
      ['PNG', png, 'image/png'],
      ['JPEG', jpeg, 'image/jpeg'],
      ['GIF', gif, 'image/gif'],
    ])('recognises %s by its magic bytes', (_name, bytes, mime) => {
      expect(rasterMimeOf(bytes)).toBe(mime);
    });

    /*
     * 🔴 **An SVG inlined into the document it is rendered inside is the XSS
     * vector `layer-source.ts` refuses at the authoring end.** Refused here by
     * CONTENT, because a `Content-Type` header is the server's claim rather
     * than evidence.
     */
    it.each([
      ['an SVG', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
      ['an XML-declared SVG', '<?xml version="1.0"?><svg></svg>'],
      ['HTML', '<!DOCTYPE html><html></html>'],
      ['a login page', '<html><body>Sign in</body></html>'],
      ['plain text', 'not an image at all'],
    ])('refuses %s', (_name, body) => {
      expect(rasterMimeOf(Buffer.from(body, 'utf8'))).toBeNull();
    });

    /** A body shorter than any signature cannot be a raster. */
    it('refuses a body too short to identify', () => {
      expect(rasterMimeOf(Buffer.from([0x89, 0x50]))).toBeNull();
      expect(rasterMimeOf(Buffer.alloc(0))).toBeNull();
    });
  });
});
