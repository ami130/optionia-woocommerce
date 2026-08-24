# Database Design

The reference Phases 6–13 build against. Written before any entity file, because
the data model is the hardest thing to change once merchant data exists in it.

**26 tables.** MySQL 8+, InnoDB, `utf8mb4_unicode_ci` throughout.

---

## Conventions

These apply to every table. Where a table departs from one, the reason is stated
inline.

| | Convention | Why |
|---|---|---|
| **Primary key** | `CHAR(36)` UUIDv7 on tenant-scoped tables | Non-enumerable, time-sortable. [ADR-004](DECISIONS.md#adr-004--uuidv7-primary-keys-for-tenant-scoped-entities) |
| **Money** | `BIGINT` minor units, column named `*_minor` | Matches `Support\Money` exactly; no conversion. [ADR-013](DECISIONS.md#adr-013--money-is-stored-as-bigint-minor-units-not-decimal) |
| **Timestamps** | `DATETIME(3)` UTC, `created_at` + `updated_at` | Millisecond precision; ordering within a request matters for audit |
| **Soft delete** | `deleted_at DATETIME(3) NOT NULL DEFAULT '1970-01-01'` on merchant content only. **Never nullable** | [ADR-014](DECISIONS.md#adr-014--soft-delete-applies-to-merchant-content-only) |
| **Charset** | `utf8mb4` | MySQL's `utf8` is 3-byte and cannot store "🎁 Gift wrap" |
| **Enums** | `VARCHAR` + application validation, not MySQL `ENUM` | Adding a value to a MySQL `ENUM` is an `ALTER TABLE` on a live table |
| **JSON** | Only for per-type config; every column has a Zod schema | [ADR-015](DECISIONS.md#adr-015--what-belongs-in-a-json-column) |

**Every tenant-scoped table has `tenant_id` or an FK path to one.** That is what
makes the scoped repository (M6.4) possible: a query with no tenant context
throws rather than returning unscoped rows.

**Five tables are deliberately outside tenant scope:**

| Table | Why |
|---|---|
| `tenants` | **Is** the tenant. There is nothing to scope it to |
| `platform_staff` | The other identity realm. Deliberately separate so no row shape can express "merchant who is also super_admin" ([M6.5](../../developePlan.md#m65--roles-and-permission-matrix)) |
| `plans` | Global product catalogue. Every tenant reads the same rows |
| `users` | One person may belong to several tenants; membership lives in `tenant_members` |
| `billing_events` | A provider webhook arrives before the tenant is resolved, and must be recorded even when resolution fails |

These are excluded **by name**, not by omission — the scoped repository holds
this list, and `test/schema.e2e-spec.ts` asserts that every other table reaches a
tenant through some foreign-key path. A new table cannot escape scoping by
accident: it either has a path or it fails the test.

---

## The shape

```text
                    ┌──────────┐         ┌────────────────┐
                    │  users   │────────►│ platform_staff │  separate table:
                    └────┬─────┘         └────────────────┘  no row can express
                         │                                   "merchant who is
                         ▼                                    also super_admin"
   ┌─────────┐    ┌───────────────┐    ┌────────────────────┐
   │ tenants │◄───│ tenant_members│    │ tenant_invitations │
   └────┬────┘    └───────────────┘    └────────────────────┘
        │
        ├──────────────┬───────────────────┬──────────────────┐
        ▼              ▼                   ▼                  ▼
   ┌────────┐    ┌────────────┐    ┌──────────────┐   ┌───────────────┐
   │ stores │    │ option_sets│    │subscriptions │   │ usage_records │
   └───┬────┘    └─────┬──────┘    └──────────────┘   └───────────────┘
       │               │
       ├── store_credentials       ├── option_groups
       ├── store_products          │      ├── options ──── option_values
       ├── order_events            │      └── presentational_items
       │      └── order_selections ├── option_rules
       ├── webhook_deliveries      ├── option_set_assignments
       └── sync_jobs               └── option_set_versions
```

---

## 1. Tenancy (M5.2)

### `tenants`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | UUIDv7 |
| `name` | VARCHAR(120) | |
| `slug` | VARCHAR(64) | `UNIQUE` — used in URLs |
| `status` | VARCHAR(20) | `active` · `suspended` · `cancelled` |
| `plan_id` | CHAR(36) FK → `plans` | |
| `trial_ends_at` | DATETIME(3) NULL | |
| `created_at`, `updated_at` | DATETIME(3) | |

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `email` | VARCHAR(255) | `UNIQUE`. Stored lowercase — case-sensitive email is a duplicate-account bug |
| `password_hash` | VARCHAR(255) | bcrypt, cost ≥ 12. Named `_hash` so no one mistakes it for a password |
| `email_verified_at` | DATETIME(3) NULL | NULL means unverified; no separate boolean to disagree with it |
| `name` | VARCHAR(120) | |
| `locale` | VARCHAR(10) | Drives email language |
| `last_login_at` | DATETIME(3) NULL | |

A user is **not** tenant-scoped — the same person may belong to several tenants.

### `tenant_members`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) FK → `tenants` | |
| `user_id` | CHAR(36) FK → `users` | |
| `role` | VARCHAR(20) | `owner` · `admin` · `editor` · `viewer` · `billing` |
| `invited_by` | CHAR(36) FK → `users` NULL | |
| `invited_at`, `accepted_at`, `revoked_at` | DATETIME(3) NULL | |

`UNIQUE (tenant_id, user_id)` — one membership per person per tenant.

A join table rather than `users.tenant_id`, because agencies manage several
merchant tenants and that is a real early segment.

### `tenant_invitations`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) FK | |
| `email` | VARCHAR(255) | Invitee may not have an account yet |
| `role` | VARCHAR(20) | Cannot exceed the inviter's own role |
| `token_hash` | CHAR(64) | **Hashed.** A readable invite token in the database is a readable invite token in a backup |
| `invited_by` | CHAR(36) FK → `users` | |
| `expires_at`, `accepted_at`, `revoked_at` | DATETIME(3) | |

`INDEX (token_hash)` for lookup, `INDEX (tenant_id, email)` for the pending list.

### `platform_staff`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `user_id` | CHAR(36) FK → `users` | `UNIQUE` |
| `role` | VARCHAR(20) | `super_admin` · `support` · `billing_ops` · `read_only` |
| `granted_by` | CHAR(36) FK → `users` | |
| `granted_at`, `revoked_at` | DATETIME(3) | |

**A separate table, not a role on `tenant_members`.** Realm separation is
structural: there is no row shape expressing "merchant who is also super_admin",
so no bug can create one.

### `impersonation_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `staff_user_id` | CHAR(36) FK → `users` | |
| `tenant_id` | CHAR(36) FK → `tenants` | |
| `consented_at` | DATETIME(3) | Merchant consent is required, not assumed |
| `started_at`, `ends_at`, `ended_at` | DATETIME(3) | Time-boxed |
| `reason` | VARCHAR(500) | |

Never soft-deleted, never purged. This is the audit trail for staff acting as a
merchant.

---

## 2. Store connection (M5.3)

### `stores`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id` | CHAR(36) FK | |
| `platform` | VARCHAR(20) | `woocommerce` only at launch. An enum from day one so a second platform is an adapter, not a migration |
| `name`, `store_url` | VARCHAR(255) | |
| `status` | VARCHAR(20) | `disconnected` · `connecting` · `connected` · `error` · `revoked` (M8.1b) |
| `connected_at`, `last_seen_at` | DATETIME(3) NULL | `last_seen_at` from the heartbeat; stale installs are visible without asking |
| `plugin_version`, `wp_version`, `wc_version`, `php_version` | VARCHAR(20) NULL | Support diagnostics |
| `config_version` | BIGINT | Drives cache invalidation |

`UNIQUE (tenant_id, store_url)` — a store connects to one tenant.
`INDEX (last_seen_at)` for stale-install detection.

### `store_credentials`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `store_id` | CHAR(36) FK | |
| `token_hash` | CHAR(64) | **SHA-256.** The plaintext token is shown once and never stored |
| `token_prefix` | CHAR(8) | First 8 chars, for support identification only |
| `scopes` | VARCHAR(255) | |
| `last_used_at`, `revoked_at`, `expires_at` | DATETIME(3) NULL | |

`INDEX (token_hash)`. Rotation creates a new row rather than updating, so a
compromised credential's usage history survives its revocation.

---

## 3. Option domain (M5.4)

### `option_sets`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `tenant_id`, `store_id` | CHAR(36) FK | |
| `name` | VARCHAR(160) | |
| `status` | VARCHAR(20) | `draft` · `published` · `archived` |
| `version` | INT | Incremented on publish |
| `row_version` | INT | **Optimistic lock** (M7.4b). A stale write is a 409, not a silent overwrite |
| `published_at`, `published_by` | | |
| `deleted_at` | DATETIME(3) NULL | Soft |

### `option_groups`

`id`, `option_set_id` FK, `label`, `description`, `display_type`
(`inline` · `accordion` · `tabs` · `stepped`), `sort_order`, `is_collapsible`,
`deleted_at`.

### `options`

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) PK | |
| `option_group_id` | CHAR(36) FK | |
| `key` | VARCHAR(64) | **Immutable after first publish.** Order meta stores it; a rename would make historic orders unreadable |
| `value_kind` | VARCHAR(20) | `none` · `text` · `number` · `date` · `file` · `choice` |
| `cardinality` | VARCHAR(10) | `none` · `one` · `many` |
| `presentation` | VARCHAR(30) | `radio` · `dropdown` · `color_swatch` … |
| `label`, `description`, `placeholder`, `help_text` | | |
| `is_required` | BOOLEAN | |
| `sort_order` | INT | |
| `default_value` | VARCHAR(255) NULL | |
| `validation`, `pricing`, `display` | JSON | Per-type; Zod-validated |
| `deleted_at` | DATETIME(3) NULL | |

`UNIQUE (option_group_id, `key`, deleted_at)` — the `deleted_at` component lets a
merchant reuse a key after deleting the option that held it.

⚠️ **`deleted_at` is `NOT NULL DEFAULT '1970-01-01 00:00:00.000'`, not nullable.**
With a nullable column the constraint enforces nothing: `NULL != NULL` in a MySQL
unique index, so every live row is distinct from every other and unlimited
duplicates are accepted. Verified and corrected — see
[ADR-014](DECISIONS.md#adr-014--soft-delete-applies-to-merchant-content-only).

A row is **live** when `deleted_at = '1970-01-01 00:00:00.000'`, never
`deleted_at IS NULL`.

**Three axes, not one type enum** ([M5.4b](../../developePlan.md#m54b--type-model-kind-cardinality-and-presentation-as-separate-axes)):
a single-select and multi-select colour swatch are one type with different
cardinality, not two types. Same renderer, same validator, same pricing path.

### `option_values`

`id`, `option_id` FK, `value_key`, `label`, `sort_order`,
**`price_type`** (`fixed` · `percentage` · `per_unit` · `per_char` · `tiered`),
**`price_amount_minor`** BIGINT, `price_config` JSON (tier brackets etc.),
`image_url`, `color_hex`, `sku_suffix`, `weight_delta_grams`, `is_default`,
`deleted_at`.

`UNIQUE (option_id, value_key, deleted_at)` — same sentinel rule.

**Price type and amount are real columns, not JSON** — analytics, plan limits and
"which values cost more than X" all filter on them ([ADR-015](DECISIONS.md#adr-015--what-belongs-in-a-json-column)).

### `option_rules`

`id`, `option_set_id` FK, `target_type` (`option` · `group` · `value`),
`target_id`, `action` (`show` · `hide` · `require` · `unrequire` · `set_price` ·
`set_default`), `conditions` JSON, `match_type` (`all` · `any`), `sort_order`,
`is_enabled`, `deleted_at`.

`is_enabled` exists because a rule whose target is deleted is **disabled and
flagged**, never silently dropped and never left to fail at evaluation.

### `presentational_items`

`id`, `option_group_id` FK, `kind` (`heading` · `paragraph` · `divider` ·
`rich_text`), `content` TEXT, `sort_order`, `display` JSON, `deleted_at`.

**A separate table, not a row in `options`.** These have no value, no validation,
no pricing and produce no cart data. Modelling them as options would force
null-checks through the renderer, validator, pricing engine, cart and order
persistence — five subsystems paying for one convenience.

`rich_text` is merchant-authored markup rendered on a **public storefront**, so
it is sanitised at publish *and* at render, and plan-gated.

### `option_set_versions` — [ADR-017](DECISIONS.md#adr-017--option_set_versions-belongs-to-phase-5)

`id`, `option_set_id` FK, `version` INT, `snapshot` JSON, `published_by`,
`published_at`, `note`.

`UNIQUE (option_set_id, version)`. Immutable — never updated, never soft-deleted.
Rollback publishes a prior snapshot as a *new* version rather than rewriting
history.

---

## 4. Assignment (M5.5)

### `option_set_assignments`

`id`, `option_set_id` FK, `mode` (`all` · `manual` · `conditional`),
`target_type` (`product` · `category` · `tag` · `attribute` · `price_range`),
`target_ref` VARCHAR(255), `match_rules` JSON, `priority` INT, `deleted_at`.

`INDEX (option_set_id, mode)`, `INDEX (target_type, target_ref)`.

`priority` resolves overlap: a product may match several sets, and resolution
order must be deterministic rather than incidental.

**Conditional rules resolve in the cloud at publish time** and materialize into
the config document as a product list — never evaluated in the plugin at render
time, which would violate AC3.

---

## 5. Product mirror (M5.6)

### `store_products`

`id`, `store_id` FK, `external_id` VARCHAR(64), `name`, `sku`, `type`,
`price_minor` BIGINT, `status`, `permalink`, `image_url`, `categories` JSON,
`tags` JSON, `synced_at`, `external_updated_at`.

`UNIQUE (store_id, external_id)`, `INDEX (store_id, name)` for the picker search.

**A cache for the picker UI, never a source of truth.** `price_minor` is
display-only — the plugin always uses WooCommerce's live price. Hard-deleted
(ADR-014): a product removed in WooCommerce should vanish, and reconciliation
rebuilds it if that was wrong.

---

## 6. Order facts (M5.7)

### `order_events`

`id`, `store_id` FK, `external_order_id` VARCHAR(64), `order_total_minor` BIGINT,
`currency` CHAR(3), `option_revenue_minor` BIGINT, `occurred_at`, `raw` JSON.

`UNIQUE (store_id, external_order_id)` — idempotent ingestion. The plugin retries
order reporting, and a retry must not double-count revenue.

### `order_selections` — [ADR-016](DECISIONS.md#adr-016--option_key-outlives-its-option-by-design)

`id`, `order_event_id` FK, `option_key`, `option_label`, `value_key`,
`value_label`, `price_delta_minor` BIGINT, `config_version` BIGINT.

**No foreign key to `options` or `option_values`, deliberately.** Phase 4 proved a
deleted option still completes an order; an order is a historical fact and does
not change because configuration later did. Labels are snapshotted so a rename
never rewrites what a customer saw on their receipt.

⚠️ **May contain personal data** — an engraving, a gift message. Therefore
**hard-erased** on a GDPR request, never soft-deleted (ADR-014).

---

## 7. Billing (M5.8)

### `plans`

`id`, `code` VARCHAR(32) `UNIQUE`, `name`, `price_monthly_minor`,
`price_yearly_minor`, `currency`, `limits` JSON, `features` JSON, `is_public`,
`sort_order`.

`limits` is JSON because every value must be **measurable in code** and the metric
set grows: option sets, assigned products, storage, stores, seats. A limit that
cannot be measured cannot be sold.

### `subscriptions`

`id`, `tenant_id` FK, `plan_id` FK, `provider` VARCHAR(32),
`provider_subscription_id` VARCHAR(128), `status`, `current_period_end`,
`grace_ends_at`, `cancel_at`, `trial_ends_at`.

`provider` is a plain string so D1 (billing provider, still open) fits without a
migration.

### `usage_records`

`id`, `tenant_id` FK, `metric` VARCHAR(40), `value` BIGINT, `period_start`,
`period_end`. `INDEX (tenant_id, metric, period_start)`.

### `billing_events`

`id`, `provider`, `provider_event_id` VARCHAR(128), `type`, `payload` JSON,
`processed_at`, `error`.

**`UNIQUE (provider, provider_event_id)`** — the idempotency guarantee for
Phase 23. Providers retry webhooks; a duplicate must be a no-op, not a double
charge.

---

## 8. Operational (M5.9)

### `webhook_deliveries`

`id` BIGINT AUTO_INCREMENT, `store_id` FK NULL, `direction` (`inbound` ·
`outbound`), `event`, `payload` JSON, `status`, `attempts` INT, `last_error`,
`next_retry_at`, `created_at`.

`BIGINT` rather than UUID: never externally addressable, high volume, and 8 bytes
beats 36 at millions of rows.

### `audit_logs`

`id` BIGINT AUTO_INCREMENT, `tenant_id` FK NULL, `user_id` FK NULL, `action`,
`resource_type`, `resource_id`, `changes` JSON, `ip` VARBINARY(16), `user_agent`,
`created_at`.

`ip` as `VARBINARY(16)` holds IPv4 and IPv6 in one column. ⚠️ IP is personal data
under GDPR — subject to the retention policy in Phase 26b.

### `sync_jobs`

`id` BIGINT AUTO_INCREMENT, `store_id` FK, `type`, `status`, `started_at`,
`finished_at`, `stats` JSON, `error`.

---

## Referential integrity

Every foreign key declares its delete behaviour. MySQL defaults to `RESTRICT`,
which fails safe but fails *late* — the wrong default surfaces as a blocked
deletion twenty phases from now, in the middle of a GDPR erasure request.

Four rules, chosen by what the row *is*:

| Rule | Applies to | Reasoning |
|---|---|---|
| `CASCADE` | Structural children that cannot exist alone | An `option_value` without its `option` is orphaned data nothing can read |
| `RESTRICT` | Anything financial or legally retained | Deleting must be a deliberate act with the children handled first |
| `SET NULL` | Actor references on records that outlive the actor | An audit log must survive the user it describes |
| *(none)* | Denormalized historical facts | No foreign key at all — see [ADR-016](DECISIONS.md#adr-016--option_key-outlives-its-option-by-design) |

### The full map

Every rule below is compared against `information_schema` by `bin/check-docs.sh`
in CI, and the check fails if any foreign key here is missing or disagrees with
the schema ([ADR-020](DECISIONS.md#adr-020--documentation-that-states-a-guarantee-is-checked-mechanically)).
This table is consulted to answer whether GDPR erasure is possible, so a wrong
answer here gets acted upon — it is checked rather than trusted.

```sql
-- Tenancy ------------------------------------------------------------------
tenants.plan_id            → plans(id)              ON DELETE RESTRICT
tenant_members.tenant_id   → tenants(id)            ON DELETE CASCADE
tenant_members.user_id     → users(id)              ON DELETE CASCADE
tenant_members.invited_by  → users(id)              ON DELETE SET NULL
tenant_invitations.tenant_id → tenants(id)          ON DELETE CASCADE
tenant_invitations.invited_by → users(id)           ON DELETE SET NULL
platform_staff.user_id     → users(id)              ON DELETE CASCADE
platform_staff.granted_by  → users(id)              ON DELETE SET NULL
impersonation_sessions.staff_user_id → users(id)    ON DELETE RESTRICT
impersonation_sessions.tenant_id     → tenants(id)  ON DELETE RESTRICT

-- Stores -------------------------------------------------------------------
stores.tenant_id           → tenants(id)            ON DELETE RESTRICT
store_credentials.store_id → stores(id)             ON DELETE CASCADE
store_products.store_id    → stores(id)             ON DELETE CASCADE

-- Option domain ------------------------------------------------------------
option_sets.tenant_id      → tenants(id)            ON DELETE RESTRICT
option_sets.store_id       → stores(id)             ON DELETE CASCADE
option_groups.option_set_id       → option_sets(id) ON DELETE CASCADE
options.option_group_id           → option_groups(id) ON DELETE CASCADE
option_values.option_id           → options(id)     ON DELETE CASCADE
presentational_items.option_group_id → option_groups(id) ON DELETE CASCADE
option_rules.option_set_id        → option_sets(id) ON DELETE CASCADE
option_set_assignments.option_set_id → option_sets(id) ON DELETE CASCADE
option_set_versions.option_set_id → option_sets(id) ON DELETE CASCADE
option_set_versions.published_by  → users(id)       ON DELETE SET NULL

-- Order facts --------------------------------------------------------------
order_events.store_id      → stores(id)             ON DELETE RESTRICT
order_selections.order_event_id → order_events(id)  ON DELETE CASCADE
order_selections.option_key     → (no FK — ADR-016)

-- Billing ------------------------------------------------------------------
subscriptions.tenant_id    → tenants(id)            ON DELETE RESTRICT
subscriptions.plan_id      → plans(id)              ON DELETE RESTRICT
usage_records.tenant_id    → tenants(id)            ON DELETE CASCADE

-- Operational --------------------------------------------------------------
webhook_deliveries.store_id → stores(id)            ON DELETE CASCADE
sync_jobs.store_id          → stores(id)            ON DELETE CASCADE
audit_logs.tenant_id        → tenants(id)           ON DELETE SET NULL
audit_logs.user_id          → users(id)             ON DELETE SET NULL
```

### The four that would bite

**`audit_logs.user_id` is `SET NULL`, not `RESTRICT`.** Under `RESTRICT`, deleting
a user would be *impossible* while any audit entry referenced them — and Phase 26b
requires erasing a user on request. The log must record that an action happened
even after the actor is gone; the `action`, `resource_id` and `changes` columns
carry the meaning, and the identity is the part being erased.

**`order_events.store_id` is `RESTRICT`.** These are financial records. Disconnecting
a store must not silently take its revenue history with it — a merchant
reconnecting later, or an accountant asking about last quarter, both depend on
those rows surviving.

**`stores.tenant_id` is `RESTRICT`, but `option_sets.store_id` is `CASCADE`.**
Deleting a tenant with connected stores should fail loudly rather than quietly
disconnecting live storefronts. But once a *store* is genuinely deleted, its
option sets have nothing left to render on.

**`impersonation_sessions` is `RESTRICT` on both sides.** This is the record of
staff acting as a merchant. It must not be removable by deleting either party.

### Where soft delete sits

`ON DELETE` governs *hard* deletes only. Merchant-facing deletion is
[soft](DECISIONS.md#adr-014--soft-delete-applies-to-merchant-content-only) —
moving `deleted_at` off its sentinel to a real timestamp, which no foreign key
sees. `CASCADE` on the option domain is
therefore a safety net for genuine row removal (a purge, a test teardown), not the
mechanism a merchant's "delete" button uses.

---

## Index plan

The hot path is config generation: every merchant store polls it, and it is the
one query that must stay fast at scale.

```sql
-- Config document assembly, most-selective first
INDEX (store_id, status, deleted_at)     ON option_sets
INDEX (option_set_id, sort_order)        ON option_groups
INDEX (option_group_id, sort_order)      ON options
INDEX (option_id, sort_order)            ON option_values
INDEX (option_set_id, is_enabled)        ON option_rules

-- Auth and connection
UNIQUE (email)                            ON users
INDEX  (token_hash)                       ON store_credentials
UNIQUE (tenant_id, user_id)               ON tenant_members

-- Idempotency
UNIQUE (provider, provider_event_id)      ON billing_events
UNIQUE (store_id, external_order_id)      ON order_events
UNIQUE (store_id, external_id)            ON store_products

-- Operations
INDEX (status, next_retry_at)             ON webhook_deliveries
INDEX (tenant_id, created_at)             ON audit_logs
INDEX (last_seen_at)                      ON stores
```

---

## How this design is protected

Everything above is a claim about MySQL, and MySQL is the only place these
constraints exist. `migration:run` proves the migration executes — not that it
produced the intended schema.

`test/schema.e2e-spec.ts` asserts the guarantees against a live database, and
runs in CI alongside the migration cycle:

| Asserted | Why it would otherwise regress silently |
|---|---|
| The four critical delete rules | A flip to `RESTRICT` on `audit_logs.userId` makes GDPR user erasure **impossible**, and nothing fails until Phase 26b |
| `deletedAt` NOT NULL with the sentinel, on all 7 soft-deletable tables | A nullable column makes the uniqueness constraint enforce nothing |
| A duplicate live key is rejected, and reusable after deletion | The behaviour the sentinel exists to produce, exercised rather than inferred |
| Every `*Minor` column is `BIGINT`, and no `DECIMAL` exists | ADR-013 held at design time; nothing kept it held |
| The three idempotency constraints | Without them a retried webhook is a second charge |
| Every table reaches a tenant, bar the five listed above | A new table could otherwise escape scoping unnoticed |

Verified by introducing the regression deliberately: flipping
`audit_logs.userId` to `RESTRICT` failed the suite, and restoring it passed.

---

## Seed and fixture shape

M5.10 requires two seeding paths, and their shape has consequences for this
design rather than being purely a Step 4 concern.

**`db:seed`** — idempotent, safe to re-run, required for the application to
function:

```text
plans          Free / Pro / Business with the real limits from M22.1
platform_staff one super_admin, from env — never a hardcoded credential
```

**`db:seed:demo`** — a realistic tenant for development and E2E:

```text
1 tenant · 1 connected store (mock) · 30 store_products
5 option_sets — 4 with a single radio option each, plus one draft
   carrying 40 options across 4 groups for builder performance
   (conditional rules deferred to Phase 17 — see ADR-018)
50 order_events, each with 2–4 order_selections
```

### Why the volume matters to the schema

Fifty orders with two to four selections each produces **100–200
`order_selections` rows**, which is what makes the analytics queries in Phase 25
meaningful instead of returning a single row. Those queries group by
`option_key` and sum `price_delta_minor` across a store's whole history, so
`order_selections` needs:

```sql
INDEX (order_event_id)                    -- the FK join
INDEX (option_key, value_key)             -- "most selected values"
```

Without realistic fixture volume the second index looks unnecessary — every
query is fast against three rows. It stops being fast at a merchant's real order
history, in front of a merchant.

The same argument applies to the ~40-option set: a builder that feels responsive
with four options is the reason M28.5 requires testing with a hundred.

**Seed data is never soft-deleted state.** A fixture with `deleted_at` set would
mean every developer's local database silently exercises a code path nothing
tested deliberately.

---

## Deferred, deliberately

| Table | Phase | Why |
|---|---|---|
| `uploaded_files` | 15 | Shape depends on the storage decision in M15.1 |
| `analytics_rollups` | 25 | Rollup shape follows the questions merchants actually ask |

Recorded so their absence is a decision, not an omission ([ADR-017](DECISIONS.md#adr-017--option_set_versions-belongs-to-phase-5)).
