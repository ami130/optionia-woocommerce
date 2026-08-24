# Architecture Decision Record

Append-only. Every architectural decision gets an entry: the decision, the
alternatives considered, the reasoning, and the date. A decision without a
recorded reason gets re-litigated every few months.

Superseded entries are marked, never deleted — the reasoning behind a reversal
matters as much as the reversal.

---

## ADR-001 — This project is standalone

**Date:** 2026-08-24 · **Status:** Accepted

Optionia for WooCommerce shares a brand name with other directories under
`parselabllc/` but is a separate product. Nothing here reuses, imports from, or
depends on them.

**Reasoning.** Those repositories are a marketing site and a blog CMS. Their
`users` table and auth guards looked superficially reusable, but their domain,
scaling profile, and blast radius are unrelated. Coupling them would mean a CMS
deploy could take down merchant storefronts.

**Consequence.** New repositories, new database, new infrastructure. No shared
code. The competitive teardown, not a prior implementation, is the design input.

---

## ADR-002 — Everything is configuration-driven

**Date:** 2026-08-24 · **Status:** Accepted

No hardcoded option types, labels, prices, currency symbols, plan limits, or
product references. Behaviour comes from registries, config documents, and the
database.

**Reasoning.** A standing project requirement. The practical test: adding option
type #12 must touch three files, not thirty. If a renderer needs editing to add a
type, the abstraction has failed.

**Boundary.** Structural engineering constants stay in code — schema version,
timeouts, retry budgets, circuit-breaker thresholds. Those are internal safety
limits, not product content, and making them merchant-editable would let a
misconfiguration break storefronts.

---

## ADR-003 — Configuration throws rather than defaults

**Date:** 2026-08-24 · **Status:** Accepted

`src/config/env.ts` reads every environment variable at boot and throws on
anything missing or malformed. There are no fallback defaults for
environment-specific values.

**Alternatives.** `process.env.DB_HOST || 'localhost'` is the common pattern and
was rejected.

**Reasoning.** A sibling project shipped `password: configService.get('DB_PASSWORD')
|| 'AVNS_9X5...'` — a real production credential as a fallback default in
committed source. Two failures at once: the credential leaked, and any process
with incomplete configuration silently connected to production.

Failing loudly at boot is always cheaper than discovering the wrong database
later.

**Enforcement.** `bin/check-secrets.sh` fails the build on any env read carrying a
`||` or `??` literal fallback. Verified by planting the exact leak pattern and
confirming it is caught.

---

## ADR-004 — UUIDv7 primary keys for tenant-scoped entities

**Date:** 2026-08-24 · **Status:** Accepted

Tenant-scoped tables use `CHAR(36)` UUIDv7 primary keys. Platform-internal tables
with no external exposure may use `BIGINT AUTO_INCREMENT`.

**Alternatives.**

| Option | For | Against |
|---|---|---|
| `BIGINT AUTO_INCREMENT` | 8 bytes, fast joins, natural ordering | **Enumerable.** `/option-sets/5` invites probing at the tenant boundary |
| UUIDv4 | Non-enumerable | Random — index fragmentation on insert, no time ordering |
| **UUIDv7** | Non-enumerable, time-sortable, mergeable | 36 bytes as CHAR, marginally slower joins |

**Reasoning.** In a multi-tenant SaaS, sequential IDs are an invitation. Tenant
isolation is enforced at the data-access layer (AC5), so enumeration should not
succeed — but defence in depth means not publishing a map of what to try.

UUIDv7 keeps the time-ordering that UUIDv4 loses, so inserts stay
index-friendly and `ORDER BY id` remains meaningful.

**Consequence.** Effectively irreversible once merchant data exists. Accepted
deliberately, before any table was created.

---

## ADR-005 — Deferred decisions

**Date:** 2026-08-24 · **Status:** Open

Two Phase 1 decisions are deliberately unresolved because they need business
input rather than engineering judgement:

| Decision | Blocks | Needs |
|---|---|---|
| **D1 — billing provider** | Phase 22 | The operating company's incorporation jurisdiction and Stripe eligibility. Merchant-of-record (Paddle / Lemon Squeezy) removes tax work at a higher rate. |
| **D2/D3 — free tier and positioning** | Phase 22 pricing, Phase 33 recruiting | A written answer to *"why pay monthly when a competitor is a one-time $59?"* |

