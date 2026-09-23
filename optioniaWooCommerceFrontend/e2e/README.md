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

**`POST /connect/initiate` allows 10 per hour.** Each run spends one, so the
**eleventh** run in an hour answers `429`, the plugin redirects to
`?optionia_connection=failed`, and it looks exactly like a broken handshake. The
test names the cause when it sees that.

⚠️ **Restarting the API resets the counter, and that is what makes it look
random.** The throttler's store is in memory: a restart — including any
recompile under `nest start --watch` — refills the budget. Measured while
diagnosing this: ten consecutive runs passed after a restart and the eleventh
failed with three `429`s on that endpoint, while earlier sessions that
restarted the API mid-run saw failures scattered at roughly one run in three
with no apparent pattern. If the rate looks erratic, count restarts before
suspecting the flow.

📌 **Counting calls in the API log: it prints a line for the request *and* the
response.** Eleven lines mentioning `/connect/initiate` is ten calls, not
eleven. Count distinct `requestId`s.

🔴 **Empty `SMTP_HOST` before running these, or every run emails you.** Each
run registers a merchant at `e2e-<stamp>@optionia.test` — a domain that does
not resolve. With SMTP configured the API really sends the verification
message, the receiving server rejects it, and the bounce lands in the
mailbox that `SMTP_USER` signs in as. **Observed in the wild**: the owner of
this project got one *"Address not found"* per run, from a suite nobody
thought was touching mail at all.

With `SMTP_HOST` empty the message goes to the ops log instead — it is
printed in full, verification link included, under `context: "LogTransport"`
— which is the documented development default and is all these tests need.
`verifyEmail()` marks the address verified directly in the database, so the
suite never reads the mail either way. Restore your SMTP values only while
deliberately testing delivery, and empty the host again afterwards.

⚠️ **The API must be restarted, not just rebuilt** — see the note on
`nest start --watch` below.

**`POST /auth/refresh` allows 60 per hour, and its failure names the wrong
thing.** A run signs in and refreshes repeatedly, so a few runs exhaust the
bucket — and from then on every navigation lands on **Sign in** while the suite
reports whatever assertion that screen fails first: a missing empty state, an
absent site name, a set that will not open. It reads as a rendering defect.
Measured directly: `curl -X POST .../v1/auth/refresh` answering `429` to an
unauthenticated probe means the bucket, not the page. Set
`THROTTLE_REFRESH_LIMIT` in the backend's `.env` (it is documented in
`.env.example`, and is test-only — 60/hour is a brute-force control on the one
route that mints access tokens).

⚠️ **The API must be restarted, not just rebuilt.** `nest start --watch`
recompiles on a source change and keeps the environment it booted with, so a
`.env` edit does not reach a running watcher — the variable looks set and
changes nothing.

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
