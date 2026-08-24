# Environment Baseline — verified 2026-08-21

Verified by direct inspection of the running Studio site, not from documentation.

## Stack

| Component | Version | Note |
|---|---|---|
| WordPress | 7.1 | |
| WooCommerce | 11.0.1 | requires PHP 7.4 |
| PHP | 8.4 | native runtime |
| Active theme | Storefront 4.6.2 | classic theme |
| Also installed | Twenty Twenty-Three / Four / Five | block themes, for M2.8 + M29.2 |
| Site URL | http://localhost:8881/ | |
| CLI | `studio wp <cmd>` from site dir | full WP-CLI |

## HPOS — already enabled

`woocommerce_custom_orders_table_enabled = yes`

Order #22 datastore confirmed as:
`Automattic\WooCommerce\Internal\DataStores\Orders\OrdersTableDataStore`

**Consequence:** the modern path is the default here. The plan requires testing with HPOS
both enabled and disabled (M2.2, M4.7, M12.5) — the *disabled* case is now the one needing
deliberate setup, not the reverse.

## Existing data — after M2.3 (updated 2026-08-21)

| ID | Name | Type | Price |
|---|---|---|---|
| 14 | spider man | simple | $300 |
| 20 | Custom Hoodie | simple | $80 |
| 23 | Test Variable Tee | **variable** | $20–30 |
| 24/25/26 | ↳ Small / Medium / Large | variations | $20 / $25 / $30 |
| 27 | Test Grouped Bundle | **grouped** | children 14, 20 |
| 28 | Test External Product | **external** | $99, links offsite |

Global attribute: `Size` (id 1, `pa_size`) with terms Small(18) / Medium(19) / Large(20).

All four WooCommerce product types now exist — required by M10.5 and M2.3.
- Orders: 1 — #22, `processing`, $300.00, 1 line item
- **Order #22 line item meta count: 0** — clean baseline

The zero-meta baseline is useful: any line meta appearing later is unambiguously ours.

## M2.3 — COMPLETE

All four product types created. This directly produced **Finding 4** in
`integration-points.md`: the render hook fires in different places per product type, which
corrected M10.5 in the plan.

## Active plugins that add noise

`jetpack`, `pinterest-for-woocommerce`, `reddit-for-woocommerce`,
`snapchat-for-woocommerce` — all active. Worth deactivating during hook tracing so the
sequence is legible.

## Debug flags — ENABLED 2026-08-21

```
WP_DEBUG         true
WP_DEBUG_LOG     true      → wp-content/debug.log
WP_DEBUG_DISPLAY true
SCRIPT_DEBUG     true      → unminified core JS/CSS
```

Backup of the original at `wp-config.php.bak`. Verified: WordPress boots, site returns
HTTP 200, no PHP errors on the page.

**Note for later:** `WP_DEBUG_DISPLAY = true` prints notices into page output. Fine locally;
must never reach a merchant site.
