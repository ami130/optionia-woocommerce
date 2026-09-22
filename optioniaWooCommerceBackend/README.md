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
# 1. Databases. utf8mb4, not utf8 — see docs/ENVIRONMENTS.md for why.
mysql -u root -e "CREATE DATABASE optionia_woo_dev  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE DATABASE optionia_woo_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 2. A least-privilege user. Do not develop as root.
mysql -u root -e "
  CREATE USER 'optionia_dev'@'localhost' IDENTIFIED BY 'choose-a-password';
  GRANT ALL PRIVILEGES ON optionia_woo_dev.*  TO 'optionia_dev'@'localhost';
  GRANT ALL PRIVILEGES ON optionia_woo_test.* TO 'optionia_dev'@'localhost';
  FLUSH PRIVILEGES;"

# 3. Configuration. Every value is required; there are no defaults.
cp .env.example .env
openssl rand -base64 48      # paste into JWT_SECRET

# 4. Install and verify.
npm install
npm run check                # secrets, scripts, lint, typecheck, tests
npm run migration:run        # creates the schema
npm run db:seed              # plans and, optionally, a super-admin
npm run db:seed:demo         # a realistic merchant for development
```

`db:seed` is idempotent — re-running updates plans rather than duplicating them.
`db:seed:demo` rebuilds its tenant from scratch, so it never accumulates rows.
Both refuse to run with `NODE_ENV=production`: they insert fabricated data, which
in a merchant's database is corruption rather than a mess to clean up.

To create the first platform administrator, set `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` before running `db:seed`. There is no default — a default
admin password in seed source is a default admin password in every deployment
that forgot to change it, and this account can impersonate any merchant.

Full detail in [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md).

### Current state

The application itself does not exist yet — `src/main.ts` and the domain modules
arrive with their milestones. What is present and working:

| | |
|---|---|
| Configuration | Validated at boot, throws on anything missing (25 tests) |
| Database | Connects; migrations run and revert |
| Quality gates | `npm run check` — secrets, lint, typecheck, tests |
| CI | Runs migrations up, down, and up again |

`npm start` will fail until [Step 1](../developePlan.md#m51--bootstrap-optioniawoocommercebackend)
creates the Nest bootstrap. That is expected.

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
