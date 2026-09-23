import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The API's database, for the two steps that have no HTTP path.
 *
 * Read from the environment rather than hard-coded, and defaulted to the local
 * development values in `optioniaWooCommerceBackend/.env`.
 */
function backendEnv(): Record<string, string> {
  /*
   * Read from the API's own `.env` rather than duplicated here. A second copy of
   * a database password is a second thing to rotate, and the first one to be
   * forgotten — and a suite configured against the wrong database would verify a
   * user the API never sees.
   */
  try {
    const path = join(process.cwd(), '..', 'optioniaWooCommerceBackend', '.env');

    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.match(/^([A-Z_]+)\s*=\s*(.*)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => [match[1], match[2].trim().replace(/^["']|["']$/g, '')]),
    );
  } catch {
    return {};
  }
}

const ENV = backendEnv();

export const DB = {
  host: process.env.E2E_DB_HOST ?? ENV.DB_HOST ?? '127.0.0.1',
  port: process.env.E2E_DB_PORT ?? ENV.DB_PORT ?? '3306',
  user: process.env.E2E_DB_USER ?? ENV.DB_USER ?? 'optionia_dev',
  password: process.env.E2E_DB_PASSWORD ?? ENV.DB_PASSWORD ?? '',
  name: process.env.E2E_DB_NAME ?? ENV.DB_NAME ?? 'optionia_woo_dev',
} as const;

/**
 * A merchant who has never existed before, per run.
 *
 * The canonical flow starts at "merchant registers", so it needs an address no
 * previous run has claimed. Reusing one would make run *n* a different test from
 * run 1 — the second would exercise "log in", not "register", and the criterion
 * says register.
 */
export function newMerchant() {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  return {
    email: `e2e-${stamp}@optionia.test`,
    /* Long, mixed, and not a dictionary word: the API enforces real strength. */
    password: `E2e-Canonical-${stamp}!`,
    name: `E2E Merchant ${stamp}`,
    tenantName: `E2E Workspace ${stamp}`,
  };
}

export type Merchant = ReturnType<typeof newMerchant>;

/**
 * Verify the address without a mailbox.
 *
 * Registration sends a verification email, and `(app)` stays closed until the
 * address is verified. There is no inbox in this environment and **no test route
 * that mints a token** — the backend's own e2e suites reach past the API and set
 * `emailVerifiedAt` directly, so this does the same, through `mysql`.
 *
 * ⚠️ **This is the one step of the canonical flow that is not the merchant's own
 * path**, and it is worth naming rather than hiding. Everything before and after
 * it goes through the real UI. The alternative — wiring a mail catcher into the
 * suite — would test the mail provider, which is not what Gate 1 is proving.
 */
export function verifyEmail(email: string): void {
  const escaped = email.replace(/'/g, "''");

  execFileSync(
    'mysql',
    [
      `-h${DB.host}`,
      `-P${DB.port}`,
      `-u${DB.user}`,
      `-p${DB.password}`,
      DB.name,
      '-e',
      `UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = '${escaped}'`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
}

/**
 * Give this merchant a connected store, without spending the handshake budget.
 *
 * 🔴 **A precondition, not the behaviour under test.** `POST /connect/initiate`
 * allows **10 per hour** — the cap that made Gate 1 look flaky until it was
 * measured — and a usability walkthrough that burns one per run would exhaust
 * it in ten runs while proving nothing about the handshake. The canonical suite
 * already tests the real connection; these tests need only its *result*.
 *
 * ⚠️ **Keyed to the merchant's tenant**, so each run seeds its own store and
 * nothing is shared between them.
 */
export function seedConnectedStore(email: string, storeUrl = 'https://usability.test'): void {
  const escaped = email.replace(/'/g, "''");

  execFileSync(
    'mysql',
    [
      `-h${DB.host}`,
      `-P${DB.port}`,
      `-u${DB.user}`,
      `-p${DB.password}`,
      DB.name,
      '-e',
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, connectedAt)
       SELECT UUID(), tm.tenantId, 'woocommerce', 'Usability store', '${storeUrl}',
              'connected', NOW(3)
         FROM users u
         JOIN tenant_members tm ON tm.userId = u.id
        WHERE u.email = '${escaped}'
        LIMIT 1`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
}