Neither blocks Phase 5. The schema keeps `subscriptions.provider` as a string and
plan limits as data, so either answer fits without migration.

**Not deferred quietly:** both must be resolved before Phase 22, and D3 before
beta merchants are recruited.

---

## ADR-006 — Competitive teardown deferred

**Date:** 2026-08-24 · **Status:** Accepted

M1.5 calls for installing and documenting four competing WooCommerce options
plugins. Deferred rather than run before Phase 5.

**Reasoning.** The teardown's purpose is design input for the option model. A
screenshot of a live competitor's option-set builder already supplied the highest
value part of that: a four-column taxonomy that revealed cardinality is an
**axis**, not a type — collapsing 16 picker entries into 8 builds — and that
presentational items are not options at all.

That single artifact changed the data model more than a plugin survey would.
Blocking the schema on installing four plugins would spend a day to confirm what
is already known.

**Revisit before Phase 14**, where type coverage and parity claims actually
matter.

---

## ADR-007 — Branch strategy: `main` and `develop`

**Date:** 2026-08-24 · **Status:** Accepted

All three repositories use `main` (release) and `develop` (integration), with
`feature/*` and `fix/*` branched from `develop`.

**Reasoning.** Git's default `master` was in place while the CI workflows
triggered on `main` and `develop`. The consequence was not a failing build but no
build at all — CI never fired, and a repository with no enforcement looks
identical to one that is passing.

The names were already specified in the plan's git strategy; the repositories had
simply never been aligned with it.

**Consequence.** Work happens on `develop`. `main` is fast-forwarded from
`develop` at a release point, so the two never diverge silently.

---

## ADR-008 — CI tests the supported version range, not one version

**Date:** 2026-08-24 · **Status:** Accepted

The backend tests Node 20 and 24. The plugin tests PHP 7.4 and 8.4.

**Reasoning.** Development ran Node 24 while CI pinned 20, and `package.json`
declared `>=20` — so nothing complained, and a Node 24 API used locally would
have failed only in CI. The same applies to the plugin: 7.4 is the floor in its
header, and merchants on shared hosting genuinely still run it.

Declaring support for a version and never testing it makes the support a claim
rather than a fact. Both matrices use `fail-fast: false` so one failure still
reports the other version.

**Revisit** when a floor is raised — dropping Node 20 or PHP 7.4 is a
compatibility decision with merchant impact, not a convenience.

---

## ADR-009 — Every response is wrapped in an envelope

**Date:** 2026-08-24 · **Status:** Accepted

Success and failure share one shape. Controllers return domain objects; a global
interceptor wraps them.

```jsonc
// success
{
  "data": { "id": "...", "name": "..." },
  "meta": { "requestId": "01J...", "timestamp": "2026-08-24T10:00:00.000Z" }
}

// success, paginated — meta carries the cursor, data stays a clean array
{
  "data": [ /* ... */ ],
  "meta": { "requestId": "...", "timestamp": "...",
            "pagination": { "cursor": "...", "hasMore": true, "limit": 50 } }
}

// failure — same envelope, `error` replaces `data`
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human-readable summary.",
    "details": [ { "field": "label", "code": "TOO_LONG", "params": { "max": 60 } } ]
  },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

**Alternatives.** Returning the resource directly (no wrapper) is simpler for
clients and was rejected.

**Reasoning.** The decisive factor is that one client **cannot be redeployed on
demand**. The WooCommerce plugin runs on merchant infrastructure we do not
control; a merchant may run a two-year-old version indefinitely. Adding a field
to a bare response body risks breaking a parser we cannot update.

An envelope gives a permanent place to add `meta` — pagination, deprecation
warnings, rate-limit state — without ever changing the shape of `data`. The cost
is that every client unwraps `.data` forever. That is a small, one-time cost paid
against an open-ended benefit.

`meta.requestId` appears on every response, including errors, so a merchant
support ticket can quote one value that ties their symptom to a server log line.

**Consequence.** No controller ever constructs a response shape. The plugin's
`Api\ResponseValidator` and the dashboard's API client both unwrap centrally.

---

## ADR-010 — Error codes are a public contract

**Date:** 2026-08-24 · **Status:** Accepted

`error.code` is `SCREAMING_SNAKE_CASE`, stable, and versioned with the API.
Messages are for humans and may change freely; codes are for machines and may
not.

**Taxonomy.** Codes are grouped by cause, and the group determines the HTTP
status:

| Group | HTTP | Examples |
|---|---|---|
| Validation | 400 | `VALIDATION_FAILED`, `MALFORMED_JSON` |
| Authentication | 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_INVALID` |
| Authorization | 403 | `FORBIDDEN`, `INSUFFICIENT_ROLE` |
| Not found | 404 | `NOT_FOUND` |
| Conflict | 409 | `CONFLICT`, `ALREADY_EXISTS`, `VERSION_MISMATCH` |
| Limits | 429 | `RATE_LIMITED`, `PLAN_LIMIT_EXCEEDED` |
| Server | 500 | `INTERNAL_ERROR` |
| Dependency | 503 | `SERVICE_UNAVAILABLE` |

