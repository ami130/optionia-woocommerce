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
| Signalling | A deprecated version returns `Deprecation` and `Sunset` headers (RFC 8594), and `meta.deprecation` in the envelope. |
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
