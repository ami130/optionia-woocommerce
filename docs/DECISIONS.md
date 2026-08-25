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

---

## ADR-021 — Coverage is measured, or it is not a guarantee

**Status:** accepted
**Date:** Phase 5, audit

### Context

ADR-020 stated the rule this project keeps rediscovering: a guarantee verified
manually is a guarantee with no guard. It then failed to apply it to the tests
themselves.

An audit asking "what has branching logic and no test?" found three things:

- `bigint.transformer.ts` at **0%** — its `throw` on an unsafe integer has never
  executed, in a file used by four entities including `usage_records.value`, which
  Phase 24 bills against
- `super-admin.seed.ts` with **3 of 4 branches unreachable in CI** — including the
  12-character password minimum, on the account that can impersonate any merchant
- **no coverage threshold anywhere**, and coverage never measured in CI

The third explains the first two. `npm run check` reports success at 15.7%
statement coverage exactly as it would at 90%, so nothing ever said otherwise.

The claim that Phase 5 was verified was not false — 90 unit tests and 28 e2e
tests do pass, `money.transformer.ts` is at 100% and `env.ts` at 97.9%. It was
narrower than it sounded. "The tests pass" and "the code is tested" are different
statements, and only the first had evidence.

### Decision

Coverage is measured in CI with a floor that fails the build. The floor is set
from the current honest number rather than an aspiration, and raised as gaps
close — a threshold that fails on day one gets removed, not met.

Files are exempted explicitly and with a reason, never by being quietly absent.
Entities, migrations and module wiring are declaration rather than logic; a test
asserting a decorator's presence restates it.

### Consequences

The number will be low at first, and it should be — the alternative is the number
nobody knows, which is what this project had.

This is the fourth time the same failure has appeared: broken npm scripts, CI on
branches that did not exist, documentation drift, and now untested branches.
Each was found by asking what nothing checks. That question is worth asking at
the close of every phase, not only when something feels wrong.

### Update — two of the three gaps are closed

`bigint.transformer.ts` is at 100% (13 tests) and `super-admin.seed.ts` at 61.5%
statements with every guard covered — 8 unit tests for the two checks that run
before any database work, and 3 e2e tests for the creation path. The uncovered
remainder is the repository code those e2e tests exercise but Jest's unit run
does not instrument.

Both were mutation-tested rather than assumed: disabling the safe-integer check
fails 5 tests, and weakening the password minimum from 12 to 4 fails 3. A test
that has never failed is a test nobody knows works.

Overall coverage moved from 15.7% to 23.6% statements and 58.5% to 69.6%
branches.

**The threshold itself remains unbuilt, deliberately.** Setting a floor now would
encode 23.6% as the standard at the moment the number is least meaningful. It
belongs with the test strategy in Phase 30, where the exemption list — entities,
migrations, module wiring — can be argued rather than assumed. The risk of
waiting is real and is recorded here rather than left implicit: until that floor
exists, coverage can fall and nothing will say so.

---

## ADR-022 — Configuration is a plain function, not `ConfigModule`

**Status:** accepted
**Date:** Phase 6, close

### Context

`@nestjs/config` was installed early and never used. It survived two audits with
the note "decide in Phase 6, when JWT secrets and mail settings arrive" — and
Phase 6 arrived, added both, and closed without deciding.

That is exactly how the pino dependency survived Phase 3: a package nobody uses,
sitting in `package.json` reading as though it were part of the design.

### Decision

Configuration stays as `loadConfig()` in `src/config/env.ts`, and the package is
removed.

The difference that decides it is not style. `loadConfig()` **throws on a missing
variable and has no fallback defaults**; `ConfigModule` returns `undefined` and
leaves the default to each call site. That is the failure this project has already
been bitten by — `check-secrets.sh` has a dedicated rule against
`process.env.X || 'literal'` — and adopting a module whose ergonomics encourage it
would undo a guard we wrote deliberately.

Two further properties matter and are cheap to keep:

- **Boot fails, not the first request.** Every variable is read and validated once
  at startup, so a misconfiguration is a container that will not start rather than
  a 500 an hour later on an uncommon path.
- **The whole contract is one interface.** `AppConfig` is readable in one screen,
  and adding a variable without declaring it does not typecheck.

### Consequences

Nest's dependency injection does not supply configuration; modules call
`loadConfig()` directly. That is a real cost in one place — a test wanting a
different value sets `process.env` rather than overriding a provider — and
`env.spec.ts` already does exactly that, clearing the environment first so a stray
shell variable cannot make a failing case pass.

If configuration ever needs to differ per request or per tenant, this decision
should be revisited rather than worked around: `loadConfig()` is deliberately a
snapshot of the process environment and nothing more.

**Do not re-add the package without amending this record.** Its absence is the
decision.

---

## ADR-023 — Coverage is two numbers, and only one was ever measured

