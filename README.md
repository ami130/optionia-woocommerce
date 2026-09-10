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

Run every quality gate with one command — it finds a PHP binary automatically,
falling back to the one bundled with WordPress Studio:

```bash
bash bin/check.sh
```

That runs, in order: `php -l` on every file, the architecture guards, PHPCS
(WordPress-Extra + Docs), and the unit suite.

Individual gates:

```bash
composer install              # once, to get PHPCS and PHPUnit
composer lint                 # PHPCS
composer lint:fix             # PHPCBF, auto-fixes formatting
composer check:architecture   # layering guards
composer test:unit            # PHPUnit, no WordPress needed
```

### Storefront JavaScript

`assets/js/frontend.js` has its own suite, because two real defects shipped while
it had none: a dropdown's price estimate silently totalled £0 for an entire
release, and the character counter's grapheme parity with PHP was proven twice by
throwaway harnesses that were then deleted.

```bash
npm install                   # once, dev-only — nothing here ships
npm test                      # Vitest, drives the real file through jsdom
```

The tests are **black-box**: `frontend.js` is an IIFE that exports nothing, so
they load it into a jsdom window, dispatch real events and assert on the DOM.
Some read markup produced by the *real* renderer — `tests/js/generate-fixtures.php`
regenerates it, and `bin/check-js.sh` runs that for you.

⚠️ **`bin/check-js.sh` skips these when `node_modules/` is absent**, so the PHP
gates still work without Node. In CI that skip is a **failure** instead: absent
tooling there means 60-odd tests silently did not run.

### Mutation testing

A green suite is not coverage. Use `bin/mutate.sh` from the repository root
rather than a hand-rolled probe — it reports a mutant as killed when a *suite
fails to compile* (a lower test total, not a failure), which a naive
`grep 'N failed'` misses entirely, and refuses to report at all when the
mutation never applied.

```bash
bin/mutate.sh 825 optioniaWooCommercePlugin/src/Engine/SelectionResolver.php \
  'old code' 'mutated code' -- php vendor/bin/phpunit
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
