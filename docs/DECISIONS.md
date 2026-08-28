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

---

## ADR-028 — Isolation probes build their own fixtures

**Status:** accepted
**Date:** Phase 7, M7.2

### Context

The 7f suite has fifteen tenant-isolation probes, one per group/option/value
route, each asserting that tenant A gets a 404 for tenant B's row. All fifteen
passed.

They were then mutation-tested by removing the tenant predicate from
`ParentScopedRepository.scoped()` — the single line that makes cross-tenant reads
impossible. **Only four probes failed.** Eleven kept passing against a query with
no tenant filter at all, which the generated SQL confirmed.

The cause was shared fixtures. All fifteen probes used one group, option and
value created in `beforeAll`. With scoping broken the third probe —
`DELETE /groups/:id` — *succeeded* and soft-deleted the shared group. Every later
probe then met a genuinely deleted parent and got its 404 from the soft-delete
filter rather than from tenant scoping.

The suite was green, thorough-looking, and blind to the exact defect it existed
to catch.

### Decision

Every isolation probe creates its own tenant-B fixtures. The cost is one extra
set per probe and a slower suite; the benefit is that a probe's result depends on
the guarantee it names and on nothing another probe did first.

More generally: **a test whose subject can be mutated by an earlier test in the
same suite is not testing that subject.** This applies wherever a fixture is
shared across cases that mutate it, not only to isolation.

### Consequences

Re-running the same mutation now fails **sixteen** tests rather than four. The
guarantee is measured rather than assumed.

This is the same failure this project has hit repeatedly — a check that reports
success while inspecting nothing (ADR-020, ADR-021) — arriving in test fixtures
rather than in a script. The standing response holds: prove the check fails when
the thing it checks is broken, and treat a passing suite as evidence only after
that.

---

## ADR-029 — Invariants that span rows are written in one statement

**Status:** accepted
**Date:** Phase 7, M7.2

### Context

Three defects found by concurrent probes of 7f shared one shape: a rule read the
current state, decided, and then wrote — and the window between the read and the
write was where the rule failed.

The worst was `isDefault`. At most one value per option may be the default, so a
create with `isDefault` cleared its siblings. Four concurrent creates each read a
sibling list that did not yet contain the others' rows, then cleared everything
they *could* see. The result was an option with **zero** defaults — worse than
the two the rule exists to prevent, and invisible to every sequential test:
serially the same code gives exactly one, verified before and after.

The second was `key` uniqueness. `keyExists()` then insert is the same shape; the
database constraint closed the window correctly, but the loser's raw
`QueryFailedError` reached the exception filter and became a **500** for the same
collision that returns a clean 400 serially.

### Decision

**An invariant over more than one row is expressed as a single statement.**

`makeSoleDefault` is one `UPDATE … SET isDefault = CASE WHEN id = :keep …
WHERE optionId = :option`. Whichever transaction commits last has cleared every
row the others inserted, so the invariant holds no matter how the writes
interleave.

For uniqueness, the constraint stays the guarantee and the pre-check stays as the
common-case error. `asUniqueViolation` recognises `ER_DUP_ENTRY` and maps it to
`409 CONFLICT` with a `DUPLICATE_KEY` detail — a distinct code from the serial
`400`, because a race loser may retry and a genuine collision may not.

Only the *index name* is read from the driver error, to name the field. The
message itself is still discarded: it quotes the colliding value, which may be
user data, and ADR-009's rule that a database error never leaks detail holds.

### Consequences

Structural ceilings were added at the same time (100 groups per set, 200 options
per group, 500 values per option). They are not plan quotas — they bound an
unpaginated list endpoint and a subtree copied inside one transaction, both of
which had assumed a limit that nothing enforced.

Reverting either fix now fails two tests each; the ceilings fail one. The
sequential suite passed throughout all three defects, which is the point:
**a serial test cannot observe a read-then-write race, so any rule spanning rows
needs a concurrent probe before it is believed.**

---

## ADR-030 — Hard delete is a separate path, guarded by order history

**Status:** accepted
**Date:** Phase 7, M7.2

### Context

M7.2 permits hard delete "only when no order ever referenced it". The contract
sketched it as `DELETE /option-sets/:id?hard=true`.

Two problems with that shape. A query parameter turns a reversible action into an
irreversible one, so a single typo erases a merchant's work — and in an access
log, the safe and the catastrophic request are the same line, which is the one
place anyone looks afterwards.

The precondition is also harder than it appears. `order_selections` stores
`option_key` denormalized with **no foreign key** (ADR-016), precisely so an
order survives its option being deleted: an order is a historical fact. The
consequence is that nothing in the schema stops a permanent delete from leaving
an order line naming an option that no longer exists — "Finish: Luxury" with
nothing behind it, which is the Phase 4 failure seen from the other end.

### Decision

`DELETE /option-sets/:id/permanent`, a distinct path. Same capability, because
the authority is the same; different path, because the consequence is.

The check matches `option_key` **within the store**, and includes options that
are already soft-deleted — otherwise a two-step delete would erase what a
one-step delete refuses. It is deliberately conservative: a key repeated across
two of a merchant's sets blocks both. Refusing a delete that might have been safe
is recoverable; permitting one that destroys the meaning of an order is not.

Purge reads through `findByIdIncludingDeleted`, because delete-then-erase is the
normal path and a purge that only reached live sets would make discarded ones
unreachable forever.

### Consequences

Cascade rules are enforced in `CascadeService` rather than inside the three CRUD
services, so each of the four shapes — cascade down, cascade *and* flag sideways,
refuse outright — is tested as itself. Each is mutation-proven: disabling any one
fails between one and four tests.

**A mutation escaped and taught something.** Flipping `withDeleted` on the purge
query changed nothing, and the reason was not a missing test: `deletedAt` is a
plain sentinel column, not TypeORM's `@DeleteDateColumn`, so `withDeleted` is a
**no-op in this codebase** — a flag that reads as a safeguard and does nothing.
`parent-scoped.repository.ts` already said so. It was removed and replaced with a
comment stating why no predicate is needed, and the real guarantee — that the
purge query filters on no `deletedAt` at all — is now proven by mutating in a
live-only filter, which fails four tests.

---

## ADR-031 — A delete and its cascade are one transaction

**Status:** accepted
**Date:** Phase 7, M7.2

### Context

7g's first implementation ran the cascade in its own transaction and then
deleted the parent in a separate statement. A failure between the two would
leave every child soft-deleted and the parent live — a set whose contents
vanished with no error anywhere, which is exactly the partial cascade M7.2
forbids. The cascade's own comment said so about its children while leaving its
own boundary split.

Two related defects came from the same seam:

- Three concurrent deletes of one set all succeeded and wrote **three**
  `option_set.deleted` audit entries for one deletion.
- A create racing its parent's deletion left a **live child under a deleted
  parent** in five attempts out of six — invisible to every read, because the
  join chain hides it, and still real rows.

### Decision

Each cascade method marks the parent **inside its own transaction**, so one
commit covers parent and children. `rowVersion` advances there too, for the same
reason it advances on any other mutation.

The parent's transition is claimed conditionally
(`UPDATE … WHERE deletedAt = LIVE_SENTINEL`). Exactly one of several concurrent
deletes updates a row; the losers raise `AlreadyDeletedError`, which the service
translates to a plain success **without** an audit entry. Every caller's intent
was satisfied, so every caller sees success — but the trail records one deletion,
because that is what happened.

`create` verifies the parent and inserts inside one transaction.

**Locking the parent was built and then removed.** `SELECT … FOR UPDATE` closes
the orphan window completely, and it makes a create and a delete of the same
subtree take locks in opposite orders — the delete locks children then the
parent, the create locks the parent then inserts a child. Ordinary concurrent
authoring deadlocked, and sequential creates began returning intermittent 404s.

Trading a rare orphan that **no read can reach** for routine user-visible
failures is the wrong way round, so the lock is gone and the residual race is
stated rather than hidden: a child created during its parent's deletion can
survive as an unreachable row. The tests assert that consequence — it never
appears in a list or a fetch, and a purge still erases it — instead of asserting
an absence that is not true.

`7j`'s optimistic locking is where the definitive answer belongs: it can refuse
a stale write without holding a row lock across a request.

### Consequences

`isTransientLockConflict` maps `ER_LOCK_DEADLOCK` and `ER_LOCK_WAIT_TIMEOUT` to
`409 CONFLICT` with a retry-shaped message, following the precedent set for the
last-owner check. It was added for the deadlocks the lock caused and kept after
its removal: any two transactions touching the same rows can still collide, and
a rolled-back transaction is transient rather than an outage.

`presentational_items` were missing from the cascade entirely — they carry no
value, no pricing and no reader yet, and 7h's serializer would have been the
first thing to surface headings belonging to a group nobody can see. They are now
cascaded and purged explicitly rather than left to `ON DELETE CASCADE`, so the
count returned to a merchant is complete.

**One mutation escaped and was worth chasing.** Reverting the repository's parent
check to a plain `Error` failed nothing, because the service checks the parent
first and answers 404 — the repository's throw is reached only in the race no
deterministic test can stage. It is now asserted by calling the repository
directly, which is the only honest way to cover a path HTTP cannot reach.

---

## ADR-032 — The published projection is a type, not a convention

**Status:** accepted
**Date:** Phase 7, M7.2b

### Context

M7.2b asks for one serializer and two projections, with an acceptance that is
really a process requirement: *"adding a field to the model requires an explicit
decision about whether it appears in the published projection."*

A convention cannot deliver that. Documenting "remember to check the config
document" means the check happens when someone remembers, and the failure mode is
silent — a new column flows into a document that sits on merchant servers, and
nobody notices because nothing breaks.

Before this step, controllers returned entities directly. `tenantId` and the
soft-delete sentinel were already reaching API clients: not a cross-tenant leak,
since a caller only ever sees their own rows, but data the API had never decided
to publish.

### Decision

Each projection is an explicit `interface`, and the serializer maps **every field
by name**. Nothing spreads an entity.

The consequence is the acceptance: adding a column to an entity does not appear
in either projection until someone writes it there, and writing it into the
published shape without adding it to `PublishedOption` (or its siblings) **fails
to compile**. Verified by mutation — adding `tenantId` to the authoring
projection is a type error, not a failing test.

Two shapes, two conventions: authoring is `camelCase` for a TypeScript
dashboard, published is `snake_case` for a PHP plugin whose reader already
ships. The published shape drops `tenantId`, `rowVersion`, audit timestamps,
parent ids and `isEnabled`.

**Disabled things are dropped, not flagged.** A flag makes every consumer —
renderer, evaluator, TS and PHP — responsible for remembering to check it. One
of them will forget, and the failure is an option appearing on a storefront the
merchant switched off.

