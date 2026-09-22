import { execFileSync } from 'node:child_process';

import { DB } from './fixtures';
import { SERVICES } from './services';

/*
 * ✏️ **`importProducts()` was here, and M19.1 deleted it.**
 *
 * It was a one-shot read of the WooCommerce Store API that wrote
 * `store_products` with **raw SQL**, standing in for a catalogue import that
 * did not exist yet. Its own docblock set the condition: *"when M19.1 lands,
 * this goes, and the flow uses the product's own import."*
 *
 * 🔴 **Keeping it would have been worse than never writing it.** While it
 * existed, the canonical flow passed whether or not an ingest endpoint worked —
 * so the acceptance for the real push was only real once this was gone. The
 * plan put it plainly: *"the repository carries two import paths and the second
 * one is the one nobody remembers writing."*
 *
 * `pushCatalogue()` below is the replacement, and it runs the plugin's own cron
 * event rather than touching the database at all.
 */

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
 * A product the set is **not** assigned to.
 *
 * 🔴 **The control half of the category assertion.** "Product renders the set"
 * proves a category resolved only if that product would otherwise render
 * nothing — run against the directly-assigned product it passes through the
 * manual path and proves nothing about taxonomy at all.
 *
 * Chosen from the mirror rather than hardcoded: the ids here are whatever the
 * Studio site happens to hold, and a literal would rot the first time the
 * fixture store is rebuilt.
 */
