import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Fetching a design's layer images so the renderer can draw them (F173).
 *
 * ## Why this exists at all
 *
 * 🔴 **`resvg` renders ONLY `data:` URIs.** Measured four ways at 200×200: a
 * remote `https://`, a `file://` path and a relative path each produce the same
 * **556-byte blank canvas** and report success, while a `data:` URI produces
 * 1,746 bytes of real pixels. The Design Lab meanwhile *requires* absolute
 * `http(s)` and refuses `data:` — deliberately, because `data:` can carry SVG,
 * which M15 refuses on upload as an XSS vector.
 *
 * ⚠️ **So no image layer could ever print.** A merchant's first real order
 * produced a 2000×2000 PNG with nothing on it, reported `ready`. The stored
 * design keeps its `http(s)` URL — the Design Lab's rule is untouched — and the
 * bytes are inlined here, at the last possible moment.
 *
 * ## The SSRF surface this reopens, and what closes it
 *
 * 🔴 **The Stage 0 spike recorded a remote href being ignored as a BENEFIT**:
 * *"No fetch, so no SSRF from a merchant-supplied SVG."* Fetching here gives
 * that back, so every guard below is load-bearing rather than defensive habit:
 *
 *   - **https only.** `http` is refused, not upgraded: a plaintext fetch of a
 *     customer's artwork is a different product decision than this is making.
 *   - **The resolved ADDRESS is checked, not the hostname.** A name that
 *     resolves to `169.254.169.254` is how cloud credentials leak, and a
 *     hostname allowlist cannot see it.
 *   - **No redirects.** A permitted host redirecting to a private address
 *     would otherwise walk straight past the check above.
 *   - **Bounded bytes and time.** An endpoint that streams for ever is a
 *     render that never completes, and `MAX_RENDER_MS` cannot interrupt a
 *     socket.
 *   - **SVG refused by MAGIC BYTES, not by Content-Type.** A server choosing
 *     its own header is not evidence; `<?xml` or `<svg` at the head of the
 *     body is. An SVG inlined into the document it is rendered inside is the
 *     XSS vector `layer-source.ts` refuses at the other end.
 */

/** How long one image may take. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Largest image this will inline, in bytes.
 *
 * 📌 **Four megabytes, against a 0.40 MB measured print file.** A design may
 * carry several layers, and the whole scene is held in memory as a string
 * while `resvg` parses it — a base64 payload is a third larger than the file
 * it encodes.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** The raster formats `resvg` can composite. */
const RASTER_SIGNATURES: ReadonlyArray<{ readonly mime: string; readonly magic: readonly number[] }> = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
];

/** Why one image could not be inlined. */
export type LayerImageRefusal =
  | 'not-https'
  | 'unresolvable-host'
  | 'private-address'
  | 'unreachable'
  | 'too-large'
  | 'not-a-raster';

export interface LayerImageOutcome {
  readonly ok: boolean;
  /** The `data:` URI, when it was fetched. */
  readonly dataUri?: string;
  readonly reason?: LayerImageRefusal;
}

/**
 * Whether an address belongs to a range a render must never reach.
 *
 * 🔴 **Checked after DNS, on the ADDRESS.** `metadata.example.com` resolving to
 * `169.254.169.254` is the shape every cloud-credential leak takes, and a
 * hostname check cannot see it.
 *
 * ⚠️ **IPv4-mapped IPv6 is unwrapped first** — `::ffff:127.0.0.1` is loopback
 * wearing a different hat, and a check that only read the text form would miss
 * it.
 */
export function isPrivateAddress(address: string): boolean {
  const mapped = address.replace(/^::ffff:/i, '');

  if (isIP(mapped) === 4) {
    const parts = mapped.split('.').map(Number);

    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }

    const [a, b] = parts;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  const v6 = mapped.toLowerCase();

  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('ff')
  );
}

/** The raster mime one body announces by its magic bytes, or null. */
export function rasterMimeOf(bytes: Buffer): string | null {
  for (const { mime, magic } of RASTER_SIGNATURES) {
    if (bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte)) {
      return mime;
    }
  }

  return null;
}

/**
 * Fetch one layer image and return it as a `data:` URI.
 *
 * @param href The layer's stored source.
 */