**One price shape.** The table stores both a `price_type`/`price_amount_minor`
pair and a nullable `price_config` JSON; the document carries only
`price_config`, because two ways to express a price is two ways for the TS and
PHP evaluators to disagree — the thing M11.4's shared fixtures exist to prevent.

### Consequences

`OptionSetTreeLoader` reads a set in four queries rather than four levels of
N+1: a set with 10 groups of 10 options of 5 values is 111 round trips per
render otherwise, on every editor load and every publish.

The tie-break on `id` makes ordering deterministic when two rows share a
`sort_order`. Asserting it on *returned rows* cannot fail — removing the clause
changes the SQL but not the result, because InnoDB returns these rows in
primary-key order anyway, which is a query plan rather than a contract. So the
clause is a single exported constant (`CHILD_ORDER`) used by all four child
queries, and the test asserts **the clause**, which can fail. A second test
asserts no query orders by anything else, because a tie-break on three levels
and not the fourth is drift nobody notices until a diff is wrong.

### Correction — one price shape meant one *spelling*

The first implementation passed a stored `price_config` through unchanged and
built `{ type, amount_minor }` from the columns when it was null. Both are
"one shape" in structure and **two spellings in practice**: the stored JSON is
`camelCase`, because its Zod schema is TypeScript, so the same document carried
`amountMinor` for a value priced one way and `amount_minor` for one priced the
other. A PHP evaluator reading `price_config['amount_minor']` would get `null`
for half its values — precisely the disagreement the decision existed to prevent.

`toPublishedPriceConfig` converts per pricing type. Explicitly, not with a
camelCase-to-snake_case walker: a walker would rename keys inside merchant JSON
and would convert whatever a future pricing type adds without anyone deciding.
An unrecognised type passes through untouched, because the validator refuses
unknown types at the boundary — a stored one means the registry grew and this did
not, and visibly wrong beats silently unpriced.

### Correction — the envelope is complete from v1

`assignments` and `rules` were absent because Phase 13 and Phase 17 build them.
But 7k freezes this document, and a plugin written against a shape without those
keys would need a `schema_version` bump to gain them. They are emitted as empty
arrays instead: a shape the plugin's first release already handles.

---

## ADR-033 — Publish writes history; rollback adds to it

**Status:** accepted
**Date:** Phase 7, M7.4

### Context

Publishing does five things at once: validate the set, increment `version`,
stamp `published_at` / `published_by`, write an immutable snapshot, and bump the
store's `config_version`. The plugin polls that last number to decide whether to
re-fetch, so a failure between any two steps can leave a storefront asking for a
document that was never written.

### Decision

**One transaction**, with the set's row locked. M7.4b requires that two
simultaneous publishes do not interleave and that the second sees the first's
version. The `uq_option_set_versions (option_set_id, version)` constraint is the
backstop, not the mechanism — a design that relied on it would answer the second
publisher with a `409` for a publish that should simply have waited.

That distinction was invisible until it was measured: removing the lock left the
suite green, because the test asserted only "no version was reused" — true of
both. With the lock, three concurrent publishes return `[201, 201, 201]` and
versions `1, 2, 3`; without it, two return `409`. The test now asserts the
former, so the lock is load-bearing.

**Serialization happens outside the transaction.** Reading the tree is the
expensive part, and holding a row lock across it would make two merchants
publishing different sets on one store wait for each other.

**Rollback publishes a prior snapshot as a new version.** Rolling 8 back to 5
produces 9 whose content matches 5. Rewriting would make the trail a lie, and the
merchant who needs rollback at 9pm is exactly the one who will later need to know
what happened.

**Rollback does not restore the live rows.** It changes what storefronts receive,
not what the editor shows. A rollback that silently overwrote the working draft
would destroy the edits a merchant was making when they hit the problem they are
rolling back from.

### Consequences

`version` counts **publishes**, so a new set starts at `0`. It was created at `1`,
which made the first publish produce version 2 and left a never-published set
claiming a version no snapshot existed for. The entity's own default was already
`0` and its comment already said "incremented on publish"; the create disagreed
with both.

Pre-publish checks are a **registered list**, not a switch. Three of M7.4's five
run today: *"required options hidden by their own rule"* needs rule evaluation
(M17.3), and *"pricing referencing a removed value"* has no subject, because no
pricing schema in the registry names a value id. Both arrive by appending to
`PUBLISH_VALIDATORS` — proven by a test that appends a stand-in for M17.3's cycle
detection and sees it block a publish, so the extension point is demonstrated
rather than asserted.

Blockers refuse; warnings publish and are returned in the response. A set with no
product assignment warns rather than blocks, because build-publish-assign is a
natural order of work and blocking would make it an error.

---

## ADR-033 — The optimistic lock is a predicate, and a pre-flight check

**Status:** accepted
**Date:** Phase 7, M7.4b

### Context

`rowVersion` has advanced on every mutation since 7e, and the DTO has accepted a
client's `rowVersion` since then too — and **ignored it**. The column existed,
the error code existed, the plumbing existed; nothing compared them.

M7.4b's acceptance is behavioural: two concurrent editors both save, the second
gets a 409 with a usable choice, and no write is silently lost.

### Decision

The check is a **predicate on the write** — `UPDATE … WHERE rowVersion = ?` — so
the database decides. Read-compare-write leaves a window in which another editor
commits between the read and the comparison, and the comparison then passes on a
value that is already stale.

A **pre-flight comparison also runs**, for two cases a predicate cannot reach:

- A save that turns out to change nothing never reaches a write. A stale client
  saving an unchanged name must still be refused — otherwise it believes it is
  current, and its *next* save, on a value that does differ, is the silent
  overwrite this exists to prevent.
- Publish serializes a whole tree before writing. Reporting the conflict first
  means the answer is prompt and specific rather than arriving after the
  expensive work.

The 409 carries the current version in `details`. A conflict that only says
"you are stale" leaves a dashboard with an error toast; with the server's version
it can fetch what changed and offer a real choice.

`rowVersion` stays **optional**. Omitting it means "I have not loaded a version",
which scripts and background jobs legitimately have not. Requiring it would break
every non-dashboard caller to guard against a failure only editors have.

### Consequences

Delete carries its version as a **query parameter**: `DELETE` bodies are legal
but dropped by some proxies and refused by some clients. A stale delete matters
more than a stale rename, not less — it discards a colleague's work along with
the set, and the cascade takes every group, option and value with it.

**Two mutations escaped the first test pass, and both were real gaps.** Removing
the write predicate failed nothing, because a single concurrent pair can be
serialized by chance — the test now runs eight attempts and asserts the version
advanced *exactly once*. Moving the pre-flight check after the no-op guard also
failed nothing, because the test's "unchanged" save differed from the current
name and so reached the write path anyway; it now changes the set's version via a
child edit while leaving the name alone, which is the only shape that exercises
that branch.

### Addendum — rollback was the one write without a lock

A combined audit of 7i and 7j found `RollbackDto` had no `rowVersion`, so sending
one was rejected as an unknown field. Every other write on an option set carried
the lock; rollback did not — and it is the most consequential of them, because it
changes what every storefront receives and the merchant chooses from a history
list that may have moved while it was on screen.

Two things were confirmed in the same audit rather than assumed. Five concurrent
publishes, three times over, produced version numbers `[1,2,3,4,5]` — unique and
contiguous every time, with `option_sets.version` matching the highest snapshot.
M7.4b's "the second waits and then sees the first's version" is measured. And a
published snapshot is byte-identical to `/preview` apart from its version stamp,
so what a merchant reviews is what a storefront receives.

Publish now records **which** warnings it proceeded through, by code, not how many.
A count answers "were there any?"; support is asked "did anyone know this set was
assigned to nothing when it went live?", and only the codes answer that.

---

## ADR-034 — The config contract is verified against the code that produces it

**Status:** accepted
**Date:** Phase 7, M7.5

### Context

M7.5 calls the config document "the single most important interface in the
system" and asks for `docs/CONFIG-CONTRACT.md` as the reference for both
implementations — the TypeScript that produces it and the PHP that consumes it.

Every other contract in this repository can be revised by deploying. This one is
read by a plugin installed on merchant servers that cannot be redeployed on
demand, so a change the shipped plugin does not understand takes storefronts
down.

The step also revealed a gap: the serializer produced the per-set shape, and
**nothing built the outer envelope** — `schema_version`, `config_version`,
`store_id`, `generated_at`. Writing a contract for a shape no code produces
would document an aspiration.

### Decision

`ConfigDocumentBuilder` assembles the document from **published snapshots, never
live rows**. The live rows are the merchant's working draft; a document built
from them would ship every edit as it was typed, making M7.4's "an edit does not
immediately reach storefronts" false.

`CONFIG_SCHEMA_VERSION` is frozen at 1, matching the shipped plugin's
`SUPPORTED_SCHEMA_VERSION`. The contract states which changes bump it — removing
or renaming a key, changing a type or a meaning — and which do not. Additive
changes do not, which is why the envelope already carries `assignments` and
`rules` as empty arrays while Phase 13 and Phase 17 remain unbuilt: a plugin
written against v1 handles them from its first release.

**The contract is tested against the code.** The suite reads
`CONFIG-CONTRACT.md` and asserts that every envelope field the builder emits is
documented, that every pricing type the registry can produce appears, and that
the version-bump rule is stated. A contract nobody checks drifts, and the drift
is discovered by a storefront.

### Consequences

Adding an undocumented field to the envelope is a **compile error**, not a
failing test: `ConfigDocument` is an explicit interface, so the field must be
declared before it can be emitted, and the declaration is what the contract
describes.

**One mutation escaped and exposed dead-looking code.** Removing the
`status = published` filter broke nothing, because an unpublished set has no
snapshot at version 0 and the snapshot lookup drops it anyway. The filter earns
its place only for a set that *was* published and is no longer — a state M7.4's
model includes via `unpublish`, which is not yet built. Rather than delete a
guard the state model requires, the test now reaches that state directly, so
removing the filter fails two tests instead of none.

A published set whose snapshot is missing is skipped rather than fatal. That
cannot arise — publish writes both in one transaction — but one corrupted set
must not take a whole storefront's configuration down with it.

### Addendum — two claims that outran their enforcement

An audit of 7k found both.

`build()` looked the store up **by id alone**, and a comment said this was safe
because "the store id is resolved from the authenticated token". No such
mechanism exists: the request context carries a `store` realm but no store id. A
probe confirmed one tenant could assemble another's entire published config. The
predicate now lives in the query — narrowed by tenant when a tenant is present,
unnarrowed for a store token, which legitimately has none because the token
already resolved the store.

Snapshots are immutable and **outlive the code that wrote them**. One written
before `assignments` and `rules` joined the envelope carries neither key, and the
builder shipped it verbatim — producing a document that contradicted the contract
declaring both always present, on which a PHP reader would warn. Rewriting old
snapshots was rejected: they are the record of what was actually published, and
editing them makes history a lie for the same reason rollback does not rewrite
it. They are normalised **on read** instead, filling only keys the contract makes
mandatory and never altering content, which is what makes "additive changes do
not bump `schema_version`" true rather than aspirational.