**Two rules that are security decisions, not style:**

1. **A cross-tenant access attempt returns `NOT_FOUND`, never `FORBIDDEN`.**
   `FORBIDDEN` confirms the resource exists, which turns an authorization boundary
   into an enumeration oracle. From outside the tenant, the resource does not
   exist.

2. **`INTERNAL_ERROR` never carries detail.** Stack traces, SQL fragments and
   driver messages are logged with the `requestId` and never returned. A
   `QueryFailedError` reaching a client leaks schema.

**Field-level detail** lives in `error.details[]` as structured entries — `field`,
`code`, `params` — not as pre-formatted English. The dashboard needs to render
these next to form fields and translate them; a sentence cannot be localised
after the fact.

---

## ADR-011 — API versioning and deprecation

**Date:** 2026-08-24 · **Status:** Accepted

All routes are prefixed `/v1`. `/health` is deliberately unversioned — monitoring
should not have to track API versions.

**Deprecation policy.**

| | Commitment |
|---|---|
| Support window | N and N−1 supported concurrently. A version is never removed while a supported plugin release depends on it. |
| Notice period | **12 months minimum** before a version is switched off. |
| Signalling | A deprecated version returns `Deprecation` and `Sunset` headers (RFC 8594), and `meta.deprecation` in the envelope. ⏳ **Policy only** — the `DeprecationMeta` type exists; nothing emits it yet, because there is nothing deprecated. Implement with the first deprecation, not before. |
| Breaking change | Anything that removes a field, narrows a type, tightens validation, or changes an error code. Adding an optional field is not breaking. |

**Reasoning.** The window exists because of the plugin, not the dashboard. The
dashboard is deployed by us and always current. The plugin is installed on
merchant sites that may never update — WordPress plugins routinely run years
behind — so a version switched off is a merchant's storefront losing its options.

12 months is the shortest period that lets a merchant who checks their site
annually still see a warning before anything breaks.

**Related but separate:** the config document carries its own `schema_version`
(M7.5, M9.5), which lets an old plugin refuse a document it cannot parse rather
than rendering it wrongly. API version and config schema version move
independently.

---

## ADR-012 — What is configured but not yet proven

**Date:** 2026-08-24 · **Status:** Accepted

Some Step 1 behaviour is correctly configured and cannot be exercised until a
later milestone supplies something to exercise it against. Recorded here so it is
never mistaken for verified.

| Behaviour | State | Proven when |
|---|---|---|
| `ValidationPipe` rejects unknown fields | Configured — `whitelist`, `forbidNonWhitelisted`, `transform` set | Phase 6 adds the first DTO endpoint |
| `Deprecation` / `Sunset` headers | Type exists, nothing emits | The first deprecation |
| Per-tenant rate limiting | Deliberately absent | Phase 6, alongside `TenantGuard` |

**Reasoning.** `forbidNonWhitelisted` closes mass assignment as a class of bug —
a caller cannot smuggle `isAdmin` or `tenantId` into a DTO and hope something
binds it. But no endpoint currently accepts a body, so the rejection has never
fired. Claiming it verified would be claiming a test that does not exist.

