# Optionia WooCommerce Backend

The SaaS API for Optionia. Merchants author option sets here; the WooCommerce
plugin renders them.

**Stack:** NestJS 11 · TypeScript · TypeORM · MySQL

---

## What this service owns

| Owns | Does not own |
|---|---|
| Authoring — option sets, groups, options, values, rules | Rendering options on a storefront |
| Multi-tenancy and authorization | The customer's transaction |
| Store connections and credentials | Cart, checkout, payment |
| Config document generation | The trusted price calculation at add-to-cart |
| Billing, plans, usage | |
| Analytics | |

The plugin holds the **trusted** price calculation because it must run without a
network call. This service is the source of truth for *configuration*; the plugin
is the source of truth for what a customer is *charged*.

---

## Setup

Requires Node 20+ and MySQL 8+.

```bash
mysql -u root -e "CREATE DATABASE optionia_woo_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

cp .env.example .env
# fill in DB_USER, DB_PASSWORD, and: openssl rand -base64 48  -> JWT_SECRET

npm install
npm run migration:run
npm run start:dev
```

Full detail in [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md).

---

## Verification

```bash
npm run check        # secrets, lint, typecheck, tests
```

Individually:

```bash
npm run check:secrets   # hardcoded credentials, env fallbacks, tracked .env
npm run lint
npm run typecheck
npm run test
```

`check:secrets` runs first in CI, independently. A leaked credential fails the
build even when everything else passes.

---

## Principles

These are enforced, not aspirational.

**1. Configuration throws, never defaults.** `src/config/env.ts` validates every
variable at boot. A missing value aborts startup with a message naming it. There
is no `process.env.X || 'localhost'` anywhere — that pattern is how a process
silently reaches the wrong database, and `bin/check-secrets.sh` fails the build
on it. See [ADR-003](docs/DECISIONS.md).

**2. Everything is data-driven.** No hardcoded option types, plan limits, labels,
or prices. Adding an option type must touch three files, not thirty. See
[ADR-002](docs/DECISIONS.md).

**3. Money is integer minor units.** Never a float. `DECIMAL(12,4)` in the
database, integers in application code, converted once at the boundary. The
plugin's PHP `Support\Money` uses the identical representation so both can be
verified against one shared fixture suite.

**4. Tenant isolation at the data-access layer.** Not in controllers, not by
convention. A query without tenant context throws rather than returning unscoped
rows.

**5. Migrations only.** `synchronize` is false in every environment including
local. Every migration must revert cleanly — CI runs up, down, and up again.

---

## Layout

```text
src/
├── config/       env validation, TypeORM data source
├── migrations/   schema history — the only way tables change
├── common/       shared kernel: money, tenancy, guards, interceptors
└── <domain>/     one module per domain, added per milestone
```

Domain modules are created **when their milestone arrives**, not upfront. An
empty directory is a promise the code has not made yet.

---

## Documentation

| | |
|---|---|
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision record, append-only |
| [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md) | Local, staging, production topology |
| `../developePlan.md` | The build plan — phases, milestones, acceptance criteria |