Both were caught by probing behaviour rather than by reading the code, and both
had passed every existing test.

---

## ADR-035 — The audit trail is readable, and the flakiness was ours

**Status:** accepted
**Date:** Phase 7, M7.6

### Context

M7.6 asks for *"every option-set mutation recorded with actor, diff, IP"*. That
recording was built incrementally across 7e–7k rather than deferred, on the
plan's own advice — discovering it at 7l would have meant rewriting six services.

Verification confirmed it: all twenty audit actions the domain defines fire when
the nineteen mutating routes are driven, and every row carries an actor, a
packed IP and a non-empty diff.

**The trail was write-only.** `AuditService` exposed only `record()`.
`AUDIT_LOG_VIEW` existed in the permission matrix and was granted to owner and
admin, and **no route consumed it** — so the data a merchant is told is kept for
their protection could not be shown to them, and "who deleted that option set?"
was answerable only with database access.

### Decision

`GET /audit-logs`, with `AuditQueryService` separate from `AuditService`.
`record()` deliberately swallows its failures — the action it describes has
already happened. Reading has the opposite disposition: a query that fails must
say so, because a trail that silently returns nothing is indistinguishable from
a clean history.

The cursor encodes the row id alone rather than the shared `(createdAt, id)`
pair: `audit_logs.id` is a monotonic `BIGINT`, already a total order, so two rows
written in the same millisecond page correctly without a tie-break.

The keyset cursor helpers moved to `common/pagination`, because a second copy of
that logic is a second place for the malformed-cursor defect found in 7e to live,
and a duplicate would not have inherited the fix.

### Consequences — the intermittent failure was test residue

An intermittent full-suite failure had been reported since 7j: roughly one run in
six, never reproducible in isolation, moving between tests. It was chased through
three disproved theories across two audits and honestly reported as undiagnosed.

The cause was **6,900 orphaned tenant rows**. Registration provisions a tenant
whose slug comes from the tenant *name*, not the suite's namespace — a test
registering as "Sam Merchant" or "Owner" produces `sam-…` or `owner-…`, which a
cleanup matching `slug LIKE 'authsvc-%'` never finds. Each run leaked a handful.
Once the table was large enough, the added latency turned other suites' fixture
creates into 404s that looked like a product bug.

Fixed in three places: the per-suite cleanups now find tenants through their
members, a `globalTeardown` sweeps anything with no members, stores or option
sets, and the accumulated 6,899 were purged. Four consecutive full runs are clean
and one orphan remains, which is the demo seed.

A second, independent flake was found in the same pass: five assertions checked a
document did not contain `1970`, and a UUIDv7 contains those digits about once in
3,400 — roughly a 0.3% false failure per document. They now match `1970-01-01`,
which is the sentinel's actual form.

**Neither was a product defect, and both looked like one.** The hardened fixtures
from 7f — which report the response rather than dereferencing `undefined` — are
what kept every occurrence legible enough to eventually trace.

### Addendum — the flakiness is reduced, not eliminated

The tenant leak was real and is fixed: 1 tenant after 11 runs, against 6,900
before. Three suites had the same defect and now share `deleteTenantsFor`, which
finds tenants through their **members** rather than a slug that the tenant's
*name* actually determines.

But a residual remains. Across 19 full runs in the round that fixed it: **16
clean, 3 failures**, always a different test, never reproducible in isolation —
one suite run six times in a row passes every time. Each failure is a fixture
create answering `404`, which is the same signature throughout.

Two further contributors were found and fixed on the way: a test provisioning a
second tenant **mid-suite** rather than in `beforeAll`, and five assertions
matching the bare string `1970` where a UUIDv7 contains those digits about once
in 3,400.

This is recorded rather than declared solved. Three rounds of fixes have each
reduced the rate without reaching zero, and the honest statement is that the
largest cause is gone and a smaller one is not yet understood. The diagnostics
added along the way — fixtures that report the response, and `newGroup` dumping
the parent set's row — mean the next occurrence carries more evidence than the
last.

---

## ADR-036 — The generated spec is checked against the contract, not trusted beside it

**Status:** accepted
**Date:** Phase 7, M7.7 / exit criterion

### Context

The plan is unusually specific about why OpenAPI is separate from
`docs/API-CONTRACT.md`: the contract is the **design**, written before any
controller exists; the spec is a **description**, derived from them. *"They will
disagree, and that disagreement is the signal that a controller drifted — a
generated spec presented as the contract would hide exactly that."*

Generating a spec satisfies the exit criterion. It does not satisfy the
reasoning: **a signal nobody reads is not a signal.** Two documents that may
disagree, with nothing comparing them, is the same shape as a guard that reports
success while inspecting nothing — the failure this codebase has now found in a
doc checker, a contract checker, a capability guard and a test fixture.

### Decision

`bin/check-openapi.sh` compares the spec to the contract and fails on three
things: a route documented `[built]` and missing from the spec, a spec route the
contract does not describe, and any of the three identity realms no longer being
declared.

The missing-from-spec case is the one `check-api-contract` cannot catch. That
script compares the **contract to the router**; a controller can register a route
and still be absent from the spec — a decorator omitted, a controller never
reaching `AppModule`. A generated client would simply lack the method, and nobody
would notice until someone needed it. Verified by mutation: removing
`AuditController` from its module fails with `GET /v1/audit-logs` named.

It carries a **coverage floor** of 20 paths, like every other check here. An
empty spec satisfies every comparison trivially.

The three realms are declared as three security schemes rather than one. A store
token must never be accepted on `/option-sets` (AC8), and one scheme would let a
generated client offer them interchangeably.

### Consequences

The spec is served at `/docs` and `/docs/openapi.json` in every environment
except production. The document is harmless — every path is known to anyone
holding the plugin, which ships with the client that calls these routes — but the
explorer issues live requests, and one pointed at production data is a footgun
handed to whoever finds the URL. Gating the document itself would protect nothing
and prevent the one thing it is for.

`ignoreGlobalPrefix: false` keeps `/v1` on the paths, so the comparison against
the contract is textual rather than a guess at how a name was derived. `/health`
stays outside the prefix (ADR-011) and is excluded from the undocumented-route
check by name.

### Addendum — the floor measured the healthy dimension

An audit of the generated spec found it structurally hollow, and the check
passing over it.

**All 21 schemas were `{"properties":{}}`.** Request bodies referenced them
correctly and the references described nothing. **Zero of 42 operations declared
security**, while all three realms sat defined in `components` — a generated
client would have treated the whole API as public. And **no operation described
any error status**, though the contract documents sixteen.

The check had a coverage floor, and the floor counted **paths** — which were
correct throughout. A floor only protects the dimension it counts, and this one
measured the dimension that happened to be healthy. That is the same failure the
floor exists to prevent, one level in.

The `@nestjs/swagger` CLI plugin would populate schemas, and was rejected: it
runs only under `nest build`, so every check and test here — all `ts-node` and
`ts-jest` — would still see an empty spec while production saw a full one. A spec
that differs by how it was compiled cannot be checked. Explicit `@ApiProperty` on
all 93 DTO properties works everywhere.

Applying errors surfaced a second defect: an `ApiResponse` on a method
**suppresses the success response Nest would otherwise infer**, so declaring only
errors left all 33 guarded operations describing nothing but failure. `ApiErrors`
now takes the success status as a required first argument, because an optional
one would be omitted exactly where it matters.

The check gained four assertions — realms *applied* not merely defined, schemas
describing properties, every operation declaring a success, and the error
statuses present — plus a second floor on schema count. Each is mutation-proven,
and each names the route or schema at fault.

---

## ADR-037 — Isolation coverage is measured, not accumulated

**Status:** accepted
**Date:** Phase 7, M6.6 extended by 7n

### Context

M6.6 asks that *"every tenant-scoped endpoint has a passing negative test"*, and
by the end of Phase 7 twelve suites contained a cross-tenant assertion. That was
the problem rather than the answer: **no single place could say whether the set
was complete.** A route added without a negative test would join a green suite
and stay there.

Scattered assertions accumulate coverage. They cannot measure it.

### Decision

`test/isolation-matrix.e2e-spec.ts` drives all 33 tenant-scoped routes as tenant
B against tenant A's data and asserts `404` — never `403`, because a 403 confirms
the resource exists and walking ids would then enumerate another tenant's data
without ever reading it (ADR-010).

`bin/check-isolation.sh` asserts the matrix knows about every route **the router
registers** — the part a test of the routes cannot check about itself. A new
tenant-scoped endpoint fails the gate until someone adds a probe.

Three routes take no foreign id and cannot answer 404. They are named in
`COVERED_BY_LEAKAGE_TEST` with the opposite assertion — that tenant B's results
never contain tenant A's rows — and a second check fails on an exemption naming
a route that no longer exists, so the list cannot become a way to silence the
gate rather than satisfy it.

The suite asserts the **effect** as well as the answer: after thirty refused
attempts, tenant A's tree and version history are byte-for-byte unchanged. A 404
returned while the write succeeded would pass every status assertion.

### Consequences

The guarantee is now mutation-proven end to end. Removing the tenant predicate
from `TenantScopedRepository` fails 4 tests; removing it from
`ParentScopedRepository` fails 5; dropping a probe fails the gate naming the
route; a stale exemption fails naming itself.

**Checking Phase 7's exit criteria found an untested one.** *"User-JWT and
store-token realms strictly separated"* was enforced — `JwtService.verify` checks
the `aud` claim and answers 401, not 403, so a forger cannot learn which part
worked — and **nothing asserted it**. The test added for it then escaped its own
mutation: it forged a token with a made-up tenant id, so the 401 came from a
tenant that did not resolve rather than from the realm. It now carries the real
user and the real tenant and changes exactly one thing, with a control asserting
the same claims succeed when the audience is right. Removing the audience check
now fails two tests.

A negative test that fails for the wrong reason proves nothing, and only mutation
tells the difference.

---

## ADR-038 — One harness, and the lifecycle set completed

**Status:** accepted
**Date:** Phase 7 audit

### Context

A full audit of Phase 7 found the milestones met and eight things worth fixing:
three functional gaps against M7.2's lifecycle table, three organisation issues,
and two operational risks.

### The lifecycle table was applied unevenly

M7.2 says the operation set is *"inherited by groups, options, and values
alike"*. **Duplicate** was built for groups and options and not values, and
**reorder** only for groups — so a merchant could rearrange groups but not the
options inside one, nor the values a customer reads in order, and configuring
twelve near-identical swatches meant typing each.

The contract had inherited the same gap while carrying a note titled *"Duplicate
exists at every level"*. Both were found by auditing against M7.2's table rather
than against the contract, which is the only way to catch a contract that agrees
with the code and both are wrong.

