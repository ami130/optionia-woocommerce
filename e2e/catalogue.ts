import { execFileSync } from 'node:child_process';

import { DB } from './fixtures';
import { insecureAgent, SERVICES } from './services';

/**
 * Import the store's real products, so the picker has something to assign.
 *
 * ## Why this exists
 *
 * 🔴 **The assign step never ran.** It was written to branch — assign when a
 * product exists, otherwise assert the honest "not imported yet" empty state —
 * and `store_products` is empty for every store this suite creates, so the
 * `else` branch took every run. A branch that has never executed is not
 * coverage; it reads as coverage, which is worse than an absent test.
 *
 * ## Why it reads WooCommerce rather than inventing rows
 *
 * The ids have to be **real**. An assignment targets `externalId` — WooCommerce's
 * id — and the whole point of the assign step is proving that the id written by
 * the dashboard is the one the storefront resolves. Fabricated ids would let the
 * step pass while pointing at products that do not exist, which is exactly the
 * silent failure [J4](../../developePlan.md) describes.
 *
 * ## Why this is not M19.1
 *
 * [M19.1](../../developePlan.md) owns the real catalogue import: scheduled,
 * incremental, webhook-driven, handling deletions. This is none of that — it is
 * a one-shot read of the Store API so a test has data. When M19.1 lands, this
 * goes, and the flow uses the product's own import.
 */
export async function importProducts(storeId: string): Promise<number> {
  const response = await fetch(
    `${SERVICES.store}/?rest_route=/wc/store/v1/products&per_page=10`,
    {
      signal: AbortSignal.timeout(15_000),
      /* Studio's certificate is self-signed; the same scoped exception the
       * service probes use, not a second one written here. */
      dispatcher: insecureAgent(),
    } as RequestInit,
  );

  if (!response.ok) {
    throw new Error(`Could not read the store's catalogue (${response.status}).`);
  }

  const products = (await response.json()) as Array<{
    id: number;
    name: string;
    sku: string;
    type: string;
    permalink: string;
    prices: { price: string; currency_minor_unit: number };
  }>;

  /* Only what a merchant can actually buy: a grouped or external product has no
   * price of its own, and assigning options to one is a later question. */
  const usable = products.filter((product) => product.type === 'simple');

  for (const product of usable) {
    /*
     * `prices.price` is already **minor units as a string** — WooCommerce's Store
     * API reports `"2000"` with `currency_minor_unit: 2` for £20.00. Parsed as an
     * integer, never multiplied: this is the conversion Phase 11 spent a stage on.
     */
    const priceMinor = Number.parseInt(product.prices.price, 10);

    run(
      `INSERT INTO store_products
         (id, createdAt, updatedAt, storeId, externalId, name, sku, type,
          priceMinor, status, permalink, syncedAt)
       VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, ?, ?, ?, 'publish', ?, NOW(3))
       ON DUPLICATE KEY UPDATE name = VALUES(name), priceMinor = VALUES(priceMinor)`,
      [
        storeId,
        String(product.id),
        product.name,
        product.sku === '' ? null : product.sku,
        product.type,
        Number.isFinite(priceMinor) ? String(priceMinor) : null,
        product.permalink,
      ],
    );
  }

  return usable.length;
}

/** The store the plugin is connected to, as the backend knows it. */
export function connectedStoreId(): string | null {
  const output = run(
    `SELECT id FROM stores WHERE storeUrl = ? AND status = 'connected'
      ORDER BY createdAt DESC LIMIT 1`,
    [SERVICES.store],
  );

  return output.trim() === '' ? null : output.trim();
}

function run(sql: string, params: Array<string | null> = []): string {
  /*
   * Parameters are substituted through `mysql`'s own prepared statement support
   * rather than string-concatenated: a product name is merchant text, and this
   * runs against a real database.
   */
  const prepared = params.length === 0 ? sql : buildPrepared(sql, params);

  return execFileSync(
    'mysql',
    [`-h${DB.host}`, `-P${DB.port}`, `-u${DB.user}`, `-p${DB.password}`, DB.name, '-N', '-e', prepared],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

/** `PREPARE`/`EXECUTE`, so no value is ever concatenated into the statement. */
function buildPrepared(sql: string, params: Array<string | null>): string {
  const sets = params
    .map((value, index) =>
      value === null ? `SET @p${index} = NULL;` : `SET @p${index} = ${quote(value)};`,
    )
    .join('\n');

  const names = params.map((unused, index) => `@p${index}`).join(', ');

  return `${sets}\nPREPARE stmt FROM ${quote(sql)};\nEXECUTE stmt USING ${names};\nDEALLOCATE PREPARE stmt;`;
}

/** MySQL string literal: backslashes and quotes escaped, nothing else trusted. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The credential the plugin holds right now.
 *
 * Read from WordPress rather than the database: the point of the assertion it
 * serves is that the *plugin's own* token opens the config document, and taking
 * it from the API's side would prove only that some valid token exists.
 */
export function storeToken(): string {
  try {
    return execFileSync('studio', ['wp', 'option', 'get', 'optionia_store_token'], {
      cwd: process.env.E2E_STUDIO_PATH ?? `${process.env.HOME}/Studio/optionia-woocommerce`,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Which product the set was assigned to, as the API records it.
 *
 * Read back rather than assumed: the picker assigns whichever product the
 * catalogue lists first, and the storefront step must visit *that* one. Visiting
 * a guess would land on a page with no options and report a missing renderer —
 * a test defect wearing a product defect's clothes.
 */
export function assignedExternalId(setName: string): string {
  const output = run(
    `SELECT a.targetRef FROM option_set_assignments a
       JOIN option_sets os ON os.id = a.optionSetId
      WHERE os.name = ? ORDER BY a.id DESC LIMIT 1`,
    [setName],
  );

  return output.trim();
}

/**
 * A product's storefront URL.
 *
 * 🔴 **`?p=20` does not work for a product.** WordPress's plain-permalink form
 * needs `post_type` too, and without it the request returns *nothing* — no 404,
 * just an empty body. The render assertion above it then passed against a page
 * that was not the product at all, which is a test proving nothing while
 * reporting success.
 *
 * The permalink is taken from `store_products`, where the catalogue import
 * already stored WooCommerce's own value, and falls back to the explicit query
 * form rather than the broken short one.
 */
export function productUrl(externalId: string): string {
  const stored = run(
    `SELECT permalink FROM store_products WHERE externalId = ? ORDER BY syncedAt DESC LIMIT 1`,
    [externalId],
  ).trim();

  if (stored !== '' && stored !== 'NULL') {
    /* The stored permalink may predate the HTTPS switch; keep the host current. */
    return `${SERVICES.store}${new URL(stored).pathname}`;
  }

  return `${SERVICES.store}/?post_type=product&p=${externalId}`;
}

/**
 * Pull the config document now, instead of waiting for the schedule.
 *
 * The plugin refreshes every fifteen minutes (`Scheduler::INTERVAL = 900`),
 * which is correct for a storefront and useless for a test. Running the cron
 * hook directly exercises **the same code path** the schedule would — this
 * shortens the wait, it does not bypass the sync.
 */
export function syncPluginConfig(): void {
  execFileSync('studio', ['wp', 'cron', 'event', 'run', 'optionia_cron_sync_config'], {
    cwd: process.env.E2E_STUDIO_PATH ?? `${process.env.HOME}/Studio/optionia-woocommerce`,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}