**Status:** accepted
**Date:** Phase 6, close
**Amends:** [ADR-021](#adr-021--coverage-is-measured-or-it-is-not-a-guarantee)

### Context

ADR-021 established that coverage must be measured rather than assumed, and
recorded 15.7% as the honest figure. It was honest about what it measured and
wrong about what that meant.

`jest --coverage` instruments the unit run. By the end of Phase 6, almost every
security control in the codebase — both guards, the tenant-scoped repository,
`auth.service`, `team.service`, `sessions.service` — had **no unit test by
design**. They are exercised against a real database, because the defects that
matter in them are invisible to a mock: a `= NULL` comparison that matches
nothing, a transaction deadlocking against its own connection, three
read-then-write races.

So the report showed them at 0% and the total at 28.95%, while 193 e2e tests
covered them.

**The failure mode is the interesting part.** A number that understates coverage
is not a harmless inaccuracy: it is untrusted, so it is unwatched, and an
unwatched metric is the same as an unmeasured one. ADR-021 was written to prevent
exactly that and then produced it.

### Decision

Coverage is reported for both runs, and neither is treated as the figure.

`npm run test:cov` covers the pure logic — transformers, the permission matrix,
config validation, crypto primitives. `npm run test:e2e:cov` covers everything
requiring a database, and reports **88.19%** statements, with `jwt-auth.guard`
and `audit.service` at 100%, `sessions.service` at 98%, and nothing in the auth
or tenancy layer below 92%.

### Consequences

The threshold question deferred to Phase 30 now has real numbers to set a floor
against, and it must set two — one per run — rather than one number that means
different things depending on which suite happens to grow.

The e2e config needed `rootDir` moved to the project root for its patterns to
resolve. The first attempt reported 0% with no files listed, which looked like
nothing being covered and was in fact nothing being *instrumented* — the same
shape as the doc checker that verified zero rules while reporting success.

---

## ADR-024 — Logout invalidates access tokens by timestamp, not a deny-list

**Status:** accepted
**Date:** Phase 6, close

### Context

Access tokens are stateless and short-lived, which is the whole point: no storage,
no lookup, no shared state on the hottest path in the system. The cost is that an
individual token cannot be revoked.

A probe measured what that left open. After logout the access token still
authenticated — **200 before, 200 after** — for the remainder of its lifetime. At
a 15-minute TTL that is fifteen minutes during which "I logged out" is not true,
and it is a support conversation nobody can win.

Two cases were already closed and it is worth being precise about which: removal
and demotion take effect immediately, because `TenantGuard` reads the membership
row on every request and the stored role overrides the token's copy. The gap was
logout and password reset only.

### Options

**A deny-list of revoked tokens.** Correct, and it costs a database read on every
authenticated request forever — reintroducing exactly the state the stateless
token exists to avoid, to fix a problem that occurs at logout.

**A shorter access TTL.** Cheap, and it only shrinks the window rather than
closing it. Five minutes is still five minutes, and it multiplies refresh traffic
by three.

**A per-user invalidation timestamp.** Closes it completely at **no extra
per-request cost**, because `TenantGuard` already performs a read that this rides
on.

### Decision

`users.sessions_invalidated_at`. `TenantGuard` rejects any token whose `iat`
precedes it, using the membership query it already runs. Logout and password reset
set it.

`iat` is in seconds and the column is millisecond-precision, so the comparison
rounds down: a token minted in the same second as the invalidation is rejected.
The asymmetry is deliberate — one unnecessary re-login against a session that
should have ended already.

### Consequences

Revocation is per user, not per session. Logging out of one device ends every
access token that user holds, while their other refresh families survive and mint
new ones on the next refresh. For a merchant dashboard that is closer to what
"log me out" means than the alternative; if per-device revocation is ever needed,
the timestamp moves onto the session family and this record should be amended
rather than worked around.

`TenantGuard` now reads two rows instead of one. Both are primary-key lookups on
indexed columns, and the alternative was a third read on every request rather than
a second on some.

Proven by mutation: neutralising the check fails the logout test.

---

## ADR-025 — Option types are registry entries, and money never reaches a float

**Status:** accepted
**Date:** Phase 7, M7.3

### Context

M7.3 asks for one option type — `radio` — and for a registry built so
[Phase 14](../../developePlan.md) is *registration, not refactoring*. Twelve types
are planned. If adding one means editing a validator, a serializer and a
controller, the twelfth costs the same as the second and the estimate for Phase 14
is wrong by an order of magnitude.

### Decision

An option type is one entry in `type-registry.ts` declaring what varies: its
presentation, its value kind and cardinality, whether it takes values, and three
Zod schemas. Nothing else in the system enumerates types.

**Entries key on `presentation`, not on a flat type name**, because the three-axis
model (M5.4b) already separates behaviour from rendering. `radio` and `dropdown`
are the same `choice`/`one` pair drawn differently; `checkbox` is that pair at a
different cardinality. The shared schemas are written once and registered
repeatedly, which is what makes Phase 14 additive.

**A choice type refuses type-level pricing.** A radio prices per value, so an
amount on the option would be charged *in addition* to the selected value's price
— silently doubling every priced option. The schema is `z.null()`: refusing is
clearer than accepting a field nothing reads.

### Money

Amounts are integers in minor units, and the schema **rejects a decimal rather
than truncating it**. `10.5` looks like £10.50 and means ten and a half pence, and
truncating charges the wrong amount for as long as the option exists. An error a
merchant can read is better than a silent 999 where they meant 999.5.

Percentages are basis points for the same reason: `0.1 + 0.2 !== 0.3` in binary
floating point, and a percentage that drifts produces different totals on two
machines.

Amounts are bounded at £10,000,000 rather than `MAX_SAFE_INTEGER`. A larger value
is a typo — minor units entered twice — and catching it at entry beats an order
total that overflows a payment provider's limit.

### Tier validation is about relationships

A tiered price is validated as a set, because the failures that matter are
between brackets rather than inside one: a gap leaves quantities unpriced, an
overlap makes the charge depend on evaluation order, and an open-ended tier that
is not last swallows every bracket after it. None is visible from a single tier,
and each is a wrong charge rather than a malformed document.

### Consequences

Every error names its field — `pricing.tiers.1.minQuantity` rather than "pricing
is invalid" — because MySQL accepts `{"amountMinor":"ten"}` as valid JSON and the
mistake otherwise surfaces at a customer's checkout.

Adding a type in Phase 14 is an entry plus a test that its schemas reject what
they should. The registry asserts its own size, so a second type appearing during
Phase 7 fails a test rather than passing as scope creep.

---

## ADR-026 — A malformed cursor is an error, not the first page

**Status:** accepted
**Date:** Phase 7, M7.1

### Context

`decodeCursor` returned `null` for anything it could not parse, and `null` was
also how "no cursor supplied" was represented. The two were indistinguishable, so
`?cursor=@@@` returned `200` with page one.

The original comment defended this: a cursor arrives in a URL a person may have
edited, and answering "invalid cursor" to someone who pasted a link is unhelpful.

That reasoning is sound for a link a human edits and wrong for this surface. The
contract already states the cursor is opaque and clients must not construct one,
so every caller is a machine that either echoes `meta.pagination.cursor` back or
has a bug. For that caller, a silent reset is the worst possible answer: a cursor
truncated in transit turns a paging loop into an infinite one that re-reads page
one forever and never terminates — with a `200` at every step.

### Decision

A cursor that is present and unparseable is rejected with `400 VALIDATION_FAILED`
and the detail `{ field: 'cursor', code: 'INVALID_CURSOR' }`. An *absent* cursor
still means the first page.

Validation is strict: the decoded value must be exactly `timestamp|uuid`, the
timestamp must round-trip through `toISOString()`, and the id must match the UUID
shape. `Buffer.from(x, 'base64url')` does not throw on invalid input — it silently
drops the offending characters — so a `try/catch` alone would have caught none of
the six cases now tested.

### Consequences

A client that mangles a cursor gets a loud, diagnosable failure rather than a
silent loop. The behaviour is documented in `API-CONTRACT.md` under Pagination,
and the test that previously asserted the old behaviour — "tolerates a broken
cursor" — was inverted rather than deleted, because it encoded the defect.

---

## ADR-027 — Audit provenance comes from the request context, never the caller

**Status:** accepted
**Date:** Phase 7, M7.6

### Context

M7.6 requires every mutation recorded with **actor, diff, and IP**. Two of the
three were being written: `AuditService` hardcoded `ip: null` and `userAgent:
null`, and the request context carried neither — so this was not a missed wiring
but a value that did not exist upstream.

Separately, each mutation recorded a differently shaped `changes` payload: a
create wrote `{name}`, an update wrote `{name: {from, to}}`, a delete wrote
something else. A trail in three shapes cannot be rendered, searched or exported
by one piece of code.

### Decision

The middleware captures `ip` and `userAgent` into the request context, and
`AuditService` reads them from there — **not** from `AuditEntry`. An actor must
not be able to declare their own origin, and a service reaching into an HTTP
request would tie the audit layer to a transport, which is the same reason
`tenantId` lives in the context.

`ip` is packed to the 16 bytes `VARBINARY(16)` stores, in IPv4-mapped form, so
`10.0.0.1` and `::ffff:10.0.0.1` — the same host on a dual-stack socket — compare
equal instead of reading as two visitors. An unparseable address stores `null`: a
gap is visibly missing, whereas a malformed value looks like evidence.

One `diff(before, after)` helper produces `{field: {from, to}}` for every
mutation, with a create diffing from `null` and a delete diffing to a removed
state. Unchanged fields are omitted.

### Consequences

`⚠️` An IP is personal data under GDPR, so `audit_logs` is subject to the Phase 26b
retention policy rather than kept indefinitely — already noted on the column.

Because `AuditService` swallows its own write failures by design (the recorded
action has already happened; failing it afterwards is worse), a spy on `record()`
cannot distinguish a successful write from one that threw and was logged. The 7e
audit tests therefore query `audit_logs` directly, and that is deliberate.

`trust proxy` is **not** set, so `req.ip` is the socket address. That is correct
and unspoofable today. The moment this runs behind a load balancer it must be
configured, or every audit row will record the balancer's address — and a
carelessly trusted `X-Forwarded-For` is worse than no IP at all.