export function unassignedExternalId(storeId: string, setName: string): string {
  /*
   * 🔴 **The store id is passed in, not re-derived here.** An earlier version
   * selected the store itself with `storeUrl = ? AND status = 'connected'`,
   * which is *not* enough to name one row: `reset.ts` deliberately leaves the
   * backend's `stores` row behind on every run — *"a merchant who reinstalls a
   * plugin is in precisely this state"* — so connected rows for one URL
   * accumulate, and `LIMIT 1` over them picks by accident.
   *
   * Measured: the only row matching that filter was three weeks old and held a
   * *different* published set assigned to the very product this returns, while
   * the plugin was bound to a newer row the filter called `disconnected`. The
   * negative assertion survived only because the cloud scopes the config
   * document to the bound store, so the stale set never reached the plugin —
   * the query was wrong and the answer was right by coincidence.
   *
   * `connectedStoreId()` already resolves this correctly (newest wins), so the
   * caller passes its result rather than a second selector existing here to
   * drift away from it.
   *
   * ⚠️ `externalId` is a **string** column, so `ORDER BY` on it is lexical
   * ("1000" sorts before "20"). Cast, so the choice is stable and means what
   * it reads as.
   */
  const output = run(
    `SELECT p.externalId FROM store_products p
      WHERE p.storeId = ?
        AND p.externalId NOT IN (
              SELECT a.targetRef FROM option_set_assignments a
                JOIN option_sets os ON os.id = a.optionSetId
               WHERE os.name = ?
                 AND a.targetType = 'product'
                 AND a.targetRef IS NOT NULL
            )
      ORDER BY CAST(p.externalId AS UNSIGNED) LIMIT 1`,
    [storeId, setName],
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

/**
 * Push one batch of the real catalogue to the cloud (M19.1).
 *
 * 🔴 **This is the real thing, and it replaced a stand-in that was not.**
 * `importProducts()` wrote `store_products` with raw SQL, so the canonical flow
 * passed whether or not an ingest endpoint existed; it was deleted at M19.1 and
 * the note at the top of this file records why. Running
 * `optionia_cron_push_catalogue` exercises the path a merchant's store
 * actually uses: `CataloguePayload` reads WooCommerce, `CataloguePusher` posts
 * to `POST /v1/store/products`, and the API writes the mirror.
 *
 * One batch carries 250 products, so a test store is covered by a single run.
 */
export function pushCatalogue(): void {
  execFileSync('studio', ['wp', 'cron', 'event', 'run', 'optionia_cron_push_catalogue'], {
    cwd: process.env.E2E_STUDIO_PATH ?? `${process.env.HOME}/Studio/optionia-woocommerce`,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

/**
 * Run the daily reconciliation sweep now (M19.3).
 *
 * The plugin sends the ids its store actually holds and the cloud removes the
 * rows the store no longer claims. Scheduled daily, which is right for a
 * storefront and useless for a test — running the hook exercises **the same
 * code path** the schedule would.
 */
export function reconcileCatalogue(): void {
  execFileSync('studio', ['wp', 'cron', 'event', 'run', 'optionia_cron_reconcile_catalogue'], {
    cwd: studioPath(),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

/**
 * Put a product in the cloud mirror that the store does not have.
 *
 * 🔴 **The drift reconciliation exists to repair.** WordPress hooks are
 * best-effort: a deletion while the site is offline, or a queue entry dropped
 * by `ProductQueue::MAX_ENTRIES`, leaves the mirror holding a product the store
 * no longer sells. Nothing in the normal flow produces that state on demand, so
 * the test writes it directly — this is the *precondition*, not the behaviour
 * under test.
 *
 * ⚠️ **The id must sort inside the manifest's range.** A final manifest is
 * unbounded above, but a phantom outside the range a *non*-final page covered
 * is deliberately untouchable (ADR-075), so an id chosen carelessly would prove
 * the opposite of what the step claims.
 */
export function plantPhantomProduct(storeId: string, externalId: string): void {
  run(
    `INSERT INTO store_products
       (id, createdAt, updatedAt, storeId, externalId, name, type, status, syncedAt)
     VALUES (UUID(), NOW(3), NOW(3), ?, ?, 'Phantom — should be reconciled away',
             'simple', 'publish', NOW(3))
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [storeId, externalId],
  );
}

/** How many rows the mirror holds for one store. */
export function mirroredCount(storeId: string): number {
  return Number(
    run(`SELECT COUNT(*) FROM store_products WHERE storeId = ?`, [storeId]).trim(),
  );
}

/** Whether the mirror holds one specific product. */
export function isMirrored(storeId: string, externalId: string): boolean {
  return (
    run(`SELECT COUNT(*) FROM store_products WHERE storeId = ? AND externalId = ?`, [
      storeId,
      externalId,
    ]).trim() !== '0'
  );
}

/**
 * The Studio site every WP-CLI helper here runs against.
 *
 * Three call sites had this fallback inline before M19.6 needed a fourth, and
 * a path that is *nearly* the same in four places is the kind of duplication
 * that drifts silently — one of them keeping an old directory name would send
 * its command to a site that still answers, just not the one under test.
 */
function studioPath(): string {
  return process.env.E2E_STUDIO_PATH ?? `${process.env.HOME}/Studio/optionia-woocommerce`;
}

/** Run one WP-CLI command against the Studio site, returning its stdout. */
function wpCli(args: string[]): string {
  return execFileSync('studio', ['wp', ...args], {
    cwd: studioPath(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Put a product in a product category, creating the term if it is absent.
 *
 * 🔴 **The category has to be real, and before M19.6 it was not.** The step
 * that authored `summer` never created the term or put a product in it, so the
 * assignment resolved against nothing. That was invisible while taxonomy was
 * *deferred* — a target the index only counted did not need to exist — and it
 * becomes the whole point once the index **resolves** it: `has_term()` is what
 * decides, and it answers `false` for a category no product is in.
 *
 * Returns the term id, so the caller can remove exactly what it created.
 */
export function assignProductCategory(productId: number, slug: string): string {
  /*
   * `term create` fails when the term exists, which is a normal state on a
   * re-run rather than an error: the id is what matters, so look first.
   */
  const existing = wpCli(['term', 'list', 'product_cat', `--slug=${slug}`, '--field=term_id']);

  const created = existing === '';

  const termId = created
    ? wpCli(['term', 'create', 'product_cat', slug, `--slug=${slug}`, '--porcelain'])
    : existing;

  /*
   * 🔴 **Undo the term if attaching it fails.** Observed: a bad product id made
   * `post term add` throw *after* the term was created, so the caller never
   * received an id and its `finally` had nothing to clean up — the category
   * survived the run and broke the next one's "renders nothing" precondition.
   * Whatever this function created, it removes before rethrowing.
   */
  try {
    wpCli(['post', 'term', 'add', String(productId), 'product_cat', slug]);
  } catch (error) {
    if (created && termId !== '') {
      try {
        wpCli(['term', 'delete', 'product_cat', termId]);
      } catch {
        /* The original failure is the one worth reporting. */
      }
    }

    throw error;
  }

  return termId;
}

/**
 * Undo `assignProductCategory()`.
 *
 * ⚠️ **`term delete` takes the id, not the slug.** Passing a slug reports
 * `Success: Term already deleted.` and deletes nothing, so a cleanup written
 * the obvious way leaves the term behind and reports that it did not.
 */
export function removeProductCategory(productId: number, slug: string, termId: string): void {
  wpCli(['post', 'term', 'remove', String(productId), 'product_cat', slug]);

  if (termId !== '') {
    wpCli(['term', 'delete', 'product_cat', termId]);
  }
}

/**
 * Move a product to the trash, as the WordPress admin's own button does.
 *
 * 🔴 **`wp_trash_post()` through `wp eval`, not `wp post delete`.** Measured:
 * WP-CLI refuses a product with *"Posts of type 'product' do not support being
 * sent to trash. Please use the --force flag"* — it consults
 * `post_type_supports( 'product', 'trash' )`, which WooCommerce does not
 * declare, even though the site has `EMPTY_TRASH_DAYS = 30` and
 * `wp_trash_post()` itself succeeds. Taking `--force` instead would permanently
 * delete and fire `before_delete_post`, exercising a **different hook** than
 * the admin's button.
 *
 * `wp_trash_post()` is what *Move to Trash* calls, and it fires `trashed_post`
 * — the hook `ProductWatcher` listens on, for the reason ADR-074 records.
 */
export function trashProduct(externalId: string): void {
  wpCli(['eval', `wp_trash_post( ${Number(externalId)} );`]);
}

/**
 * Undo `trashProduct()`.
 *
 * 📌 **No status repair needed.** An earlier draft forced `publish` back,
 * believing WordPress untrashes to `draft`. Measured: it restores the previous
 * status — `after untrash: publish` — because `wp_untrash_post()` reads
 * `_wp_desired_post_status`. Forcing it would have hidden a real regression if
 * that ever stopped working.
 */
export function restoreProduct(externalId: string): void {
  wpCli(['eval', `wp_untrash_post( ${Number(externalId)} );`]);
}

/*
 * ✏️ **No `drainProductQueue()` here, deliberately.** The first draft added one
 * running `optionia_cron_drain_products` — a hook that does not exist.
 * `QueueDrainer::register()` hangs the drain off `CRON_PUSH_CATALOGUE`, so
 * `pushCatalogue()` above already drains the queue, and a second helper would
 * have run a no-op cron event and reported success.
 */