**Action.** Phase 6's first DTO endpoint must include a negative test asserting
that an unknown field returns `VALIDATION_FAILED`, not a silent discard.

### Correction — this record was itself incomplete

The first version of this ADR listed three unproven behaviours and missed a
fourth: the exception filter's leak-prevention rule had fourteen branch points
and no unit test.

That is the rule stopping a `QueryFailedError` from putting table and column
names in a response body — a security control, and the one piece of Step 1 with
zero coverage. Runtime verification had exercised 404, 429 and malformed JSON,
all `HttpException` paths; the database-error path was never reached, because
triggering it requires a real database failure.

A document whose purpose is honest accounting, and which is itself incomplete, is
worse than no document: it invites trust it has not earned.

**Resolved.** Both files now have unit tests — 13 for the filter, 11 for the
interceptor — asserting among other things that a query, a table name and a
column name never appear in a serialised response.

**Rule going forward:** a file with branching logic gets a unit test in the same
commit that creates it. Runtime verification proves the paths taken, not the
paths guarded against, and security controls are guards.

---

## ADR-013 — Money is stored as `BIGINT` minor units, not `DECIMAL`

**Date:** 2026-08-24 · **Status:** Accepted · **Supersedes** the `DECIMAL(12,4)`
line in `developePlan.md`

Every money column is `BIGINT` holding integer minor units — cents for USD, yen
for JPY, fils for KWD. The currency's decimal count comes from the store's
WooCommerce settings, not from the column type.

**Alternative.** The plan specifies `DECIMAL(12,4)` in MySQL with integer minor
units in application code. Rejected.

**Reasoning.** Integer minor units are already the representation *everywhere
else*:

```text
plugin   Support\Money        int $minor          e.g. 1000
wire     config document      "amount": 1000
backend  common/money         number (integer)    1000
database DECIMAL(12,4)        10.0000             ← the only conversion
```

Storing decimals means converting at every read and write. Conversions are
exactly where rounding bugs live, and this is a pricing engine — a rounding bug
is a customer charged the wrong amount on a merchant's store.

`DECIMAL(12,4)` also encodes an assumption the product does not hold: four
decimal places suits currencies with two, and is wrong for JPY (zero) and
merely tolerable for KWD (three). `BIGINT` carries no scale, so the scale lives
in one place — the store's currency setting — rather than being implied by a
column type that cannot be changed per tenant.

`BIGINT` holds ±9.2 × 10¹⁸ minor units. At two decimal places that is ninety
quadrillion units of currency, which is not a limit any merchant reaches.

**Consequence.** A raw `SELECT` shows `1000` rather than `10.0000`, so anyone
reading the database directly must know the convention. Recorded in
`docs/DATABASE.md`, and every money column is named with a `_minor` suffix so
the unit is visible at the point of use.

**Enforcement.** `Support\Money` on the plugin side and `common/money` on the
backend share the fixture suite in M11.4, so a divergence in either
representation fails CI.

---

## ADR-014 — Soft delete applies to merchant content only

**Date:** 2026-08-24 · **Status:** Accepted

Merchant-authored content carries `deleted_at`. Operational and platform tables
hard-delete.

| Soft delete | Hard delete |
|---|---|
| `option_sets`, `option_groups`, `options`, `option_values`, `option_rules`, `presentational_items`, `option_set_assignments` | `webhook_deliveries`, `sync_jobs`, `audit_logs`, `usage_records`, `billing_events`, `store_products`, `tenant_invitations` |

**Reasoning.** The two categories fail differently. A merchant deleting an option
set at 9pm and wanting it back is a support request that should take one query.
A stale webhook-delivery row has no such value — it is a log line, and keeping
deleted ones forever makes the operations queue slower for no benefit.

`store_products` hard-deletes because it is a *mirror*, not a source of truth: a
product deleted in WooCommerce should vanish here, and reconciliation
(M19.3) rebuilds it if that was wrong.

**Unique constraints must include `deleted_at`, and `deleted_at` must never be
NULL.** Otherwise a merchant who deletes an option named `size` can never create
another named `size`, because the soft-deleted row still holds the key.

