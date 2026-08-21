# Optionia for WooCommerce

Advanced product options for WooCommerce, configured from the Optionia cloud
dashboard and rendered on the merchant's storefront by this plugin.

## Architecture

The plugin is a **projection of cloud configuration**, not an authoring tool.
Option sets, pricing and rules are created in the Optionia dashboard; this plugin
caches the resulting configuration document and evaluates it locally.

```
Optionia Cloud  ──signed config pull──▶  this plugin  ──▶  WooCommerce
   (authoring)                            (evaluation)      (transaction)
```

Three layers, dependencies pointing one way only:

| Layer | Directory | Rule |
|---|---|---|
| Integration | `src/Integration/`, `src/Admin/`, `src/Frontend/` | WordPress/WooCommerce hooks. No business logic. |
| Domain | `src/Engine/` | Pure functions. **No WordPress.** Unit-testable without a bootstrap. |
| Infrastructure | `src/Api/`, `src/Config/`, `src/Support/` | HTTP, caching, logging, storage. |

`src/Engine/` is a port of the cloud's TypeScript evaluators and shares a fixture
suite with them, so the two implementations cannot drift.

## Invariants

1. **The storefront never blocks on the API.** Configuration is served from a
   local cache; if Optionia is unreachable, stores keep selling.
2. **Price is server-authoritative.** The browser sends selection keys only —
   never prices, labels or totals.
3. **No SaaS secret ships in this plugin.** Only a per-store, revocable token.
4. **Money is never a float.** `Support\Money` holds integer minor units.
5. **Loud in development, safe in production.** A broken invariant throws under
   `WP_DEBUG` and degrades gracefully without it.

## Development

```bash
composer install
composer lint                # PHPCS, WordPress-Extra + Docs
composer check:architecture   # layering guards
composer test                 # PHPUnit
composer check                # all of the above
```

`bin/check-architecture.sh` enforces the invariants above in CI. A convention
nobody checks is a convention nobody keeps.

### Local setup

Symlink the repository into a WordPress install:

```bash
ln -s /path/to/optioniaWooCommercePlugin wp-content/plugins/optioniaWooCommercePlugin
wp plugin activate optioniaWooCommercePlugin
```

Point at a local API with a constant in `wp-config.php`:

```php
define( 'OPTIONIA_API_URL', 'http://localhost:4000/v1' );
```

## Requirements

PHP 7.4+ · WordPress 6.0+ · WooCommerce 8.0+

Compatible with High-Performance Order Storage and with Cart & Checkout Blocks.

## Templates

Every template is theme-overridable. Copy from `templates/` into
`your-theme/woocommerce/optionia/` and it takes precedence.

## License

GPL-2.0-or-later
