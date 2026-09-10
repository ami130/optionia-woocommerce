import { Agent } from 'undici';

/**
 * The three services the canonical flow needs, and where they live.
 *
 * Overridable by environment so the same suite can run against a staging stack,
 * but every default is the local development one.
 */
export const SERVICES = {
  api: process.env.E2E_API_URL ?? 'http://localhost:4000',
  dashboard: process.env.E2E_DASHBOARD_URL ?? 'http://localhost:3001',
  /*
   * 🔴 **`https://`, and that is load-bearing.** `InitiateDto` requires the
   * site URL and callback to be absolute `https://` — a credential sent over
   * plain HTTP crosses the network in cleartext, and the handshake exists to
   * deliver one. Studio serves this through `studio config set --domain
   * optionia.local --https`, with WordPress's `home` and `siteurl` pointed at it
   * so `home_url()` returns the same origin the plugin sends.
   */
  store: process.env.E2E_STORE_URL ?? 'https://optionia.local',
} as const;

/** The API's versioned prefix. Every route below it, none above. */
export const API_V1 = `${SERVICES.api}/v1`;

/**
 * An agent that tolerates Studio's self-signed certificate.
 *
 * Built and returned rather than installed globally, so its reach is one `fetch`
 * call. Exported so every caller that needs it shares **this** exception rather
 * than writing its own — two independently-written certificate exemptions are
 * two places to forget the constraint that makes them safe. `undici` ships inside Node; if it cannot be resolved the probe
 * falls back to strict verification and reports the certificate error honestly,
 * which is the correct direction for this to fail.
 */
export function insecureAgent(): unknown {
  /*
   * `undici` is Node's own fetch implementation, imported statically so the
   * lint rule against `require()` is satisfied and the failure — if the shape
   * ever changes — is a build error rather than a silent `undefined`.
   */
  return new Agent({ connect: { rejectUnauthorized: false } });
}

export interface ServiceCheck {
  readonly name: string;
  readonly url: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly hint: string;
}

/**
 * Is a service answering?
 *
 * Deliberately tolerant about *what* it answers: a `401` from a guarded route
 * still proves the process is up, and this check is about liveness, not
 * behaviour. Only a connection failure or a 5xx counts as down.
 */
async function probe(
  name: string,
  url: string,
  hint: string,
  expect?: (status: number, body: string) => string | null,
): Promise<ServiceCheck> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      /*
       * Studio's certificate is self-signed. Accepted **only for this probe**,
       * never as a global setting: an agent that ignores certificate errors
       * everywhere would accept a bad certificate from the API too, and the API
       * is where the credentials go.
       */
      dispatcher: url.startsWith('https://optionia.local')
        ? insecureAgent()
        : undefined,
    } as RequestInit);
    const body = await response.text();

    if (response.status >= 500) {
      return { name, url, ok: false, detail: `answered ${response.status}`, hint };
    }

    /*
     * 🔴 **A PHP fatal error is served with status 200.** Measured while writing
     * this: the Studio site answered `200` for every URL while every response
     * body was `Fatal error: Failed opening required '…/prepend.php'` — a
     * cleaned-up temp file from a stale site process. A status-only liveness
     * check called that site healthy, and the whole suite would have failed
     * later on assertions that had nothing to do with the cause.
     *
     * Checked before the caller's own expectation, because a fatal error can
     * satisfy a loose one: this body contains no JSON, but it does contain a
     * 200.
     */
    if (/<b>(Fatal error|Parse error)<\/b>|PHP Fatal error/.test(body)) {
      const first = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

      return {
        name,
        url,
        ok: false,
        detail: `PHP fatal error behind a ${response.status}: ${first}`,
        hint: `${hint} (a stale Studio process serves this — stop and restart the site)`,
      };
    }

    const complaint = expect?.(response.status, body) ?? null;

    return complaint === null
      ? { name, url, ok: true, detail: `${response.status}`, hint }
      : { name, url, ok: false, detail: complaint, hint };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      detail: error instanceof Error ? error.message : 'unreachable',
      hint,
    };
  }
}

export async function checkServices(): Promise<ServiceCheck[]> {
  return Promise.all([
    probe(
      'API',
      `${SERVICES.api}/health`,
      'cd optioniaWooCommerceBackend && npm run start:dev',
      (status, body) =>
        status === 200 && body.includes('"status":"ok"')
          ? null
          : `health reported ${status}, not ok`,
    ),

    /*
     * 🔴 **Liveness is not identity.** Measured while writing this: port 3000
     * was answering `200` from an entirely different Next.js project, and the
     * suite drove eleven steps against a stranger's site before failing on a
     * missing form field. A check that only asks "is something listening?"
     * cannot tell a running dashboard from a running anything.
     *
     * `/login` is asserted rather than `/` because the root redirects, and the
     * sign-in copy is specific to this product.
     */
    probe(
      'Dashboard',
      `${SERVICES.dashboard}/login`,
      'cd optioniaWooCommerceFrontend && npm run dev',
      (status, body) => {
        if (status !== 200) {
          return `answered ${status}`;
        }

        return /Optionia/i.test(body)
          ? null
          : 'something else is serving this port — it is not the Optionia dashboard';
      },
    ),

    /*
     * The store must be WooCommerce, not merely a WordPress. A bare WP answers
     * 200 and would pass a liveness check while every cart step later failed
     * for a reason the failure would not name.
     */
    probe(
      'WooCommerce store',
      `${SERVICES.store}/?rest_route=/wc/store/v1/products`,
      'open the Optionia site in WordPress Studio',
      (status) =>
        status === 200 ? null : `Store API answered ${status} — is WooCommerce active?`,
    ),
  ]);
}