⚠️ **Correction.** The first version of this ADR specified
`UNIQUE (option_group_id, key, deleted_at)` with a nullable `deleted_at`, on the
reasoning that MySQL treats NULLs as distinct so only one live row could hold a
key. **That reasoning is backwards, and the constraint enforces nothing.**

Tested against MySQL 9.6:

```sql
CREATE TABLE t (k VARCHAR(10), deleted_at DATETIME(3) NULL, UNIQUE KEY (k, deleted_at));
INSERT INTO t VALUES ('size', NULL);   -- ok
INSERT INTO t VALUES ('size', NULL);   -- ALSO OK

SELECT COUNT(*) FROM t WHERE deleted_at IS NULL;   →  2
```

Because `NULL != NULL`, every live row is distinct from every other live row. The
index permits **unlimited live duplicates** — precisely the case it was meant to
prevent.

**The working form uses a sentinel instead of NULL:**

```sql
deleted_at DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000'
UNIQUE KEY (option_group_id, `key`, deleted_at)
```

Verified: a second live `size` returns
`Duplicate entry 'size-1970-01-01 00:00:00.000'`, and after soft-deleting the
first row the key can be reused.

**The cost, accepted knowingly.** TypeORM's `@DeleteDateColumn` writes NULL on
soft-delete, so the sentinel needs explicit handling — a custom base entity and a
`softDelete` that writes a timestamp rather than relying on the built-in.

Two alternatives were rejected:

| Option | Why not |
|---|---|
| Enforce uniqueness in application code | A race between two concurrent creates produces duplicates. A constraint the database holds beats one the application remembers |
| Generated column `is_live` | Clean, but adds a column and a MySQL 8+ dependency to solve what a default value solves |

**Reading rows:** "live" is `deleted_at = '1970-01-01'`, not `deleted_at IS NULL`.
Every query and index in `docs/DATABASE.md` reflects that.

**This conflicts with GDPR erasure, deliberately.** Phase 26b requires
*irreversible* deletion of personal data on request. Soft delete is the opposite.
They are reconciled by scope rather than by mechanism:

- **Soft delete** applies to *configuration* — an option's label, its price, its
  rules. None of that is personal data.
- **Hard erasure** applies to *customer* data — `order_selections` values, uploaded
  files. Those are erased in place, not flagged.

The rule: **if a column can contain something a customer typed, it is never soft
deleted.** A `deleted_at` on a row holding an engraving message would be a GDPR
failure wearing a compliance-shaped mask.

---

## ADR-015 — What belongs in a JSON column

**Date:** 2026-08-24 · **Status:** Accepted

JSON columns hold **per-type configuration whose shape varies by option type**.
Everything filtered, sorted, aggregated, or joined gets a real column.

| JSON | Real column |
|---|---|
| `options.validation` — min/max length for text, blackout dates for a date picker, allowed MIME types for a file | `options.type`, `options.is_required`, `options.sort_order` |
| `options.display` — swatch size, column count, help text placement | `option_values.price_amount_minor`, `price_type` |
| `option_rules.conditions` — an arbitrary condition tree | `option_rules.action`, `target_type`, `target_id` |
| `option_set_versions.snapshot` — an immutable published document | `option_sets.status`, `version`, `published_at` |

**Reasoning.** JSON buys schema flexibility and costs queryability. A `text`
option's validation has nothing in common with a `date` option's, so modelling
both as columns means a table of mostly-NULLs that grows a column per type — the
exact opposite of ADR-002's "adding a type touches three files".

But `price_amount_minor` inside a JSON blob makes *"which option values cost more
than $50?"* a full scan with JSON extraction, and pricing is the thing analytics
and plan limits both need to see.

**The test:** if a query would ever filter, sort, sum, or join on a value, it is
a column. If it is only ever read alongside its parent row and interpreted by the
type registry, it is JSON.

**Every JSON column has a versioned Zod schema** validating it at the API
boundary. A JSON column with no schema is an untyped bag, and MySQL will not
help — it validates syntax, not shape.

---

## ADR-016 — `option_key` outlives its option, by design

**Date:** 2026-08-24 · **Status:** Accepted