A duplicated value is **never the default**: two defaults on one option is a
state no storefront can render.

### One test harness

The same setup was written out in every suite: the bootstrap in fourteen,
`cleanup` in seventeen, `tenant()` in nine, `idOf` in eight. Three shared helpers
existed and every one had been added *reactively, after a bug*.

That duplication produced a real defect. Registration slugs a tenant from its
**name**, so a suite registering as "Sam Merchant" leaked a `sam-…` tenant no
namespace cleanup found. Three suites had that bug and were fixed one at a time
across three rounds while 6,900 orphaned rows accumulated.

`test/harness.ts` provides bootstrap, tenant, store, cleanup and `idOf` once.
Seven suites migrated: **657 lines deleted, 85 added**. `tenant()` fell from nine
suites to three, `idOf` from eight to one.

The full e2e suite went from **245 s to ~50 s** — the harness reuses one
application per suite rather than rebuilding the module graph in helpers that
each did it slightly differently.

### Helpers belong to the level that owns them

`buildPatch` and `pick` lived in `option-groups.service.ts` and were imported by
options and values, so two levels depended on **groups** for no domain reason.
They now live in `entity-patch.ts` — the repositories already shared
`nextSortOrder` this way; the services had not.

`touchSet` was implemented four times, each walking the tree upward with its own
queries; the value-level version cost **two extra reads per mutation**.
`ParentSetService` resolves the owning set in one join, and extracting it made
three injected dependencies unnecessary — which is the sign the concept had been
in the wrong place.

### Consequences

`check-isolation` caught all three new routes with no negative test, immediately
and by name. That is precisely what 7n built it for, and the first time it fired
on work rather than on a deliberate mutation.

**The intermittent failure is reduced, not eliminated.** Two more contributors
were found and fixed — a second tenant provisioned mid-test rather than in
`beforeAll`, the same shape as the config-document fix. The suite is 5× faster,
which makes the remaining case rarer and cheaper to reproduce. It is still not
diagnosed, and is recorded as such — though **nine consecutive clean runs** have
now been observed, against roughly one failure in four before the harness.

### Addendum — the refactor made a coverage hole visible

A final audit asked a question the passing suite could not answer: *how many
tests does removing each resolver break?*

`ParentSetService.touchForOption` broke **none of 581**. It serves option update,
delete, duplicate and reorder — four paths that must advance the parent set's
`rowVersion`, or an editor holding a version from before a colleague's rename
looks current and their next save overwrites it silently, which is the failure
M7.4b exists to design out. The existing assertions used option *create*, which
knows its group id and takes a different branch.

`touchForValue` had the same shape one level down: five paths, one covered.

**This predates the refactor.** The four original `touchSetForOption` call sites
were equally unproven; extracting the concept gave it a name a mutation could
target, and that is what surfaced it. Consolidation did not create the risk — it
made the risk measurable.

Removing each resolver now fails 12, 5 and 5 tests respectively.

The lesson is the one this codebase keeps relearning in new places: **a green
suite is evidence only after you have asked what it would take to make it red.**

---

## ADR-039 — The connection handshake, decided before it is built

**Status:** accepted
**Date:** Phase 8, M8.1 / M8.2 / M8.5

### Context

M7.7's rule holds hardest here: the plugin is a client installed on thousands of
merchant sites that **cannot be redeployed**. An endpoint shaped by an
implementation accident becomes permanent.

M8.1's handshake is a sketch, and four things it leaves open change the shape of
the phase. Each is decided below with the alternative that was rejected, so a
later reader disagrees with an argument rather than guesses at intent.

### The four

**The cloud returns the redirect URL.** `initiate` takes the site's parameters and
returns `authorize_url` complete. The alternative — the plugin assembling
`app.optionia.com/connect?…` itself — bakes the cloud's URL shape into
un-redeployable software, making a renamed query parameter impossible. This is
what makes `initiate` an endpoint rather than a constant; without it Phase 8 would
have five endpoints, not six.

**`state` is opaque to the cloud.** The plugin generates it, the cloud echoes it,
the plugin compares. That is the CSRF defence and it works *because* the cloud
cannot influence the value. M8.1 requires the code be bound to `state`; the
binding is to a **hash**, so `exchange` verifies without the cloud ever holding
the plaintext.

> **Corrected in `[8b]`.** This paragraph originally ended "and `state` never
> enters the schema", which was wrong in a way that only became visible when the
> table was built: the *hash* is a stored column, `state_hash`. The security
> claim survives — no plaintext is persisted — but the schema claim did not, and
> a reader building `[8d]` against the stronger sentence would have looked for a
> column that had to exist.

**PKCE is S256 only.** The plugin requires PHP 7.4+, where `hash('sha256', …)` is
always available. `plain` exists for clients that cannot hash; WordPress is not
one, and offering both lets an attacker choose the weaker.

**`authorize` returns JSON, not a 302.** The dashboard is a SPA holding a tenant
JWT in memory: a redirect would be followed by `fetch` and never seen, and a JWT
cannot ride a browser redirect.

### A store credential is an opaque token, not a JWT

Already decided in 7a — the realm table names `StoreTokenGuard` and "Store token".
Recorded here with the reason: **M8.6 requires revocation to be immediate, and a
JWT cannot be un-issued.** A revoked store would keep working until expiry.

`TokenAudience.STORE` exists in the Phase 6 JWT enum, is used by nothing, and
contradicts this by implying a store presents a JWT. Removed in `[8c]`.

### Addendum — what `[8c]` actually contained

"Remove an unused enum member" was the wrong description of this step in three
ways, each found by looking rather than by assuming.

**`TokenAudience.STORE` was not unused.** It had one reference:
`jwt.service.spec.ts`, inside *"refuses a token presented to the wrong realm"* —
the cross-realm test that is the API-boundary form of AC8. Deleting the member
and then deleting the line the compiler complained about would have left that
test passing, identically named, proving **one realm less**. The assertion is
kept against the literal `'store'`: a tenant token must be refused for that
audience whether or not this codebase has a name for the value, which is the
stronger question anyway.

**`PLATFORM` is in the same position and must stay.** It is also referenced only
by the enum and that test. The difference is not usage but kind: `PLATFORM` is a
genuine JWT audience awaiting its Phase 26 routes, while no `aud` value can ever
be right for a store, because a store presents no JWT. Recorded because the next
reader will otherwise "tidy up" the symmetry.

**`@Public()` could not be used for store routes.** Authentication is global and
`@Public()` is the only opt-out, but it means *no authentication at all* — a
store route behind it whose guard was missing or short-circuited would be open to
anyone, and every test would still pass. That is the fail-open shape
`CapabilityGuard` was already bitten by. `@StoreRoute()` is narrower: it tells
`JwtAuthGuard` to stand aside for a different realm, and a route carrying it
without `StoreTokenGuard` reaches the handler with no realm, tenant or store —
unusable rather than unprotected, since `requireTenantId()` throws instead of
returning unscoped rows. A permanent probe asserts this rather than trusting the
argument.

**The context already modelled the realm.** `RequestContext.realm` was declared
`'platform' | 'tenant' | 'store'` in Phase 6 and `userId` was already optional, so
a store request needed no new shape — only `storeId`, added here. `audit_logs.user_id`
is nullable, so a store-authenticated write audits with the actor absent rather
than invented.

**`last_used_at` is throttled to 5 minutes**, not written per request. Its
consumers — support, stale-install detection — ask in days, and the heartbeat
alone is 60 requests an hour per store. The write is also swallowed on failure: a
telemetry column must not turn an authenticated request into a 500.

### Addendum — `[8d]`, and three gates that excluded by path

**Reconnection reuses the store row.** `uq_stores_tenant_url` is
`(tenant_id, store_url)` and M8.1b runs `REVOKED → DISCONNECTED → CONNECTING`,
so re-approving a site the tenant already holds is the *recovery* path the plan
sends merchants down after a revocation, a site-URL change or a rotation. A
`409 CONFLICT` would tell a merchant who was told to reconnect that they cannot.
Reuse also preserves `store_id`, and with it the store's history, analytics and
every row referencing it — a second row would orphan all three silently.

The lookup is `(tenantId, storeUrl)` and never URL alone, which is a security
boundary rather than a detail: two tenants may legitimately hold one address, and
matching on URL would let one tenant's approval seize the other's store. Verified
by mutation — dropping `tenantId` from that query broke nothing until a test with
two tenants at one URL existed.

**`initiate` is not audited, and that is structural.** It is `@Public()` and
carries no tenant, while `audit_logs` is read through a tenant-scoped query — an
entry with a null tenant is invisible to every consumer, written to satisfy a rule
nobody can read. M8.1b's "every transition is logged" is therefore read as every
transition **of a store**, and a pending request is not yet a store: nothing
exists to transition until `authorize` creates or reuses one.

**Single-use is a conditional write, and the read-side check was hiding it.**
`approvedAt !== null` rejects the ordinary second attempt, so removing
`WHERE approvedAt IS NULL` broke no test — two sequential calls never race. Only
three simultaneous approvals exercise it, and that test now exists.

### Addendum — `[8h]`, and two audit actions pointed at the wrong step

**The heartbeat never writes `stores.status`.** M8.1b's reconciliation says a
mismatch is "recorded rather than silently overwritten", and adopting the plugin's
`connection_state` would be that overwrite. The plugin's view is one of the two
things in dispute: a cloned staging site reports on a production store it is
impersonating, and believing it would let a clone degrade the original.

**`STORE_ERRORED` belongs to Phase 9, not `[8h]`.** `[8f]` declared it expecting
the heartbeat to produce it. It cannot — a heartbeat is the plugin *succeeding* at
reaching the cloud, which is the opposite of the `CONNECTED → ERROR` edge's "sync
or auth failure". That failure is a config sync failing, and it arrives with the
sync. This is the second action mis-assigned at declaration time (`STORE_REVOKED`
was pointed at `[8g]` and belonged to `[8i]`), which suggests the mapping should
be made when the *producing* step is designed rather than when the action is
declared.

**Reconciliation records `store.state_mismatch` in the audit trail**, not in a new
operations table. The trail is already the shape of the requirement — something a
human should see, attributable, timestamped, tenant-scoped — and Phase 26 will
design an operations surface properly. Inventing one now would build the wrong
thing twice and add a fifth accumulating table to the four already awaiting
retention. The honest limit: an entry is a record, not a queue, and nobody is
paged. That is equally true of a Phase 26 row until its reader exists.

**`connection_state` accepts all five states deliberately.** A plugin can only
truthfully observe `connected` or `error` — it cannot know it was revoked, having
received a `401` — so narrowing the field looks tighter and is worse: it would
reject the anomalous report at validation and lose the exact signal reconciliation
exists to capture. A `400` says nothing; a recorded mismatch says a site is
confused.

