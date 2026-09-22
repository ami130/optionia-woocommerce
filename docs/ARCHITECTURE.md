# Architecture

**Three repositories, one product.** This document explains the split, the
boundaries between the pieces, and the invariants that make the arrangement safe.
It is the map: the other Gate 1 documents describe individual interfaces, and this
one describes why those interfaces exist where they do.

| Document | Describes |
|---|---|
| `optioniaWooCommerceBackend/docs/CONFIG-CONTRACT.md` | The JSON a storefront renders from |
| `optioniaWooCommerceBackend/docs/API-CONTRACT.md` | Every route, and who may call it |
| `optioniaWooCommerceBackend/docs/DATABASE.md` | Tables, keys, and tenancy |
| `*/[test\|tests]/fixtures/shared/PRICING-SPEC.md` | The pricing rules both engines implement |
| `docs/PREVIEW-FIDELITY.md` | Where the live preview and the storefront agree, and where they deliberately do not — **generated**, never hand-written (ADR-102) |

This file lives at the **repository root**, not inside any one of the three,
because it describes all of them. Putting it in the backend would imply the
backend owns the architecture; it does not.

---

## The three services

> ✏️ **Titled "the three repositories" until 2026-09-22**, when all four were
> merged into one at `github.com/ami130/optionia-woocommerce` with their full
> histories — 277 commits. **Nothing below changes**: they remain three
> independently deployed services that speak only to the backend, and the
> directory layout is unchanged. What changed is where the git history lives,
> which the diagram never described.


```text
optioniaWooCommerceFrontend  ──▶  optioniaWooCommerceBackend  ◀──  optioniaWooCommercePlugin
   Next.js · TypeScript             NestJS · TypeORM · MySQL          PHP 7.4+ · WordPress
   the merchant's dashboard         the multi-tenant SaaS             the merchant's storefront
   ~191 TS/TSX files                79 routes                         ~93 PHP files in src/
```

**They never talk to each other.** The dashboard and the plugin share no code and
no direct connection; both speak only to the backend, over HTTP, with different
credentials and different routes. A merchant authoring an option set and a
customer buying one are two separate conversations with the same server.

### `optioniaWooCommerceBackend` — the SaaS

NestJS on MySQL. It owns every durable fact: tenants, users, stores, option sets,
their published snapshots, and the orders reported back from storefronts. It is
the only piece with a database, and the only piece that can be redeployed at will.

Routes divide into two families that never mix:

- **Dashboard routes** (`/v1/auth/*`, `/v1/option-sets/*`, `/v1/products`, …) —
  authenticated by a **user's JWT**, carrying a `tid` tenant claim, and guarded by
  `JwtAuthGuard → TenantGuard → CapabilityGuard`.
- **Store routes** (`/v1/store/*`, `/v1/connect/*`) — authenticated by a
  **per-store credential** the plugin obtained for itself, guarded by
  `StoreTokenGuard → SiteMatchGuard`. These have no user and no tenant claim.

That separation is why a stolen store credential cannot read a dashboard, and a
stolen dashboard token cannot impersonate a storefront.

### `optioniaWooCommercePlugin` — the storefront

Distributed PHP, installed on servers nobody here controls and **not redeployable
on demand**. Everything about its design follows from that one fact:

- It **cannot be fixed in a hurry**, so it must degrade rather than fail. A
  storefront serves its last known-good configuration when the backend is
  unreachable, and refuses a config document whose `schema_version` exceeds what
  it understands rather than rendering something it half-recognises.
- It is **readable by every merchant who installs it**, so it can never contain a
  shared secret (see *No shared secret*, below).
- Its pricing engine is a **port** of the backend's, not a call to it. A price
  computed during a page render cannot depend on a network round trip.

### `optioniaWooCommerceFrontend` — the dashboard

Next.js App Router. Where merchants author option sets, connect stores, and assign
options to products. It holds no business logic that the backend does not also
enforce: every rule it applies to a form, the API applies again to the request.
The capability table it uses to decide which buttons to show is a **mirror** of the
backend's, kept honest by `bin/check-capability-parity.sh` — the UI's copy exists
to avoid offering an action that would answer `403`, never to decide authorisation.

---

## How a change reaches a storefront

```text
merchant edits an option set        (dashboard  →  backend, JWT)
       │
       ▼
merchant publishes                  a snapshot row is written, and the store's
       │                            config_version is bumped in the same transaction
       ▼
plugin notices                      a 15-minute conditional pull (ETag), or a push
       │                            notification when one is queued
       ▼
plugin fetches /v1/store/config     (plugin  →  backend, store credential)
       │
       ▼
storefront renders from local data  no request is made during a page render
```

**Publishing is what makes an edit visible.** The config document is built from
*published snapshots*, so a draft changes nothing a customer can see — which is
why the dashboard says so when a set is still a draft, and why the version
counters exist.