`order_selections` stores `option_key`, `option_label`, `value_key`,
`value_label` and `price_delta_minor` as **denormalized values with no foreign
key** to `options` or `option_values`.

**Reasoning.** Phase 4 proved the failure this prevents. An option was deleted
from configuration while it sat in a customer's cart, and checkout completed:

```text
Order #32   HTTP 200   status: processing
Total:      $100.00
Line meta:  "Finish: Luxury"      ← the option no longer existed
```

An order is a historical fact. What the customer selected, what they were shown,
and what they were charged do not change because a merchant later renamed or
deleted the option. A foreign key would either block the deletion or cascade the
order record away — both wrong.

Labels are snapshotted for the same reason: a merchant renaming "Luxury" to
"Premium" must not rewrite what a past customer saw on their receipt.

**Consequence.** `order_selections` cannot be joined to current configuration to
answer *"is this option still valid?"* — which is correct, because the answer is
irrelevant to a completed order. Live validation happens at checkout
(M12.4), against the config document, before the order exists.

**Corollary for reorder.** Phase 4 also proved reorder reads selections from
order meta rather than `$_POST`. Because those keys are denormalized, a reorder
referencing a deleted option must be re-validated against current config, not
trusted from the stored row. See M12.8.

---

## ADR-017 — `option_set_versions` belongs to Phase 5

**Date:** 2026-08-24 · **Status:** Accepted

The table is created in Phase 5 with the rest of the schema, though nothing
writes to it until M7.4.

**Reasoning.** The plan specifies it inside Phase 7, which would mean a schema
migration the moment publish-and-rollback is built. Adding a table to a live
database is not difficult, but the Phase 5 exit criteria require every migration
to run forward and revert cleanly — and that verification is cheaper done once,
against an empty database, than later against merchant data.

**Two tables remain deliberately deferred:**

| Table | Phase | Why deferred |
|---|---|---|
| `uploaded_files` | 15 | Its shape depends on the storage decision in M15.1, which is not yet made. Designing it now would guess. |
| `analytics_rollups` | 25 | Rollup shape follows the questions merchants actually ask. Designing it before beta means designing the wrong aggregate. |

Both are recorded here so their absence is a decision rather than an omission.

---

## ADR-018 — Demo fixtures seed the shape, not unbuilt semantics

**Date:** 2026-08-24 · **Status:** Accepted

`db:seed:demo` creates option sets using **one option type — `radio`** — rather
than the "4 option sets covering every shipped option type" M5.10 asks for.

**Reasoning.** Zero option types have shipped. The type registry is Phase 7
(radio) and Phase 14 (the rest); `presentation` is currently a `VARCHAR` with no
validator, renderer or pricing behaviour behind it.

A fixture asserting `presentation: 'date_picker'` before a date picker exists is
a claim the code cannot honour — the same failure as a script pointing at a file
that does not exist, or a dependency installed and never wired. Both happened
earlier in this project, and both were caught only by an audit.

**What is seeded instead:** 30 products, 4 option sets across 14 values, and 50
orders producing **147 order selections**. That volume is the part with real
value and no dependency on unbuilt code — it is what makes Phase 25's analytics
meaningful rather than returning a single row.

Verified with a live query: `GROUP BY optionKey, valueKey` uses a **covering
index scan** on `ix_order_selections_analytics`, so the index earns its place
against real data rather than looking speculative against three hand-typed rows.

**Phase 14 extends this fixture** as each option type becomes real, adding the
seven artifacts that make a type genuinely shipped.

### Correction — this record was itself incomplete

The first version of this ADR documented the option-type deferral and silently
omitted two further items from the same paragraph of `docs/DATABASE.md`:

> *"4 option_sets covering every shipped option type, **including one with a
> cascading rule and one with ~40 options**"*

Neither existed. `option_rules` held zero rows and the largest option group held
one option.

The 40-option set mattered most, and the reasoning against omitting it was
already written in that same document: *"a builder that feels responsive with
four options is the reason M28.5 requires testing with a hundred."* Without it,
the first person to notice the builder crawling is a merchant with a real
made-to-order product.

**Resolved.** A fifth option set — "Made-to-Order Configuration (large)" — now
carries 40 options across 4 accordion groups, kept as a draft and assigned to no
product, because its purpose is to load the builder rather than render on a
storefront. Asserted in `test/seeds.e2e-spec.ts`.