**`reauthorize` ships structurally `false`.** Neither trigger can fire in `[8h]`:
a site-URL change is `[8i]`'s, and a revoked credential never reaches the handler
because `StoreTokenGuard` answers `401` first. The field exists from day one
because the plugin cannot be redeployed (M7.7) to start reading it later — and it
is documented as such rather than tested, since asserting `false` would assert a
constant.

**Seven mutations, no survivors** — a first for this project. Removing the
mismatch check, recording one when the views agree, adopting the plugin's claim,
dropping `COALESCE` from the telemetry write, skipping `lastSeenAt`, echoing the
plugin's `config_version`, and removing `StoreTokenGuard` each broke tests. The
difference from earlier steps is that every assertion reads the **persisted row**
rather than the response, which is entirely derived values.

### Addendum — `[8j]`, and criteria that were not Phase 8's to satisfy

Searching for `8j` found nothing: it was a letter from my own plan, and every
Phase 8 route was already `[built]`. What the search *did* find was a **Phase 8
exit criteria** block I had not read — six lines, of which three were not the
cloud's to satisfy at all.

**"Merchant can connect a store in under 60 seconds"** spans the plugin's connect
screen and the dashboard's approval screen. **"No SaaS secret in plugin source"**
is the plugin's own gate. **"Revocation degrades gracefully"** has two halves, and
only one is testable here: the cloud must destroy nothing the storefront needs,
while *serving cached config after a `401`* is plugin behaviour.

The list is now split by owner. Leaving them together made Phase 8 look as though
it owed work it structurally cannot do — the same defect as an audit action
pointed at the wrong step, which happened three times in this phase.

**The cloud's five criteria are now executable.** `phase-8-acceptance.e2e-spec.ts`
drives them as scenarios through the real endpoints, in the order a plugin and a
merchant perform them. It deliberately re-asserts no units: every criterion spans
steps — connecting touches `[8d]`, `[8e]` and `[8f]`; a clone being refused touches
`[8c]`, `[8f]` and `[8i]` — and the per-step suites each prove their own step and
none of them a criterion. The coverage existed and was scattered, so "Phase 8 is
done" rested on an assertion rather than something that runs.

**One acceptance test proved a constant.** "Destroys no configuration" compared
`configVersion` before and after a disconnect — and a freshly connected store has
`configVersion = 0`, so the comparison was `0 === 0` and passed whatever disconnect
did to the column. Verified by mutation: wiping it broke nothing. The test now sets
a published version first, and the mutation is caught.

That is the fourth time in this phase a test has asserted a value the handler could
not vary — after `[8g]`'s `status`, `[8h]`'s `reauthorize`, and `[8e]`'s read-check.
The pattern is specific enough to name: **a test whose expected value is also the
system's default proves nothing**, and the fix is always to move the fixture off
the default before asserting.

#### The same amplification, written twice

An audit of `[8i]` found `store.site_mismatch` writing one audit row per refused
request — measured, five identical refusals gave five rows. That is the defect the
`[8h]` audit had found one step earlier in `store.state_mismatch`, fixed, and
recorded in this document. I wrote the fix and then reproduced the bug in the next
guard.

The reason is instructive: `[8h]`'s fix was **local**. It read the previous entry
inline in `stores.service.ts`, so the next call site had nothing to reuse and
nothing to notice. Two occurrences is a pattern, and Phase 9's sync failures are
the third.

`AuditService.recordChange(entry, fields)` is that pattern, extracted. It records
only when the named fields differ from the last entry of the same action on the
same resource. `fields` matters: comparing the whole `changes` object would let
any varying member — a timestamp, a message — defeat the check silently, and a
mutation doing exactly that is caught.

Two details worth keeping. A failed *lookup* records unconditionally rather than
dropping the entry: recording twice is a worse trail than once, and losing it is
worse than both. And deduplicating the record does not soften the refusal — every
request from the wrong site is still refused, asserted separately, because a
suppressed log line must never become a suppressed control.

Verified end to end: **20 identical refusals, 20 blocked, 1 audit row.**

### Addendum — `[8i]`, and why a site mismatch must not revoke

**Revoking on a mismatch is a denial-of-service vector.** `X-Optionia-Site` is a
plain HTTP header, and whoever holds the credential controls its value. If a
mismatch revoked, then anyone who stole a token could **disconnect the merchant's
live store** by sending one bad header — turning a read-only compromise into an
outage — and a merchant migrating their domain legitimately would kill their own
store on the first request from the new address.

So `[8i]` refuses the request and leaves the store connected. That is what M8.1b
asks for: *"a cloned site cannot **silently** reuse the original's credential."*
**Silently** is the operative word — refusing without recording would leave
`stores.status` reading `connected` while a clone hammered the endpoint and nobody
learned it existed. Every mismatch is audited as `store.site_mismatch` naming both
URLs, and revocation stays a decision a human makes.

**`STORE_REVOKED` moves a third time**, to `[phase 26]`. `[8f]` assigned it to
`[8g]`, `[8g]`'s audit moved it to `[8i]`, and `[8i]` turns out not to revoke
either. It is an operator's act on the evidence, which is Phase 26's surface. Three
moves is the argument for assigning an action when its **producer** is designed
rather than when the action is declared — each move was caught by the self-expiry
check, but none needed to happen.

**The contract asked for `403` *with* `reauthorize: true`, which is impossible.**
`reauthorize` lives in the heartbeat's `200` body and `ApiErrorResponse` is
`{ error, meta }` with no `data` at all. Resolved as `403` alone: the status *is*
the signal, and a plugin receiving it knows the cloud will not accept it from this
address. `reauthorize` therefore stays structurally `false` until something can
require re-authorisation **without** refusing the request — an operator action
against a store that is still serving.

**The check is its own guard, not part of `StoreTokenGuard`.** That guard holds an
invariant worth keeping — every failure is the same `401`, so a caller learns
nothing from which one they hit — and a `403` would break it. They answer
different questions: *"is this credential valid"* and *"is this the site it was
issued to"*. Separate also means Phase 9's config-sync routes inherit both by
adding one decorator rather than by remembering a check.

`storeUrl` rides on the request context because `StoreTokenGuard` already joins
`stores` to resolve the tenant — one more column on a row it is fetching anyway,
rather than a second query.

**A missing header is not a mismatch.** Every shipped plugin sends it, but a
proxy stripping unknown headers or an engineer with `curl` would not, and refusing
them would make this guard an availability risk for no security gain. A caller
that omits the header has told us nothing; one that sends the wrong header has told
us something.

**Six mutations, one survived.** Always admitting, comparing raw without
normalisation, answering `401`, treating a missing header as a mismatch, and
dropping the audit each broke tests. Failing **open** when no store is in context
broke nothing — that branch is unreachable on the heartbeat, where both guards are
declared together in order, and becomes reachable only when a future route applies
this guard alone. A permanent probe controller now applies it alone and asserts the
`401`, following the precedent `store-realm.e2e-spec` set for
`@StoreRoute()`-without-its-guard.

#### An audit of `[8h]` — a guard opted out of, and an amplifier

**The heartbeat bypassed the `BIGINT` safety guard.** `bigintTransformer` throws
rather than truncating a value JavaScript cannot represent exactly — a deliberate
defence against silent precision loss. A raw `dataSource.query` never runs the
transformer, and the heartbeat is the **only** production raw query reading
`configVersion`, so the one place that reads it outside the entity is also the one
that quietly opted out.

Unreachable in practice: `configVersion` increments once per publish, and
overflowing a double needs roughly nine quadrillion of them. Fixed anyway, for the
same reason the guard exists — this is the third instance of the pattern (`scopes`
unread, `tokensMatch` uncalled) where a defence is built and then not reached.

**Reconciliation wrote one audit row per ping.** Measured: five pings, five rows.
A store that cannot be reconciled — a cloned site, a restored database —
disagrees on *every* heartbeat, so daily that is 365 rows a year, and against the
60-per-hour limit a misbehaving plugin writes **1,440 a day for one store**.

Deduplicated at the source: the trail is its own memory, so the last recorded
mismatch says what was already reported, and only a *changed* disagreement is
news. It compares **both** views — a cloud-side change with the plugin's claim
unchanged is still news, and a mutation deduplicating on the plugin's state alone
is caught.

No new column and no migration: `ix_audit_resource` already covers
`(resource_type, resource_id)`, so this is one indexed lookup on a path that
already writes.

**`audit_logs` is now named in M34.1, on different terms from the token tables.**
It is the fifth unpruned table and the only one that must *not* simply be swept —
it is the trail a merchant is told is kept for their protection, and ADR-010's
`SET NULL` rules already preserve it through erasure. It needs a retention
*period* rather than a prune of expired rows, since it has no `expires_at` to key
on.

**Three mutations, one survived.** Removing the deduplication and narrowing it to
the plugin's state alone each broke tests. Making `safeInteger` truncate instead
of throwing broke **nothing** — the guard was added and never exercised, which is
exactly the defect it was added to fix. A test now drives a `BIGINT` past 2^53 and
asserts a `500`: a loud failure rather than a wrong number handed to a plugin that
trusts it.

#### `check-isolation` did not know about the store realm

The heartbeat is authenticated but has no tenant id in its path — the credential
*is* the store — so the cross-tenant probe has nothing to ask for. The gate knew
`@Public()` and not `@StoreRoute()`, and demanded a negative test that cannot be
written. It now reads both markers, and a route that loses `@StoreRoute()` is
demanded again, mutation-proven.

#### `option-authoring` carried a duplicate `idOf`

The suite defined its own copy, predating the harness migration, so the request-
path diagnostic added to the shared helper never reached it — and it is the suite
where the fixture `404` was reported most often. Removed; it uses the shared one.

#### The intermittent e2e failure was self-inflicted

A failure reported across five suites over several phases — `option-authoring`,
`cascade`, `serialization`, `publish`, `isolation-matrix` — always unreproducible
in isolation, always described as "roughly one run in five". It was chased through
several wrong theories: parallel contention (`maxWorkers` is 1), orphaned tenants
(the table holds one row), namespace collisions (all 20 distinct, no prefix
overlaps), unscoped `DELETE`s (there are none), suite ordering (identical between
runs), and the soft-delete sentinel (production uses the SQL literal, never the
`Date`).

Caught at last by looping the suite until it failed and **keeping the log**. The
run showed 99 failures, not a handful, and the cause was not the fixture `404` at
all: `beforeAll` hooks timing out at 120 seconds, with two suites taking over
**900 seconds** each. No lock waits, no deadlocks, no connection errors — MySQL
peaked at 8 connections against a limit of 151.

The explanation is what I was doing while the loop ran: a second e2e suite, the
unit suite, and seven gate scripts — four of which boot a full Nest application —
all against the same database. Two test runs competing for one MySQL instance and
eight cores, with `maxWorkers: 1` meaning neither could yield.