**`config_version` is the storefront's clock.** Every change a storefront should
see bumps it in the same transaction as the change itself, so the database can
never hold published configuration that no storefront was told about.

---

## The invariants, and what enforces them

An architectural rule that nothing checks is a rule that decays. Each of these has
a gate:

| Invariant | Enforced by |
|---|---|
| No shared secret ships in the plugin | `optioniaWooCommercePlugin/bin/check-secrets.sh` |
| The pricing engine runs without WordPress | `optioniaWooCommercePlugin/bin/check-architecture.sh` |
| Both pricing engines agree | shared fixtures, run in both languages |
| Every route is documented and tenant-scoped | `optioniaWooCommerceBackend` — `check:api`, isolation suite |
| The dashboard's capability table matches the API's | `bin/check-capability-parity.sh` |
| The dashboard's rule vocabulary matches the API's | `bin/check-rule-vocabulary-parity.sh` |
| No backend module is reached only from its own tests | `optioniaWooCommerceBackend/bin/check-reachable.ts` |
| The config document's keys are spelled the way PHP reads them | `bin/check-wire-keys.sh` |
| Every documented public filter still exists, and every filter is documented | `optioniaWooCommercePlugin/bin/check-public-filters.sh` |
| A phase whose exit criteria are all met is not left unticked | `bin/check-ledger.sh` |
| Unstyled options inherit the theme; no absolute colour, no `!important` | `optioniaWooCommercePlugin/bin/check-theme-inheritance.sh` |
| Every style token emitted is consumed where it can inherit | `optioniaWooCommercePlugin/bin/check-style-tokens.sh` |
| A storefront never blocks on the SaaS | no synchronous call in any render path |

**Run every cross-repository gate with `bin/check.sh`** from the repository root.

🔴 **And on this machine they run themselves.** `bash bin/install-hooks.sh` points
this repository's `pre-commit` at `bin/pre-commit.sh`, which runs all 17 before a
commit lands. A gate nobody runs is a gate that decays — this project has recorded
that lesson six times.

⚠️ **"Once per clone" is the design and not yet the state** (F49, F50). The hook
scripts and **12 of the 21 gates** are untracked, so a fresh clone gets 8 files
from `bin/` and runs 6 gates. Until they are tracked, this is enforcement on one
laptop rather than on the repository.

⚠️ **`.github/workflows/ci.yml` exists and is dormant.** None of the four
repositories has a git remote, so Actions has nothing to run and no sub-repository
to check out. It is committed so enforcement is one push away when that changes;
until then the hook is the enforcement, and the workflow says so in its own header.
It discovers `bin/check-*.sh` rather than listing them, so a gate added tomorrow
runs without anyone editing the runner — and a glob that matches nothing fails
rather than reporting a green run over zero checks.

Each repository keeps its own `bin/check.sh` for the checks that live inside it;
these are the ones that span two or more and therefore belong to none.

### No shared secret

The plugin is distributed source. A secret baked into it is a secret published to
every customer at once, and it cannot be rotated without shipping a release.

So the plugin never receives one. It obtains a **per-store credential for itself**
through a PKCE handshake the merchant approves in the dashboard: the site starts
the request, the merchant authorises it while signed in, and the credential that
comes back belongs to that one store. Revoking it affects nobody else.

### The storefront survives the SaaS being down

Configuration is fetched ahead of time and stored locally; rendering reads that
copy. If the backend is unreachable the storefront keeps selling with what it last
received. This is why the config document is a **document** — a complete,
self-contained snapshot — rather than a set of endpoints to query.

### Prices are computed twice, and must agree

The plugin computes a price to display; the backend computes it again to validate.
Two implementations of one specification, in two languages, kept honest by fixtures
both must pass. A price the client proposes is never trusted — the customer's
browser is the least trustworthy participant in the transaction.

---

## Tenancy

One backend serves every merchant. Isolation is structural, not conventional:

- Every tenant-scoped table carries `tenantId`, and every dashboard query narrows
  by the JWT's `tid` claim.
- A store credential resolves to exactly one store, and `SiteMatchGuard` rejects a
  credential presented from a different site.
- "Not found" and "not yours" answer identically, so a caller cannot learn that an
  id exists by being refused it.

The isolation suite tests every route against a second tenant's data. It is a
permanent CI job rather than a one-time audit, because this is the failure whose
cost does not scale with its size: one crossed boundary is a breach.

---

## What is deliberately *not* here

- **No shared code between the plugin and the backend.** They share
  *specifications* — the config contract, the pricing spec, the fixtures — and
  each implements them independently. A shared library would have to satisfy PHP
  7.4 on a merchant's server and Node on ours, and would couple two release
  cycles that must stay independent.
- **No direct dashboard→plugin connection.** The dashboard cannot reach a
  merchant's site; it can only change what that site will fetch next.
- **No storefront request during a page render.** Every customer-facing page reads
  local data. This is the constraint that shapes the sync design, and relaxing it
  would put the SaaS's uptime on the critical path of every merchant's checkout.
