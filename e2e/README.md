# The canonical Gate 1 flow

One end-to-end test, in a real browser, across all three repositories:

```text
register → verify → sign in → connect a store (full PKCE handshake)
  → create an option set → add a radio option at £10.50
  → import the catalogue → assign → publish
  → the storefront receives it → disconnect
```

**Every repository's own suite passes while the product is broken in the one way
that matters: the three disagreeing with each other.** Phase 12 measured exactly
that — the plugin and the API each green, disagreeing about `value_key`, and every
engraving order silently dropped. This is the only test that would have caught it.

## Running it

```bash
npm run e2e          # headless
npm run e2e:ui       # Playwright's UI, for watching it work
```

It **refuses to run** unless three services answer, and names what to start:

| Service | Default | Start it with |
|---|---|---|
| API | `http://localhost:4000` | `cd optioniaWooCommerceBackend && npm run start:dev` |
| Dashboard | `http://localhost:3001` | `cd optioniaWooCommerceFrontend && npm run dev` |
| WooCommerce | `https://optionia.local` | open the site in WordPress Studio |

Override any of them with `E2E_API_URL`, `E2E_DASHBOARD_URL`, `E2E_STORE_URL`.

## One-time environment setup

### 1. The store must serve HTTPS

`InitiateDto` requires `site_url` and `callback` to be absolute `https://` URLs.
That is not a technicality: the handshake exists to deliver a credential, and one
sent over plain HTTP crosses the network in cleartext. A Studio site is
`http://localhost:8881` out of the box, and the handshake **cannot complete**
against it.

```bash
cd ~/Studio/optionia-woocommerce
studio config set --domain optionia.local --https
studio wp option update home    'https://optionia.local'
studio wp option update siteurl 'https://optionia.local'
```

The certificate is self-signed, which is why the suite runs with
`ignoreHTTPSErrors`. That is only safe while every origin is local, so
`global-setup.ts` **enforces** it — point this at a remote stack and it refuses.

> **Do not "fix" this by relaxing the DTO.** A localhost exemption gated on
> `NODE_ENV` is the smaller diff and the more dangerous change: code whose purpose
> is to weaken a security boundary when a variable says so is one misconfigured
> deploy from weakening it in production.

### 2. The plugin must point at your local API

Otherwise it uses its production default and hands a real connection request to
the real service. In `~/Studio/optionia-woocommerce/wp-config.php`:

```php
if ( ! defined( 'OPTIONIA_API_URL' ) ) {
	define( 'OPTIONIA_API_URL', 'http://localhost:4000/v1' );
}
```

### 3. `APP_URL` and `CORS_ORIGINS` must match your dashboard's port

Next picks the next free port when 3000 is taken. `authorize_url` is built from
`APP_URL`, so a stale value sends a merchant mid-handshake to whatever occupies
that port — on the machine this was written on, an unrelated project.

## What each file does

| File | |
|---|---|
| `canonical.spec.ts` | The flow. One test per half, `test.step` for the breakdown |
| `global-setup.ts` | Refuses to run against a broken or non-local environment; cleans up prior runs |
| `services.ts` | The three URLs, and liveness probes that check **identity**, not just a `200` |
| `fixtures.ts` | A fresh merchant per run; verifies the address without a mailbox |
| `catalogue.ts` | Imports the store's real products — stands in for M19.1 |
| `reset.ts` | Clears the plugin's connection so run *n* matches run 1 |
| `cleanup.ts` | Removes tenants, users and stores from previous runs |

## Things that will bite you

**`POST /connect/initiate` allows 10 per hour.** Each run spends one. After about
five runs the handshake answers `429`, the plugin redirects to
`?optionia_connection=failed`, and it looks exactly like a broken handshake. The
test names the cause when it sees that; restarting the API resets the counter.

**A connected site shows no Connect button**, so `reset.ts` disconnects the plugin
before each run. It deliberately leaves the backend's store row alone — a merchant
who reinstalls a plugin is in precisely that state, and the handshake must cope.

**Liveness is not identity.** Both service probes were wrong when first written:
port 3000 was serving an unrelated project, and the Studio site returned `200` for
every URL while serving a PHP fatal error. Both now check what answered, not that
something did.

## What is not here yet

The storefront render, the customer's selection, cart, checkout, and the order's
option row. Those need [M19.1](../../developePlan.md)'s catalogue import to make
the flow a merchant's own rather than a seeded one; `catalogue.ts` is a stand-in
that reads the Store API directly, and it goes when M19.1 lands.