Three control runs with nothing else running: **681 passed, ~56 seconds, every
time.** The earlier "1 in 5" rate matches how often I happened to be running
something else.

**There is no product defect here**, and recording it matters more than the fix
would have: five audits reported this as an open unexplained flake, and each
report made it look more like a real intermittent bug in the code. The lesson is
narrower than the symptom suggested — *do not run a second suite against the test
database while one is running* — and the instrument that would have shown it
sooner is simply keeping the failing log rather than re-running until green.

`idOf` now names the request in its failure message. The five reports all read
`Fixture failed to create a value: 404 {}`, which says a parent was not visible
but not which one; `option-authoring` had grown per-fixture diagnostics for
exactly this, and the shared helper every other suite uses had none. It now
reports `404 [POST /v1/groups/<id>/options] {"code":"NOT_FOUND", …}` across all 84
call sites.

#### The capability requirement was declared and never tested

Both `[8g]` routes carried `stores:connect` and `stores:rotate_credential`, and
nothing proved it. Mutation: pointing **both** at `option_sets:view` — which
`viewer` holds — passed all nineteen tests. A viewer could have disconnected a
merchant's store and rotated its credential with nothing failing.

`[8d]` already tested this for `authorize`; the pattern simply was not carried
into the step whose routes are the most destructive in the phase.

**Writing the tests exposed a second, subtler problem.** The obvious helper —
register a user and demote them — produces a viewer of *their own* empty tenant,
so every request is refused for belonging to another tenant rather than for
lacking a capability. The two are indistinguishable from outside: `CapabilityGuard`
answers `403` and a cross-tenant store answers `404`, and a test asserting `403`
cannot tell which it got.

The admin case is what surfaced it — expecting `200`, receiving `404`. The viewer
and editor cases had "passed" while proving less than they appeared to.

The fix is to put the caller **inside the owner's tenant**, leaving role as the
only variable: revoke their own membership, insert one into the owner's tenant,
then log in. The order matters — `primaryMembership` picks the oldest live
membership and `tid` is fixed when the token is signed, so a token minted before
those writes still names the wrong tenant.

**One mutation survives deliberately.** Swapping the two capabilities between the
routes changes nothing, because no role holds one without the other — owner and
admin hold both, everyone else neither. No HTTP test can separate them, so the
distinction is asserted against the controller source instead: each route names
its own capability, and neither falls back to one a viewer holds.

#### An audit of `[8g]` — rotation was refused where it was most needed

**A store in `ERROR` could not rotate its credential.** The guard read
`status !== CONNECTED`, a literal reading of the contract's
`CONFLICT (store is not connected)`. But an erroring store reached that state
*from* `CONNECTED` on a sync or auth failure, and nothing revokes on the way in —
M8.1b has it keep serving cache and recover, so **its credential is still live**.

A merchant whose store is erroring, who suspects that error *is* a compromised
token, is precisely who this endpoint exists for. The guard made the security
feature unavailable in the state that most suggests it is needed. `ERROR` now
rotates; `DISCONNECTED`, `REVOKED` and `CONNECTING` still cannot, because they
hold no live credential to replace. The contract says that rather than naming one
state.

**`disconnect` discarded its transition result** — the same defect fixed in the
reuse path two commits earlier, reproduced in code written after that fix. Only
reachable if the store row is deleted mid-transaction, and nothing is corrupted
when it happens (the store is gone; no credential outlives it), but the handler
would have answered `{ status: 'disconnected' }` about a row that no longer
exists.

**Disconnect now spends any pending connection code.** `[8f]`'s guard already
refuses to move a `DISCONNECTED` store to `CONNECTED`, so this changes no
outcome — it is defence in depth. A code that looks redeemable for its remaining
five minutes is an artefact someone will eventually reason about incorrectly, and
a merchant's disconnect is a clear statement that the handshake is over.

**Two things were tested rather than assumed, and both were fine.** Three
concurrent rotations leave exactly **one** live credential — InnoDB row locking
serialises them, so the race suspected during the audit does not exist. And the
full M8.1b scenario, driven end to end, refuses the retry: initiate → authorize →
merchant disconnects → plugin retries its valid code → `401`, store
`disconnected`, zero live credentials, code spent.

### Addendum — `[8g]`, and a test that proved a constant

**`STORE_REVOKED` was mapped to the wrong step, and the mechanism caught it.**
`[8f]` listed it as awaiting `[8g]` on the assumption that disconnecting revokes.
It does not: `disconnect` moves a store to `DISCONNECTED`, and `rotate` does not
transition at all. The state diagram labels that edge "cloud revokes" and M8.1b
names its trigger — a `site_url` change requiring re-authorisation, which is
`[8i]`. Re-pointed.

Worth recording that the self-expiry built into that exemption is what would have
caught it: once `[8g]` shipped, the marker leaves the contract and the check fails
on an action nothing produces. The list could not have quietly gone stale.

**Rotation needed its own audit action.** It is the one store event that changes a
credential without changing state — the store stays `CONNECTED` throughout — so it
could borrow neither `STORE_DISCONNECTED` nor `STORE_REVOKED`.
`store.credential_rotated` is that action.

**Two stale contract statements.** The rotate example showed
`"prefix": "osk_live"`, written before `[8e]` settled that `token_prefix` holds
the eight characters *after* the marker — `osk_live` is identical in every
credential and identifies nothing, which is the opposite of the column's purpose.
And `reason` was promised "shown to the merchant in the store's history", a route
that exists in no step of Phase 8. The reason is captured on the audit entry; the
surface that displays it is deferred to Phase 26 with the rest of the audit
reader, rather than left as a promise with no owner.

**Five mutations, one survived — a test that proved a constant.** Removing
revocation from `disconnect`, removing it from `rotate` (the leaked-token case),
returning `403` instead of `404` cross-tenant, and rotating a disconnected store
each broke tests. Transitioning to `CONNECTING` instead of `DISCONNECTED` broke
**nothing**: the suite asserted `response.body.data.status`, which is a constant
the handler returns, so it read `disconnected` whatever the database held. The
tests now read `stores.status` back, and the mutation is caught.

**The state gate needed read allowances, and they had to be narrow.**
`stores.service.ts` legitimately *reads* status — comparing to decide whether a
rotation is possible, and reporting one back to the caller — which the gate
flagged. Allowing a bare `status: StoreStatus.X` would have been the easy fix and
would have reopened the exact hole closed a commit earlier, since that also
matches a TypeORM update payload. Comparisons and returns are allowed by their own
patterns instead, and all four evasions remain caught.

### Addendum — `[8f]`, the state machine, and a store that could rise from the dead

`[8f]` has no route and no contract entry. It is **M8.1b**, the one part of Phase 8
that is infrastructure rather than an endpoint — which is exactly why it had to
land before `[8g]`.

**A disconnected store could silently reconnect itself, with no attacker
involved.** `[8e]` wrote `UPDATE stores SET status = 'connected' WHERE id = ?`
with no precondition:

```text
t0     merchant clicks Connect        → code issued, store CONNECTING
t0+10s the plugin's exchange fails    → a network blip; it will retry
t0+30s merchant clicks Disconnect     → credentials revoked, DISCONNECTED
t0+60s the plugin retries with its still-valid code
       → the store returns to CONNECTED with a fresh credential,
         moments after the merchant disconnected it
```

That is M8.1b's stated nightmare almost verbatim — *"the merchant sees connected,
the cloud disagrees, and nobody can tell which is right"* — reached by a failed
exchange and an impatient merchant. The five-minute code TTL bounds the window; it
does not close it. `[8g]` was about to make step three a one-click act.

**`→ CONNECTING` is legal from every state, and that is deliberate.**
Re-authorising is always legitimate: reconnecting a revoked store, retrying a
failed connection, or re-linking one that already works — `[8d]`'s reuse path
already depended on it. The guard that matters is on *completing* a handshake, not
on starting one, so only `CONNECTING` and `ERROR` may reach `CONNECTED`.

**Every `stores.status` write now goes through `StoreStateService`, and
`check-store-state` makes that mandatory rather than conventional.** Three
scattered writes existed; `[8g]`, `[8h]` and `[8i]` were about to add four more.
Seven ad-hoc writes across four steps is how two sides drift apart, and a rule
that lives only in a comment is one the next step forgets. The gate carries a
coverage floor: it fails both on a rogue write and when its pattern stops matching
anything, and both are mutation-proven.

**All five states' audit actions are declared with the transition table**, not by
whichever step first needs one. Adding them piecemeal made the coverage gate
unable to tell a missing action from a deliberate omission — it caught exactly
that in `[8d]` and again in `[8e]`.

That leaves three actions declared with no route producing them, which the
coverage gate correctly flagged. They are listed as **awaiting their step**, a
category deliberately distinct from `coveredElsewhere`: that one claims another
suite exercises the action, while this one admits nothing does and names the step
that will. The exemption **expires on its own** — once the owning step marks its
routes `[built]`, the marker disappears from the contract and the check fails
until the action is genuinely exercised. Mutation-proven.

**`connected_at` is now written.** The column shipped in the initial schema, is
documented in `DATABASE.md`, and nothing had ever set it — so "connected since
when?", the first question a support ticket asks, had no answer for any store.

#### Two gates existed and never ran

An audit found `check-isolation` and `check-openapi` **absent from `ci.yml`**
entirely, and `npm run check` invoking two of seven gates.

`check-isolation` is AC5's enforcement: it asserts that *every tenant-scoped route
has a negative test*, which is what stops a new route shipping with no
cross-tenant coverage. It had existed for three phases and ran only when someone
invoked it by hand.

This is the project's recurring failure one level up. Each gate carries a coverage
floor so it cannot pass while inspecting nothing — and two of them were not in the
pipeline at all, reading as coverage in the list while verifying nothing on any
push. Adding `check-store-state` to CI without checking whether its neighbours
were there is how it stayed hidden.

All seven now run in CI and in `npm run check`.

#### `DISCONNECTED` was the only state that could not be re-entered

`CONNECTING`, `ERROR` and `REVOKED` were self-reachable; `DISCONNECTED` was not,
with nothing recording why. `[8g]` would have met it immediately — a merchant
double-clicking Disconnect gets `moved: false` on the second call, and the
contract's response (`{"status": "disconnected", …}`) promises idempotency by
returning the resulting state rather than a changed flag.

Now self-reachable, with the rule asserted: every state may be re-entered
**except `CONNECTED`**. That exception is the whole reason the table exists — it
is what refuses a replayed connection code — so it is tested rather than left
looking like the same oversight.

#### `TransitionResult` is a boolean

It carried a `from` field costing a `SELECT` on every refusal that **no caller
read**. The same defect as the `tenantId` and `reason` parameters removed with it.
A caller that ever needs the current state can read it once and say so, rather
than every caller paying for it always.

