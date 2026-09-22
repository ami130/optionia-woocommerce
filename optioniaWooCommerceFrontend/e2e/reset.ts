import { execFileSync } from 'node:child_process';

import { SERVICES } from './services';

/**
 * Put the WordPress site back to disconnected.
 *
 * ## Why this exists
 *
 * The canonical flow's first step is *"the merchant connects a store"*, and a
 * site that is already connected shows no **Connect this store** button — so run
 * two of an unreset suite fails on a missing element and reports it as a product
 * defect. Measured: exactly that, the first time the connection half passed.
 *
 * ## Why only the plugin side
 *
 * Clearing the plugin's options leaves the backend's `stores` row behind, and
 * that is **deliberate**. A merchant who reinstalls a plugin is in precisely
 * this state — a live store record, a site that has forgotten its credential —
 * and the handshake must cope with it. Deleting the backend row too would make
 * every run a first-ever connection and quietly stop testing the case that
 * actually happens in production.
 */
/**
 * Empty every persisted WooCommerce cart on the site.
 *
 * 🔴 **Why the browser-side clear was not enough.** WooCommerce keeps a cart per
 * *session row*, and a run that ends mid-flow leaves one behind. Each run
 * publishes a **new option set with a new id**, so those old rows hold selections
 * keyed by ids that no longer exist — and checkout's re-validation refuses the
 * whole basket with *"Finish is no longer available"*.
 *
 * Measured: six stale carts, holding option ids from three earlier runs plus the
 * seed's `opt-finish`. The re-validation was correct every time; the site was
 * carrying rubbish the test never cleared. Clearing the current browser's cart
 * fixed only the one session the browser happened to own.
 */
export function clearCarts(): void {
  /*
   * ⚠️ Through `wp eval`, **not** `wp db query`. Studio's WP-CLI cannot reach the
   * database directly — `wp db query` answers *"Access denied for user
   * 'username_here'"*, because the credentials come from a `wp-config.php` Studio
   * fills in at runtime. It fails silently inside a `try`, which is how the first
   * version of this appeared to work while clearing nothing.
   *
   * `wp eval` runs inside WordPress, where `$wpdb` is already connected.
   */
  /*
   * 🔴 **Two stores, and the second is the one that mattered.**
   *
   * `woocommerce_sessions` holds a guest's cart. A *logged-in* customer also gets
   * a **persistent cart in user meta**, restored on every visit — and this flow
   * signs into WordPress as `admin` to reach the plugin's settings, so it shops
   * as that user. Deleting sessions alone reported `deleted sessions: 0` while
   * stale selections kept reappearing, because they were never in that table.
   */
  const php =
    "global $wpdb;" +
    " $wpdb->query('DELETE FROM ' . $wpdb->prefix . 'woocommerce_sessions');" +
    " $wpdb->query(\"DELETE FROM {$wpdb->usermeta} WHERE meta_key LIKE '%persistent_cart%'\");";

  try {
    execFileSync('studio', ['wp', 'eval', php], {
      cwd: studioPath(),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    /* No table, or no sessions: either way there is no stale cart to clear. */
  }
}

export function disconnectStore(): void {
  const options = [
    'optionia_connection_state',
    'optionia_connection_store',
    'optionia_connection_tenant',
    'optionia_store_token',
    'optionia_circuit_state',

    /*
     * 🔴 **The catalogue walk, or the next run inherits a finished one.** The
     * cursor holds a position against *a* cloud catalogue, and a completed walk
     * correctly refuses to restart — so leaving it here made the next run push
     * nothing for its brand-new store, and the assign step then found no
     * products. Measured: `offset 5 / total 5` survived into a run whose store
     * had zero rows.
     *
     * ⚠️ The plugin clears this on a *merchant-initiated* disconnect
     * (`ConnectionSection`). This helper bypasses that path by deleting options
     * directly, so it has to clear the same things — which is exactly why the
     * omission was invisible.
     */
    'optionia_catalogue_cursor',
  ];

  for (const option of options) {
    try {
      execFileSync('studio', ['wp', 'option', 'delete', option], {
        cwd: studioPath(),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      /* Absent is the desired state, and `option delete` exits non-zero for a
       * key that was never set. Nothing to recover from. */
    }
  }
}

/**
 * Where the Studio site lives.
 *
 * `studio` resolves the site from its working directory, so the path is the
 * whole configuration. Derived from the store's hostname when it can be, and
 * overridable — a machine with a differently-named site should not need a code
 * change.
 */
function studioPath(): string {
  if (process.env.E2E_STUDIO_PATH !== undefined) {
    return process.env.E2E_STUDIO_PATH;
  }

  const home = process.env.HOME ?? '';
  const host = new URL(SERVICES.store).hostname;

  /* `optionia.local` → `optionia`, matching how Studio names a site directory. */
  return `${home}/Studio/${host.replace(/\.local$/, '')}-woocommerce`;
}