**Conditional rules remain deferred, now with a stated reason.** The rule engine
is Phase 17, so a seeded condition tree could not be validated, evaluated, or
shown to be cycle-free — it would be JSON nobody can prove is meaningful, which
is the same failure as seeding an option type that does not exist. Phase 17 adds
them alongside the evaluator that gives them meaning.

This is the second ADR in this project whose purpose was honest accounting and
which was itself incomplete (see ADR-012). Both were caught by an audit rather
than by writing them, which suggests the record needs checking against its source
document rather than against memory.

---

## ADR-019 — Plan limits are seeded provisionally

**Date:** 2026-08-24 · **Status:** Open

`db:seed` creates Free, Pro and Business with concrete limits, marked
provisional in the seed source.

**Alternatives.** Seeding `null` limits was rejected: Phase 24 builds limit
enforcement, and enforcement needs limits to enforce. Null would short-circuit
every check, so those code paths would never run and their tests would prove
nothing — deferring a decision by disabling a feature.

Deciding D2 now was also rejected. The free-tier shape depends on the competitive
teardown and on what beta merchants actually balk at, neither of which has
happened. A guess recorded as a decision is worse than a placeholder that says it
is one.

**Why deferring is cheap.** `plans.limits` is a JSON column and
`subscriptions.provider` is a plain string, both chosen so either answer fits
without a migration. Changing these is an `UPDATE`.

**Required before Phase 22.** Reconcile these numbers against the live pricing
page, which currently advertises "All Option Types (30+)" and "Edit Options in
Cart" — neither in MVP scope (M1.6). The risk is not that the numbers are
provisional; it is that they quietly become real without anyone checking them
against what is being sold.

---

## ADR-020 — Documentation that states a guarantee is checked mechanically

**Status:** accepted
**Date:** Phase 5, Step 5

### Context

`docs/DATABASE.md` drifted from the schema twice in a single phase. It promised a
fixture with a cascading rule and one with roughly forty options; for a while
`option_rules` held zero rows and the largest option group held one option. Both
times the gap was found by a person reading the document and comparing it against
the database by hand.

That is the slowest and least reliable detector available, and it only works when
someone happens to look. The document is not decoration: its delete-rule table is
the reference someone consults when asking whether GDPR erasure is possible. A
wrong answer there is acted upon.

### Decision

Where documentation states something a query can verify, a check verifies it.
`bin/check-docs.sh` compares the documented tables against the tables migrations
create, and every `ON DELETE` rule the document asserts against
`information_schema`. It runs in CI after `migration:run`, because it needs a
migrated database to compare against.

It deliberately does not check prose. A document can pass this and still explain
a column badly; the goal is narrower — it cannot silently describe a schema that
no longer exists.

Two properties matter more than the check itself:

**It fails when it stops covering anything.** If a foreign key exists with no
stated rule in the document, the check fails rather than quietly verifying the
remainder. The first version of this check reported `All doc checks passed` while
comparing **zero** rules: the document writes columns in `snake_case` and the
schema uses `camelCase`, so every comparison fell through a `continue` that was
meant to skip prose. A green check that inspects nothing is worse than no check,
because it stops anyone from looking.

**It was proven against real regressions.** Three were introduced deliberately: a
rule changed from RESTRICT to CASCADE in the document, a table documented that no
migration creates, and a rule line deleted. Each was caught, and the third — the
coverage floor — is the one that would have hidden the original defect.

### Consequences

Adding a table or a foreign key now requires updating `docs/DATABASE.md` in the
same commit, or CI fails. That is the intended cost: the alternative is a document
that is trusted and wrong.

The `camelCase`/`snake_case` normalisation is a known fragility. It is acceptable
only because the coverage floor makes silent failure loud — if normalisation ever
breaks, the count drops and the check fails rather than passing vacuously.

This generalises a pattern the phase arrived at three times over: `check-secrets.sh`,
`check-scripts.sh`, and the seed tests all exist because something was verified
once by hand and had no guard afterwards. The rule now stated plainly: **a
guarantee verified manually is a guarantee with no guard.**