The reuse path also **discarded** its transition result. It cannot refuse on state
— every state may begin a handshake — but it can report no rows if the store was
deleted between the lookup and the write. Unchecked, that race continued to
`UPDATE store_connection_codes SET storeId` and failed on the foreign key: a 500
from a constraint, one statement away from where the condition was knowable. Data
was never at risk; the error was just far from its cause.

#### The gate's *allowance* had the fragility its detection used to have

Rewriting the reuse call across four lines broke it: the `transition(` allowance
matched per line, so a legitimate multi-line call stopped being recognised and the
gate failed on correct code.

It now analyses per **file**, flattening newlines first and counting how many
`StoreStatus` values a file names against how many its allowances account for.
Formatting can no longer change the verdict in either direction. Four evasions —
multi-line SQL, `manager.update`, `manager.save`, and entity mutation — are all
caught, a legitimate multi-line call passes, and the floor still fails if the enum
is renamed.

#### The gate I shipped caught one spelling, not the rule

An audit of `[8f]` found `check-store-state` catching **none of three** realistic
evasions: multi-line SQL, `manager.update(Store, id, { status })`, and an entity
mutation followed by `save()`. Its pattern required `UPDATE stores SET … status`
on one line, so it proved only that nobody had written that particular spelling —
the shape I had in mind while writing it, and the same error as `[8d]`'s
hardcoded lookalike callback.

It now matches on **`StoreStatus`**, the enum every legitimate status value must
come from. Enumerating TypeORM's write APIs is a losing game — `update`, `save`,
`upsert`, `createQueryBuilder().update()`, plain assignment — but all of them must
name a value, and the raw-SQL check separately flattens newlines so a statement
split across lines reads as one.

Three allowances, each narrow: the machine itself, an `INSERT` creating a store
(an initial state has no prior state to guard), and an audit entry recording a
change. That last one had to require its `changes: {` context — allowing a bare
`status: StoreStatus.X` let `manager.update(Store, id, { status: … })` straight
through, because an audit entry and a TypeORM write are the same six characters
and only the surrounding key tells them apart. All three evasions are now caught,
and the floor fails if the enum is renamed.

#### `record()` was dead, and could not have worked

`StoreStateService.record()` had **no callers**, proven by deletion: removing it
orphaned both `ACTION_FOR` and the injected `AuditService`.

It never acquired a caller because the mapping cannot work. `ACTION_FOR` was keyed
on the destination state, and `[8d]` distinguishes a fresh connection from a
reconnection — both of which arrive at `CONNECTING`. Any caller would have logged
every reconnect as a first-time connect.

Removed rather than repaired. The call site is the only place that knows what a
transition *meant*, which is also where the audit belongs so it lands after the
transaction commits. `transition()` lost its `tenantId` and `reason` parameters
for the same reason: both were declared and silently discarded, and a parameter
that looks maintained and is not is the defect this codebase keeps finding.

### Deferred — M8.4's signed timestamp

M8.4 requires "every request over HTTPS with `Authorization: Bearer`, a
plugin-version header, **and a signed timestamp to limit replay**". The contract
specifies the first two and has never mentioned the third; the plugin does not
send one.

**Not built, and recorded rather than dropped.** A replayed store request buys an
attacker nothing they could not do by replaying the credential itself, which they
must already hold — the token is a bearer secret over TLS, not a signature over a
request, so a timestamp would authenticate freshness without authenticating
anything else. The defences that do matter are already specified: immediate
revocation (`[8c]`), site-URL binding (`[8i]`), and a credential that never
appears in a URL.

The cost of being wrong is asymmetric, though: under M7.7 the installed plugin
cannot be redeployed to start sending a header later. If a signed timestamp is
ever wanted, it must be added **before** the plugin ships in `[8k]`–`[8m]`, and
that is the decision point — not this one.

### Addendum — `[8e]`, and two contract statements that could not both be kept

**"Exactly" had to mean "exactly, after normalisation".** The contract required
the redeeming `site_url` to equal the issuing one *exactly*, while `initiate`
stores a normalised URL and WordPress reports `home_url( '/' )` with a trailing
slash. Verified against the plugin source (`Api/Client.php:367`): a literal byte
comparison would have refused **every honest first exchange**. Both sides now
normalise, and the binding is still exact — exact between two values reduced the
same way. This is the third appearance of one rule, after `initiate`'s
callback-origin check and `[8i]`'s `X-Optionia-Site` comparison.

**`osk_live_` and `token_prefix` could not be the same eight characters.** The
contract showed a token reading `osk_live_…` *and* a `prefix` of `"osk_live"`,
while `store_credentials.token_prefix` is `CHAR(8)` documented "for support
identification". Both cannot hold: the first eight characters of every credential
would be `osk_live`, a column of one constant identifying nothing.

Resolved by giving them different jobs. The token carries the marker so a leaked
credential is recognisable on sight and a secret scanner can match it;
`token_prefix` holds the first eight characters of the **random part**, so support
can still tell two credentials apart. `generateStoreToken` is separate from
`generateToken` rather than a flag on it — refresh tokens, reset links,
invitations and connection codes all use that one and none should carry a store
credential's marker.

**`check-secrets` flagged the marker, and the gate was right to.** Its pattern
catches any `…token… = "…"` of eight characters or more, which is exactly what
catches a real leaked credential; its own docstring records an earlier, looser
version that let three of four real secrets through. Weakening it to admit a
public format marker would have traded a working scanner for a naming
convenience, so the constant gives way instead and is assembled from parts.

**`store.connected` is audited with an explicit tenant.** `exchange` is
`@Public()` and has no tenant in context — but unlike `initiate`, the tenant is
*knowable*: `authorize` recorded it on the code. Naming it directly keeps a
completed connection visible to the tenant-scoped audit query, which is precisely
what `initiate` could not do and why it stays unaudited.

**Six mutations, and the one that survived was correct.** Removing the conditional
spend, the expiry check, the PKCE verifier, the `site_url` binding, or
double-hashing the challenge each broke tests — the double-hash broke eight.
Removing the *read-side* `redeemedAt` check alone broke nothing, because the
conditional `UPDATE … WHERE redeemedAt IS NULL` is authoritative; removing both
breaks single-use twice over. The two are layered by design, not redundant.

The case-sensitivity test fires only because `challenge` is `utf8mb4_bin`, which
the `[8b]` audit fixed before anything read the column. Under the schema-wide
`_ci` collation a verifier whose challenge differed only in case would have been
accepted.

**The suite outgrew its own rate limit.** `exchange` runs a full handshake per
test and `authorize` is capped at 30/hour per tenant, so the 32nd call returned
`429` and every later assertion failed for an unrelated reason. Fixed with a
second tenant rather than by loosening the limit: a security control specified in
the contract should not be relaxed to suit a test suite, and one tenant per
concern is what really happens.

#### An audit written inside a transaction survives its rollback

`authorize` recorded its audit entry **inside** `dataSource.transaction`, while
every state change there used the transactional `manager`. `AuditService` writes
through its own repository — a different connection — so the entry was never part
of the transaction at all.

Demonstrated rather than argued: an audit written inside a deliberately
rolled-back transaction left the row behind, `PHANTOM_DELTA 1`. A phantom entry is
worse than a missing one, because it sends whoever reads the trail looking for a
store that does not exist.

Every other service in this codebase records **after** its transaction commits,
including `duplicate`, which has one. The trade is the opposite failure — a commit
whose audit write then fails — and `record` swallows that deliberately, leaving an
incomplete trail rather than undoing an action that already happened. Moving the
call out restores the convention; the mutation putting it back is now caught.

#### `tokensMatch` had no caller, and one site needed it

`src/common/crypto/tokens.ts` has provided a timing-safe comparison since Phase 6
with **zero production callers**, which reads as a security helper protecting
nothing.

The reason turned out to be structural rather than neglect: every secret in this
system — refresh tokens, password resets, email verification, store credentials —
is found by an **indexed lookup on its hash**, so the database does the matching
and no comparison happens in our code at all. `[8d]`'s `state` check is the first
and only in-process hash comparison in the codebase.

It now uses `tokensMatch`. The channel is weak on a digest — an attacker cannot
walk it byte-by-byte without already holding the preimage — but the correct
comparison costs nothing, and leaving the single comparison site on `!==` is what
makes a helper look decorative. The alternative considered and rejected was
deleting `tokensMatch`: `[8e]` compares a PKCE verifier against a stored
challenge, which is the second such site.

#### Three gates excluded public routes by path

`check-openapi`, `check-isolation` and the OpenAPI e2e suite each skipped
`/v1/auth/` and `/health` **by name**. That was correct while those were the only
unauthenticated routes and wrong the moment `/connect/initiate` appeared — but the
worse half is the other direction: a route that *lost* its `@Public()` would have
gone on being exempted, unguarded and unnoticed, by all three.

All three now read the `@Public()` marker itself, from the handler and from the
controller, because Nest resolves both and checking only one reported `/health` as
unguarded. Mutation-proven in both directions: a route losing its realm fails, and
a route losing `@Public()` immediately fails for want of one.

`POST /v1/connect/authorize` is exempt from the isolation matrix with a reason —
it names a connection request, not a tenant's resource, so there is no foreign id
to refuse. The property that matters is asserted directly in the handshake suite
instead.

#### Seven mutations, four survived

Removing the state-hash check, the expiry check and the capability each broke a
test. Four did not, and each was a test passing for the wrong reason:

| Mutation | Why it survived |
|---|---|
| origin → prefix check | the lookalike callback was hardcoded while the site was generated, so they shared no prefix |
| single-use conditional | the read-side pre-check answered first; no concurrent test existed |
| reuse by URL alone | no test had two tenants at one URL |
| `https` → `https?` | both scheme tests passed on the *origin* check instead — protocol is part of an origin |

The last is the one worth remembering: `http://` site with `https://` callback is
refused because the origins differ, so **both** scheme rules could be deleted
without failing a test. Only a plaintext site *and* callback on the same origin
reaches the rule, and that test now exists.

### Addendum — an audit of `[8c]`, and four things it found

**The OpenAPI spec still said `aud: store`.** The one artefact facing a client
developer — generated, served at `/docs` — carried the exact belief the step
existed to delete. It survived because the sweep searched for the symbol
`TokenAudience.STORE` and the spec spells the concept, not the symbol. Whoever
wrote it had already omitted `bearerFormat: 'JWT'` for that scheme alone, so the
machine-readable half was right and only the prose was wrong; the prose is what a
human reads. Corrected to say opaque token, no claims, no `aud`.

**`store_credentials.scopes` is never read, and that is correct.** M6.5 gives
every store credential the same fixed scope — read config, write events,
heartbeat — so there is nothing per-credential to check. But a column named
`scopes` that no code reads says two contradictory things to a later author
(*enforcement is missing* / *enforcement is elsewhere*), and both are wrong. Now
stated in the contract, along with why a per-credential model was not adopted: a
plugin install needs all three permissions or it cannot function.

