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