export async function inlineLayerImage(href: string): Promise<LayerImageOutcome> {
  let url: URL;

  try {
    url = new URL(href);
  } catch {
    return { ok: false, reason: 'not-https' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not-https' };
  }

  /*
   * 🔴 **Resolved before the request, and the request goes to the HOSTNAME.**
   * Connecting to the resolved address instead would defeat SNI and
   * certificate validation; the residual DNS-rebinding window is accepted and
   * stated rather than papered over, because the alternative is a fetch that
   * cannot verify who answered.
   */
  let addresses: string[];

  try {
    const resolved = await lookup(url.hostname, { all: true });

    addresses = resolved.map((entry) => entry.address);
  } catch {
    return { ok: false, reason: 'unresolvable-host' };
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return { ok: false, reason: 'private-address' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      /* A permitted host redirecting to a private address would walk past the check above. */
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: 'unreachable' };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'too-large' };
    }

    const mime = rasterMimeOf(buffer);

    if (mime === null) {
      /*
       * ⚠️ **Including every SVG**, which is the point. An SVG inlined into
       * the document it is rendered inside is the XSS vector `layer-source.ts`
       * refuses at the authoring end, and a `Content-Type` header is the
       * server's claim rather than evidence.
       */
      return { ok: false, reason: 'not-a-raster' };
    }

    return { ok: true, dataUri: `data:${mime};base64,${buffer.toString('base64')}` };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** What became of one scene's images. */
export interface InlinedScene {
  readonly scene: Record<string, unknown>;
  /** Layers whose image could not be inlined, and why. */
  readonly refused: ReadonlyArray<{ readonly src: string; readonly reason: LayerImageRefusal }>;
}

/**
 * Replace every layer image in a scene with the bytes it points at.
 *
 * 🔴 **The scene is COPIED, never mutated.** `job.scene` is the snapshot of
 * what the customer bought; rewriting it in place would mean a retry rendered
 * something different from the first attempt, and a stored design would drift
 * into holding megabytes of base64.
 *
 * ⚠️ **A refused image leaves its layer alone and is REPORTED.** Dropping the
 * layer silently is how a blank print file came to be reported as `ready` —
 * the caller decides whether a partial design is worth rendering, and this
 * only states what happened.
 *
 * 📌 **Fetched once per distinct URL.** A design using one badge across four
 * choices is four layers and one request.
 *
 * @param scene The stored scene.
 */
export async function inlineSceneImages(scene: Record<string, unknown>): Promise<InlinedScene> {
  const sources = new Set<string>();

  for (const layer of layersOf(scene)) {
    const src = typeof layer.src === 'string' ? layer.src : '';

    if (src !== '' && !src.startsWith('data:')) {
      sources.add(src);
    }
  }

  if (sources.size === 0) {
    return { scene, refused: [] };
  }

  const resolved = new Map<string, string>();
  const refused: Array<{ src: string; reason: LayerImageRefusal }> = [];

  await Promise.all(
    [...sources].map(async (src) => {
      const outcome = await inlineLayerImage(src);

      if (outcome.ok && outcome.dataUri !== undefined) {
        resolved.set(src, outcome.dataUri);

        return;
      }

      refused.push({ src, reason: outcome.reason ?? 'unreachable' });
    }),
  );

  const copy = JSON.parse(JSON.stringify(scene)) as Record<string, unknown>;

  for (const layer of layersOf(copy)) {
    const src = typeof layer.src === 'string' ? layer.src : '';
    const inlined = resolved.get(src);

    if (inlined !== undefined) {
      layer.src = inlined;
    }
  }

  return { scene: copy, refused };
}

/**
 * Every layer object in a scene, in place.
 *
 * ⚠️ **Shape-tolerant on purpose.** The scene is stored unvalidated — the same
 * decision `option_values.design` records — so a tree missing `groups`, or
 * carrying a layer that is not an object, must be walked rather than thrown on.
 */
function layersOf(scene: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const groups = Array.isArray(scene.groups) ? scene.groups : [];

  for (const group of groups) {
    if (typeof group !== 'object' || group === null) {
      continue;
    }

    const layers = (group as { layers?: unknown }).layers;

    if (!Array.isArray(layers)) {
      continue;
    }

    for (const layer of layers) {
      if (typeof layer === 'object' && layer !== null) {
        out.push(layer as Record<string, unknown>);
      }
    }
  }

  return out;
}
