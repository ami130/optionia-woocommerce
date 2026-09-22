# Environments

Three environments, with genuinely separate credentials. Local development must
be **incapable** of reaching staging or production data — not merely discouraged
from it.

---

## Topology

| | Purpose | Database | Credentials |
|---|---|---|---|
| **local** | Development | Local MySQL, own database | Local only, never shared |
| **staging** | Integration and E2E, against a real WooCommerce store | Separate managed instance | Distinct from production |
| **production** | Live merchants | Managed, private network only, automated backups | Injected at deploy, never in a file |

---

## Local setup

MySQL 9.6 is available via Homebrew. This service owns its database exclusively
and must not share one with any other application.

```bash
mysql -u root -e "CREATE DATABASE optionia_woo_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE DATABASE optionia_woo_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

cp .env.example .env
# fill in DB_USER, DB_PASSWORD, and a generated JWT_SECRET
npm install
npm run migration:run
npm run start:dev
```

`utf8mb4` throughout, not `utf8`. MySQL's `utf8` is three-byte and cannot store
emoji or many CJK characters — a merchant naming an option "🎁 Gift wrap" would
otherwise get a truncation error.

A separate `optionia_woo_test` database exists because tests truncate tables.
Pointing them at the development database destroys your seed data every run.

---

## Configuration rules

1. **No fallback defaults.** `src/config/env.ts` throws on anything missing. See
   [ADR-003](DECISIONS.md#adr-003--configuration-throws-rather-than-defaults).
2. **`.env` is never committed.** `.env.example` holds placeholders only and is
   scanned by `bin/check-secrets.sh`.
3. **Credentials never cross environments.** A local `.env` containing a
   production host is a configuration error, not a shortcut.
4. **Production requires TLS.** `DB_SSL=false` in production throws at boot.
5. **`CORS_ORIGINS` is an explicit allowlist.** `*` is rejected — on a
   multi-tenant API it is a data-exposure risk, and browsers reject it for
   credentialed requests anyway.

---

## Schema changes

`synchronize` is **false** in every environment, including local.

TypeORM's `synchronize: true` alters tables to match entities on boot. It is
convenient locally and catastrophic anywhere else — it will silently drop a
column when an entity changes. Migrations are the only mechanism.

```bash
npm run migration:generate -- src/migrations/DescriptiveName
npm run migration:run
npm run migration:revert    # verify this works BEFORE committing
```

Every migration must revert cleanly. An irreversible migration is a production
incident waiting for a bad deploy.

---

## What is deliberately absent

No shared database with any other project, no shared credentials, no production
access from a developer machine, and no `.env` file in any repository.