**The fail-closed claim was reasoning, not a test.** `[8c]` argued that a route
carrying `@StoreRoute()` without `StoreTokenGuard` is *unusable rather than
unprotected*, because the scoped repository calls `requireTenantId()` and it
throws. The test only asserted the context was **empty** — which shows nothing was
established, not that the absence is safe. The other half is now a test: the
unguarded probe has a route that attempts a scoped read, and it must 500.
Mutation-proven by making `requireTenantId()` return `''` instead of throwing.

**"60 per hour, per store" was specified and not implemented.**
`AuthThrottlerGuard` keys on IP, falling back to IP alone when a request carries
no email — and a store request never does. Every store behind one address shared
a bucket, so an agency's busy shop throttled its quiet ones, while one store
moving between addresses never met its limit at all.

The fix has an ordering constraint worth recording: the throttler is deliberately
registered **ahead** of authentication, so an unauthenticated flood is rejected
before it costs a signature check or a database lookup — which means `store_id`
is not in context when the key is computed. Keying on the **hash of the presented
credential** needs no lookup and is equivalent, since a credential belongs to one
store. Rotation starts a fresh budget, which is correct: rotation is
capability-gated, not attacker-triggerable.

The realm is decided by the **route prefix**, not by the token's shape — a store
credential and a tenant JWT are both opaque strings in one header, and inferring
from shape would key a merchant into the store bucket. `/stores/:id/credential`
is a *tenant* route, so the match is on the path segment: a prefix match captures
it wrongly, and that mutation is caught.

`getTracker` had **no test at all** before this. A rate-limit key is not
observable from a passing request, so nothing else would ever have caught the
gap — which is why a specified-but-unimplemented limit survived into the
contract.

**Eleven mutations, one of which survived.** Removing the revocation check, the
expiry check, the stand-aside, the context write and the throttle each broke
tests. Changing the guard's `INNER JOIN` to a `LEFT JOIN` broke **nothing** — the
test named "refuses a credential whose store was deleted" never reached the join,
because `store_credentials` cascades on store deletion and the row was already
gone. The test proved the cascade while claiming to prove the join. Both are now
tested separately, the second by creating an impossible row with the constraint
suspended, and the mutation is caught.

### Consequences

**The deferred table was misattributing three surfaces.** One row read
`/stores/* → 8` while its four endpoints span Phases 8, 13 and 19; another read
`/store/heartbeat → 8–9` while M8.5 places it squarely in 8. A coarse row lets a
later phase build against a contract that never described its endpoint, which is
the failure that table exists to prevent. Rows are now per-surface.

**The contract checker's marker pattern was `[7a-n]`** — correct while Phase 7 was
the only phase with steps, and silently wrong the moment `[8d]` appeared: an
unrecognised marker reads as *missing*, so the first Phase 8 entry failed a gate
that was itself out of date. Now `[\d+a-z]`, and mutation-proven to still catch a
genuinely absent marker.

**Two capabilities already existed.** `stores:connect` and
`stores:rotate_credential` were in the matrix from M6.5, held by owner and admin.
The contract initially assigned rotation to `stores:connect`; checking rather than
assuming found the finer-grained one already drawn.

### Addendum — an audit of the contract itself

Auditing 8a against M7.7's nine required fields found the decisions sound and the
**specification incomplete**. Six fixes, of which one mattered more than the rest.

**The site-URL mechanism did not exist as written.** The draft said a credential is
"bound to the `site_url` it was issued for" and that the check is against "the
credential's own bound URL". `store_credentials` has **no URL column** — it reaches
one only through `store_id`, so the "binding" was the store's own mutable field.
`[8i]` would have built against a mechanism rather than a fact.

The real mechanism was already shipping: the plugin sends `X-Optionia-Site` —
`home_url()` — on every request, and a store's URL is recorded once at connection
and never edited. A clone reports *its own* URL while the credential still names
the original, which is exactly what makes the mismatch detectable. The contract now
describes that comparison, requires both sides to normalise trailing slash and host
case, and specifies `403` rather than `401` — the credential is genuine, the site
presenting it is not, and a 401 sends the plugin into a reconnect loop that
retrying cannot win.

**Two lifetimes were missing, and they differ for a reason.** The code is 5 minutes
(M8.1's acceptance, absent from the draft); a pending request is 30 minutes. Five
minutes would fail a merchant who signs up and verifies an email mid-flow. The
threats differ: a pending request grants nothing without a tenant sign-in, while a
code is one exchange from a credential.

Three endpoints also lacked the rate limits M8.2 requires, two lacked field-rule
tables, and `disconnect` did not say it takes no body. All were written more
loosely than the three endpoints drafted first — the tail of a document getting
less care than its head, which an audit catches and a reader would not.

### Addendum — the handshake's storage, `[8b]`

**One table, not two.** The handshake produces two artefacts — a pending request
and an approved code — and they differ in *lifetime* (30 minutes, 5 minutes)
rather than in identity. The flow is strictly linear: created once, approved once,
redeemed once. Splitting it would put a foreign key between two rows that both
expire, which is a reference to something that may already have been collected.
The two clocks live as two nullable columns on one row.

**`tenant_id` and `store_id` are nullable, and that is the point.** `initiate` is
called by a plugin holding no credential and belonging to no workspace — which
workspace the site joins is precisely what the merchant chooses on the approval
screen. A `NOT NULL` here would require inventing a tenant before a human has
picked one. Both are `ON DELETE CASCADE`: a deleted tenant's in-flight handshakes
are meaningless, not orphans worth keeping.

**`challenge` is stored as sent, and is the one value that is not re-hashed.** It
arrives as a PKCE S256 digest already. Hashing it again would make `exchange`
compare `SHA-256(SHA-256(verifier))` against `SHA-256(verifier)` — a check that
fails for every honest client while looking like defence in depth.

**It is also the one column in the database that is `utf8mb4_bin`.** base64url
uses both cases, so under the schema-wide `utf8mb4_unicode_ci` MySQL considers
two genuinely different challenges equal — verified on 9.6, where
`'E9Melhoa2Owv…' = 'e9mELHOA2oWV…'` returns `1`, and where inserting `'abc123'`
then `'ABC123'` was rejected as a duplicate key. Every other hash column here is
hex, which has no two spellings of one value, so this is the only column that
needed it.

The hazard was invisible in the ordinary way: no test fails, because every honest
client still succeeds. Worse, **TypeORM does not diff collation** — after the
entity was corrected, `migration:generate` reported "no changes", so the
migration had to be hand-written and a generated one would have left the entity
and the database permanently disagreeing. `check-docs` now asserts the collation
directly against `information_schema`, and fails both when it is wrong and when
the named column is missing entirely; both paths are mutation-proven.

**Nothing in the table is readable as a secret**, which is what lets `state` cross
the browser at all: `state_hash` and `code_hash` are digests, `challenge` is one by
construction. A dump yields no usable CSRF token and no redeemable code.

⚠️ **It is a fourth accumulating table.** It grows per *attempted* connection, not
per successful one — so unlike `refresh_tokens` its growth is driven by traffic
that never becomes a customer and cannot be bounded by estimating the user base.
Retention is **M34.1**'s, and the plan's prune note now names this table
explicitly rather than leaving a doc pointing at an entry that never mentioned
it.

### Addendum — four suites were testing a pipe nobody ships

Auditing `[8b]` led here indirectly. An intermittent e2e failure prompted a check
of how suites bootstrap, which found the harness built during the Phase 7 audit
covering **7 of 23 suites** — and, more seriously, that four of the unmigrated
ones configured a `ValidationPipe` weaker than `main.ts`:

| Suite | Missing |
|---|---|
| `tenant-isolation` | `whitelist`, `forbidNonWhitelisted`, `enableImplicitConversion` |
| `guards`, `rate-limit` | `forbidNonWhitelisted`, `enableImplicitConversion` |
| `auth-http` | `enableImplicitConversion`, and its own drifted `exceptionFactory` |

Each would pass while the shipped pipe rejected the request under test. The worst
was `tenant-isolation` — the permanent acceptance criterion for AC5 — asserting
tenant scoping with no `whitelist` at all. All four now share `bootstrapTestApp`,
and their assertions still hold under the stricter pipe, which is the result that
makes the migration safe rather than merely tidy.

**`flattenValidationErrors` is no longer private to `main.ts`.** It could not be
imported, so suites needing the production error shape rewrote it, and
`auth-http`'s copy read `error.property` directly — losing the nested path, so it
reported `postcode` where the application reports `address.postcode`. It now lives
in `src/common/validation/`, imported by both.

**Nine suites were deliberately left alone.** They open a `DataSource` and never
boot an application; the harness bootstraps one, so migrating them would add cost
and prove less. `openapi` was also left: it installs no pipe on purpose. A
migration that makes a suite test something different is not a refactor.

**`.env` now loads in `setup-e2e.ts`.** Suites called `loadDotenv()` first thing
in `beforeAll`, which is too late for a suite declaring a test-only `@Module` at
file scope — its decorators evaluate at *import* time, and `tenant-isolation`
threw `Missing required environment variable: JWT_SECRET` on the way to the
shared bootstrap. `dotenv` never overwrites, so loading once up front is
idempotent.

**The flake itself remains open, and two theories were disproved.** It reproduces
at roughly **1 run in 5** and always the same way: `option-authoring` creates a
group, then `newOption` gets a 404 attaching to it moments later. What it is not:

- **Not parallel contention.** `maxWorkers` is 1 — the suites run serially.
- **Not the orphaned-tenant bug.** Measured directly: the suite leaks zero
  tenants and zero users, and the table holds one row, not 6,900.
- **Not a namespace collision.** All 17 suite namespaces are distinct, and every
  `DELETE` in `test/` is namespace-scoped.
- **Not introduced by `[8b]`.** `newGroup` already carried a diagnostic for it,
  added earlier against "an intermittent cross-suite failure (roughly one run in
  six)" — the same rate, predating this work.

`newOption` now carries the diagnostic `newGroup` had, so the next occurrence
reports whether the group, the set, or the tenant went missing instead of a bare
`404 {}`. That is deliberately an instrument rather than a fix: the failure is
rare enough that guessing at a cause would more likely bury it than close it.

**`[8d]` must register the entity.** There is no `StoresModule` yet — `src/stores`
holds entities only — so nothing declares
`TypeOrmModule.forFeature([StoreConnectionCode])`. Migrations find the entity by
glob, which is why every gate passes today and why the omission is invisible: the
first symptom would be a resolution failure at runtime in `[8d]` itself. Creating
the module now, with no controller or service to put in it, would be scaffolding
built ahead of its purpose; recording the requirement here is the cheaper half of
the trade.
