# API Contract — v1

**Status:** authoritative for every endpoint listed here.
**Rule:** an endpoint is documented here *before* its controller is written
([M7.7](../../developePlan.md)).

This document is the **design**. The OpenAPI spec generated from the controllers
is a **description**. They will occasionally disagree, and that disagreement is
the signal that a controller drifted from its contract — which is why the
generated spec never replaces this file.

**Both are now checked against each other.** `bin/check-openapi.sh` fails when a
route documented `[built]` is missing from the spec, or a spec route is
undocumented, or any of the three identity realms stops being declared. A signal
nobody reads is not a signal.

The spec is served at **`/docs`** (explorer) and **`/docs/openapi.json`** (raw),
in every environment except production. The document itself is harmless — every
path is already known to anyone holding the plugin — but the explorer issues live
requests, and one pointed at production data is a footgun handed to whoever finds
the URL.

---

## Why the contract comes first

The plugin is a client that **cannot be redeployed** across thousands of merchant
sites. An endpoint shaped by an implementation accident becomes permanent in a way
a dashboard's never does: the dashboard ships with the API, and the plugin does
not.

That asymmetry is the whole argument. Everything below is decided once, here,
rather than per endpoint by whoever writes it.

---

## Conventions

### Base path and versioning

Every endpoint is under `/v1`, except `/health` which is deliberately unversioned:
monitoring should not have to track API versions, and a probe expects a flat body
rather than our envelope.

Breaking changes get `/v2`; `/v1` is then supported for **12 months** with a
deprecation header (ADR-011).

### Response envelope

Every response — success or failure — carries `meta`. Controllers never assemble
this; `ApiResponseInterceptor` does.

```jsonc
// Success
{ "data": { ... }, "meta": { "requestId": "01a0…", "timestamp": "2026-08-25T…" } }

// Failure
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": [ … ] },
  "meta": { "requestId": "01a0…", "timestamp": "2026-08-25T…" } }
```

`requestId` appears on **both**, because the value of a correlation id is asking a
merchant to quote it from a failure.

### Errors

`code` is stable and machine-readable; `message` is human-readable and may change
freely. **Clients must not parse `message`.** The full set and its statuses:

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Request body failed validation; see `details` |
| `MALFORMED_JSON` | 400 | Body is not parseable JSON |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type` is not `application/json` |
| `UNAUTHENTICATED` | 401 | No credential, or one that is not valid |
| `TOKEN_EXPIRED` | 401 | Credential was valid and has expired |
| `TOKEN_INVALID` | 401 | Single-use token is spent, revoked, or unknown |
| `FORBIDDEN` | 403 | Authenticated, and not permitted |
| `EMAIL_NOT_VERIFIED` | 403 | Credentials correct; the address is unverified |
| `INSUFFICIENT_ROLE` | 403 | Authenticated in this tenant; role lacks the capability |
| `NOT_FOUND` | 404 | Does not exist, **or belongs to another tenant** |
| `CONFLICT` | 409 | Request conflicts with current state |
| `ALREADY_EXISTS` | 409 | Uniqueness violation |
| `VERSION_MISMATCH` | 409 | Optimistic lock failed; reload and retry |
| `RATE_LIMITED` | 429 | Too many requests |
| `PLAN_LIMIT_EXCEEDED` | 429 | Plan quota reached |
| `INTERNAL_ERROR` | 500 | Unexpected; details are logged, never returned |
| `SERVICE_UNAVAILABLE` | 503 | Dependency unavailable |

**404 versus 403 is a security decision, not a style choice.** A resource
belonging to another tenant returns `NOT_FOUND`. Returning `FORBIDDEN` would
confirm the resource exists, turning an authorization boundary into an enumeration
oracle: an attacker walks ids and learns which belong to other tenants from the
status alone (ADR-010).

`INSUFFICIENT_ROLE` is the opposite case and is deliberately honest. The caller is
a legitimate member of this tenant and the resource plainly exists — hiding that
would make "why can't I publish?" unanswerable.

### Validation errors

`details` names the field that failed, one entry per failed constraint:

```jsonc
{ "error": { "code": "VALIDATION_FAILED", "message": "The request contains invalid fields.",
    "details": [
      { "field": "password", "code": "INVALID", "params": { "message": "Password must be at least 12 characters." } },
      { "field": "email",    "code": "INVALID", "params": { "message": "A valid email address is required." } }
    ] } }
```

A field failing three rules produces three entries: each is a separate thing the
user has to fix. Unknown fields in a request body are **rejected**, not ignored —
otherwise a caller can probe for fields the API might accept.

### Authentication realms

Three realms, strictly separated. **This is the API-boundary form of AC8.**

| Realm | Credential | Routes | Guard chain |
|---|---|---|---|
| **Tenant** | User JWT, `aud: tenant` | everything except below | `JwtAuthGuard` → `TenantGuard` → `CapabilityGuard` |
| **Platform** | User JWT, `aud: platform` | `/admin/*` (Phase 26) | `JwtAuthGuard` → `PlatformGuard` |
| **Store** | Store token | `/store/*` (Phase 8) | `StoreTokenGuard` |

A credential from the wrong realm is **401, never 403** — the route should not
admit it exists. The `aud` claim is checked before any role logic, at both the
library and application layers.

Authentication is **global and opt-out**: a route is protected unless it carries
`@Public()`. The inverse default would make forgetting the guard a silent hole
rather than a 401 during development.

### Authorization

Every mutating route in the tenant realm declares a capability. `CapabilityGuard`
**fails closed** — a route behind it that declares nothing is refused, so an
undocumented capability is a route nobody can call.

Capabilities are fixed by the permission matrix (M6.5) and not re-decided per
endpoint.

### Rate limiting

Keyed on **IP plus the submitted account** where a body carries an email,
otherwise IP alone. Per-account keying is what stops credential stuffing spread
across many machines, each making a few attempts against a different account.

Default: 300 requests/minute and 20/second. Auth endpoints override this
individually — those limits are listed per endpoint below because they are part of
the contract, not an implementation detail.

`/health` is exempt from every bucket: a probe polls continuously and has no
credentials, and a 429 is indistinguishable from a 500 to an orchestrator.

### Pagination

Every list endpoint uses **cursor pagination**. Offset pagination skips or repeats
rows when the underlying set changes between pages, which for an option list a
merchant is actively editing is a bug they will report as "my option disappeared".

```jsonc
// GET /v1/option-sets?limit=50&cursor=eyJpZCI6…
{ "data": [ … ],
  "meta": { "requestId": "…", "timestamp": "…",
            "pagination": { "cursor": "eyJpZCI6…", "hasMore": true, "limit": 50 } } }
```

`limit` defaults to 50 and is capped at 100. `cursor` is null on the last page.

The cursor is **opaque** and clients must not construct one — its encoding is an
implementation detail. The field is named `cursor` rather than `nextCursor`
because `PaginationMeta` has used that name since Phase 5; this document said
`nextCursor` until the first list endpoint was built against it.

**A malformed cursor is rejected**, with `400 VALIDATION_FAILED` and the detail
`{ "field": "cursor", "code": "INVALID_CURSOR" }`. It is not treated as an absent
cursor. Returning page one for an unusable cursor gives a client a `200` it cannot
distinguish from a genuine first page, so a cursor truncated in transit turns a
paging loop into an infinite one that re-reads page one and never terminates.

Clients should echo `meta.pagination.cursor` back verbatim and stop when it is
`null`.

### Route status markers

Every route table and heading carries its build state, and `bin/check-api-contract.sh`
reads them:

| Marker | Meaning |
|---|---|
| **`[built]`** | Registered by the application today. Must exist, or the check fails |
| **`[7x]`** | Ships in this Phase 7 step. Must **not** exist yet |
| **`[phase N]`** | A later phase owns it |

Without a marker a route is neither verifiable nor refutable: the first version of
this check verified only that registered routes were documented, so a fabricated
endpoint added to this file passed silently.

The check enforces all three directions, and **a route with no marker is itself a
failure** — when markers were introduced, this sentence was true of only eight of
the thirty-nine routes, and the document asserted otherwise. It is now checked
rather than claimed:

| Failure | Meaning |
|---|---|
| marked `[built]`, not registered | The contract describes an endpoint that does not exist |
| registered, not marked `[built]` | An endpoint shipped without its marker being updated |
| documented, no marker at all | Neither direction can be checked for it |
| no routes discovered | The router shape changed and the check is inspecting nothing |

### Idempotency

`POST` routes that create a resource accept an `Idempotency-Key` header. A repeat
with the same key returns the original response rather than creating a second
resource. Required for anything with a side effect a merchant would notice twice —
publishing, invitations, checkout (Phase 22).

---

## AUTH — `/v1/auth/*`

**Realm:** none. Every route is `@Public()`; these are how a caller *obtains* a
credential.

> **Two names differ from the sketch in M7.7**, and the built names are
> authoritative. The sketch says `/auth/forgot-password`; the endpoint is
> `/auth/request-password-reset`, which says what it does rather than what the
> button is labelled. And `/auth/resend-verification` is absent from the sketch
> while [M6.1](../../developePlan.md) names "verification resend" among the
> endpoints that must be rate-limited — it was correctly built, and the sketch was
> incomplete.

### `POST /v1/auth/register` **[built]**

Creates a user, provisions their tenant, and sends a verification email — all in
one transaction. A user without a tenant cannot act, and a tenant without an owner
is unreachable.

**Rate limit:** 5 per hour, per address.
**Response:** `202 Accepted`

```jsonc
// Request
{ "email": "sam@example.com", "password": "…", "name": "Sam",
  "tenantName": "Sam's Store" }   // optional; defaults to `name`

// Response
{ "data": { "message": "If that address can be registered, a verification email is on its way." } }
```

| Field | Rules |
|---|---|
| `email` | valid address, ≤ 320 chars |
| `password` | 12–72 **bytes** — bcrypt truncates silently at 72, so a longer value would be weaker than it looks |
| `name` | ≤ 255 chars |
| `tenantName` | optional, ≤ 255 chars |

**The response is identical for a new and an existing address.** Anything else
turns registration into a membership oracle: an attacker submits a list and learns
who has an account. The wording is true either way.

**Errors:** `VALIDATION_FAILED`, `RATE_LIMITED`.

### `POST /v1/auth/verify-email` **[built]**

**Rate limit:** 10 per hour. **Response:** `200 OK`

```jsonc
{ "token": "…" }                     // → { "data": { "verified": true } }
```

**Errors:** `TOKEN_INVALID` (401) for expired, already-used, and never-existed
alike — distinguishing them confirms a token was once valid.

### `POST /v1/auth/resend-verification` **[built]**

**Rate limit:** 3 per hour, per address — this endpoint sends mail to an address
the caller names, which is the email-bombing vector M6.1 warns about.

**Response:** `202 Accepted`, identically whether the address exists, is already
verified, or is unknown.

### `GET /v1/auth/me` **[built]**

Who the caller is — the dashboard's shell reads it on boot
([M13.1](../../developePlan.md)). **Rate limit:** 300 per hour.

```jsonc
// → 200
{ "data": { "id": "0f3c…", "email": "sam@acme.example", "name": "Sam",
            "emailVerified": true, "locale": null,
            "tenant": { "id": "8a1b…", "name": "Acme", "slug": "acme",
                        "status": "active" },
            "role": "owner" } }
```

**Why an endpoint rather than persisting the login response.** After a page
reload a client holds only its tokens, whose claims are `sub`, `tid` and `role` —
enough to route, and nothing a header can display. A cached login response goes
stale the moment a name changes, and a second device never sees the update. It
also doubles as the boot-time "is this token still good" probe: a client that
starts by asking who it is learns immediately whether to refresh.

⚠️ **Authenticated, on a `@Public()` controller.** Every other `/auth` route is
public by necessity; this one is the opposite. It carries `@Authenticated()`
alongside its guards, because `JwtAuthGuard` reads `IS_PUBLIC` with
`getAllAndOverride([handler, class])` — **a route-level guard alone is not
enough**. Without the marker the guard stands aside, nothing populates the
request context, and the handler answers `401` to a caller holding a perfectly
valid token. Measured while building it.

**An explicit column list**, and `passwordHash` is the reason: `users` carries a
bcrypt hash and `sessionsInvalidatedAt`, neither of which belongs in a response.
The test asserts an exact key set rather than a "does not contain" check, so a
column added in a later phase cannot join the payload unnoticed.

**The membership is read live**, not taken from the token's claims — a role
changed since the token was minted shows the new one, and the shell is where a
merchant would notice.

### `POST /v1/auth/login` **[built]**

**Rate limit:** 10 per 15 minutes, per account. Enough for someone who cannot
remember which password they used; nowhere near enough to work through a list.

**Response:** `200 OK`

```jsonc
// Request:  { "email": "sam@example.com", "password": "…" }
// Response
{ "data": { "userId": "…", "emailVerified": true,
            "accessToken": "…",   // JWT, aud=tenant, ~15 min
            "refreshToken": "…",  // opaque, 30 days, rotated on use
            "tenantId": "…", "role": "owner" } }
```

**Errors:**

- `UNAUTHENTICATED` (401) — **one message for a wrong password and an unregistered
  address**, and the same work is done for both: an unknown address still pays a
  bcrypt comparison, so it is not measurably faster to probe.
- `EMAIL_NOT_VERIFIED` (403) — safe to distinguish, because the caller has
  already proven they hold the password.

  ⚠️ **This was `FORBIDDEN` until 2026-09-02**, and sharing a code with
  "your role lacks that capability" left a client unable to tell them apart. The
  dashboard rendered *"You do not have permission to do that"* to a merchant
  whose only problem was an unopened email — and it was a dead end, because the
  resend screen needs a session sign-in had just refused. Found by Phase 13
  Stage 2's audit, by signing in with an unverified account.

  The remedies are opposite: a permissions failure means *ask someone else*, and
  this means *open your email*. The sign-in screen now offers to resend the link,
  which is why `POST /auth/resend-verification` is public and takes an address
  rather than a session.
- `RATE_LIMITED` (429).

### `POST /v1/auth/refresh` **[built]**

Exchanges a refresh token for a new one, **and mints a fresh access token**.
**Rate limit:** 60 per hour.

```jsonc
// → 200
{ "data": { "accessToken": "eyJ…", "refreshToken": "…",
            "tenantId": "0f3c…", "role": "owner" } }
```

🔴 **The access token was added 2026-09-02.** This endpoint returned
`{ refreshToken }` alone, and access tokens live fifteen minutes
(`JWT_ACCESS_TTL`) — so a client refreshed its session and still held an expired
credential, signed out every quarter of an hour with no way to continue. Nothing
caught it because **no client existed**: the plugin authenticates with a store
credential rather than a JWT, and the route's own test asserted only that the
refresh token had changed. Found by Phase 13 Stage 1's analysis, before the
dashboard was written against it.

**The membership is re-read, not replayed.** A role can change mid-session — an
owner who demotes a member must not have the old role re-minted for another
fifteen minutes — so the refresh is the moment that takes effect. A user whose
memberships were all revoked gets `TOKEN_INVALID` rather than a token naming a
workspace they no longer belong to.

**Rotation and reuse detection.** Each refresh mints a new token and marks the old
one spent. A token presented twice means a copy was stolen — the legitimate holder
has the replacement — so **the entire family is revoked**, not just the replayed
token. Revoking only that one would log the victim out while leaving the attacker
signed in.

**Errors:** `TOKEN_INVALID` (401) for every failure, including detected reuse.
Telling an attacker their replay was noticed tells them the token was real; the
detection is for operations, which get a warning log.

### `POST /v1/auth/logout` **[built]**

**Rate limit:** 60 per hour. **Response:** `204 No Content`, whether or not the
token was live — a different answer for an unknown token confirms which exist.

Revokes the refresh family **and** stamps `sessions_invalidated_at`, so the access
token stops working immediately rather than surviving until it expires (ADR-024).

### `POST /v1/auth/request-password-reset` **[built]**

**Rate limit:** 3 per hour, per address. **Response:** `202 Accepted`

**No row is written and no mail is sent for an unknown address**, and the response
is identical either way.

### `POST /v1/auth/reset-password` **[built]**

**Rate limit:** 10 per hour. **Response:** `200 OK` → `{ "data": { "reset": true } }`

On success: every outstanding reset link is invalidated, **every session is
revoked**, and a confirmation email is sent. That email is how a victim learns of
a takeover — without it, a successful reset by an attacker is completely silent.

**Errors:** `TOKEN_INVALID` (401).

---

## TENANTS & MEMBERS — `/v1/tenants/me/*`

**Realm:** tenant. `JwtAuthGuard` → `TenantGuard` → `CapabilityGuard`.

Every route is scoped to the tenant in the caller's token, verified against a live
membership row on each request — so a removal or demotion takes effect on the next
call rather than when the access token expires.

| Route | Capability | State | Notes |
|---|---|---|---|
| `GET /tenants/me` | — | `[7e]` | Any member may read their own workspace |
| `PATCH /tenants/me` | **owner only** | `[7e]` | Renaming is an ownership act |
| `GET /tenants/me/members` | — | `[7e]` | Any member may see who else is here |
| `POST /tenants/me/members/invite` | `members:invite` | `[7e]` | owner, admin |
| `PATCH /tenants/me/members/:id` | `members:change_role` | `[7e]` | **owner only** |
| `DELETE /tenants/me/members/:id` | `members:invite` | `[7e]` | owner, admin |
| `GET /tenants/me/invitations` | `members:invite` | `[7e]` | Pending invitations |
| `DELETE /tenants/me/invitations/:id` | `members:invite` | `[7e]` | Revoke a pending invitation |

> **The services behind these all exist** — `TeamService` was built in 6j with
> invite, accept, change-role, remove, revoke and list. What is missing is the
> HTTP surface, which is why they are `[7e]` rather than `[built]`: a documented
> route whose service exists is still a route nobody can call.

> **Three routes are absent from M7.7's sketch** and are added here: listing
> pending invitations, revoking one, and accepting one (below). All three are built
> in [M6.5b](../../developePlan.md) and all three are in its text. A pending-invite
> list with resend and cancel is named explicitly.

### `POST /v1/auth/accept-invitation` **[7e]**

**This route is deliberately not under `/tenants/me`.** Someone accepting an
invitation **is not yet a member of that tenant**, so a route scoped to "my tenant"
cannot serve them — `TenantGuard` would reject the request before the handler ran.

It belongs in the same family as email verification: token-addressed, outside
tenant scope, authenticated as a *user* rather than as a member.

**Realm:** tenant JWT, but **no** `TenantGuard`. **Response:** `200 OK`

```jsonc
// Request:  { "token": "…" }
// Response: { "data": { "tenantId": "…", "role": "editor" } }
```

**The invitation names an address, and acceptance is refused if it does not match
the signed-in user.** Otherwise a forwarded link hands the grant to whoever clicks
it — verified to hold under concurrency, not only sequentially.

**Errors:** `TOKEN_INVALID` (401) for expired, revoked, already-used and unknown
alike; `FORBIDDEN` (403) when the address does not match.

### `POST /v1/tenants/me/members/invite` **[7e]**

**Capability:** `members:invite`. **Response:** `202 Accepted`

```jsonc
{ "email": "colleague@example.com", "role": "editor" }
```

**An inviter cannot grant a role above their own.** Without that an `admin`
invites a stranger as `owner`, the stranger promotes the admin, and every "admin
cannot" line in the permission matrix is decorative.

Roles are **not ranked** — `billing` and `editor` are incomparable — so this is an
explicit grant list per role rather than a comparison:

| Inviter | May grant |
|---|---|
| `owner` | owner, admin, editor, viewer, billing |
| `admin` | admin, editor, viewer, billing — **not owner** |
| others | nothing |

**Errors:** `INSUFFICIENT_ROLE` (403) for an escalation attempt or a role with no
grant list; `CONFLICT` (409) if that person is already a member.

### `PATCH /v1/tenants/me/members/:id` · `DELETE /v1/tenants/me/members/:id` **[7e]**

**The last owner cannot be demoted or removed.** A tenant with no owner is
unadministrable: nobody can change roles, alter billing, or delete it, and the only
repair edits the database by hand.

The count is enforced **inside the write**, so two owners demoted simultaneously
cannot both succeed.

**Errors:** `CONFLICT` (409) — *"This workspace must keep at least one owner"* —
including when concurrent removals deadlock, because the aborted statement is
precisely the one that would have left none. `NOT_FOUND` (404) for a member id in
another tenant.

Removal **revokes rather than deletes**, so "were they a member at the time" stays
answerable after the fact.

---

## AUDIT — `/v1/audit-logs`

**Realm:** tenant.

| Route | Capability | State |
|---|---|---|
| `GET /audit-logs` | `audit_log:view` | `[built]` |

Every privileged action is recorded with **actor, diff and IP** (M7.6). This is
how a merchant reads that back.

`audit_log:view` is held by **owner and admin only** — not editor. An editor
changes configuration; *who* changed what, from which address, is an ownership
question, and the trail contains IP addresses, which are personal data.

**Filters:** `action` (exact, e.g. `option_set.deleted`), `resourceType`,
`resourceId`. Deliberately narrow — `audit_logs` carries `(tenant_id, created_at)`
and `(resource_type, resource_id)` indexes, and these are the queries those
indexes answer. A filter for every column invites queries nothing serves.

**Paginated newest-first**, cursor as everywhere else. The cursor encodes the
row id rather than `(created_at, id)`: `audit_logs.id` is a monotonic `BIGINT`,
so it is already a total order, and two rows written in the same millisecond
still page correctly.

`ip` is returned **readable**, unpacked from the 16 bytes the column stores.

> ⚠️ An IP is personal data under GDPR. Retention is
> [Phase 26b](../../developePlan.md)'s, and the column is subject to it — the
> trail is not kept indefinitely.

**Errors:** `VALIDATION_FAILED` (400) for a malformed cursor;
`INSUFFICIENT_ROLE` (403) for an editor or viewer.

---

## OPTION SETS — `/v1/option-sets/*`

**Realm:** tenant. Every route tenant-scoped at the data layer, not by a predicate
a handler remembers to add.

| Route | Capability | State |
|---|---|---|
| `GET /option-sets` | `option_sets:view` | `[built]` |
| `POST /option-sets` | `option_sets:edit` | `[built]` |
| `GET /option-sets/:id` | `option_sets:view` | `[built]` |
| `PATCH /option-sets/:id` | `option_sets:edit` | `[built]` |
| `DELETE /option-sets/:id` | `option_sets:delete` | `[built]` |
| `DELETE /option-sets/:id/permanent` | `option_sets:delete` | `[built]` |
| `GET /option-sets/:id/detail` · `GET /option-sets/:id/preview` | `option_sets:view` | `[built]` |

> **Two projections, one serializer** ([M7.2b](../../developePlan.md)).
> `/detail` returns the **authoring** shape — the whole tree in `camelCase`, with
> drafts, ids and audit fields, which is what the editor renders.
> `/preview` returns the **published** shape — the config document a storefront
> would receive if the set were published now, in `snake_case`.
>
> Both come from the same serializer, so a preview cannot show something a
> storefront would not. The published shape is defined by
> [M7.5](../../developePlan.md) and frozen in `docs/CONFIG-CONTRACT.md` at 7k.
>
> `GET /option-sets/:id` still returns the set alone: a list row does not need
> its tree, and loading one for every row would make the list cost grow with the
> work a merchant has done.

The **published** projection deliberately omits `tenantId`, `rowVersion`,
`publishedBy`, `createdAt`/`updatedAt` and `isEnabled`, and drops disabled
groups, options and values entirely rather than flagging them. The config
document sits on merchant servers, so a field appears only if the plugin
genuinely needs it — and a disabled thing that ships with a flag makes every
consumer responsible for remembering to check it.

**The envelope is complete from v1.** `assignments` and `rules` are always
present and always empty until Phase 13 and Phase 17 build them. A plugin
written against a shape that lacks a key would need a `schema_version` bump to
gain it later; an empty array is a shape its first release can already handle.

**An assignment carries `mode`, and the target fields are nullable.**

```jsonc
{ "mode": "manual",        // "all" | "manual" | "conditional"
  "target_type": "product", // null when mode is "all"
  "target_ref": "sku-1",    // null when mode is "all"
  "priority": 10 }
```

`mode` is not decoration. An `all` assignment applies to **every product in the
store** and therefore has no target — so a reader given only `target_type` and
`target_ref` cannot tell "applies to everything" from "applies to nothing",
which is the most common thing a merchant configures. The shape could not
express its own data without it.

Added in Phase 9 rather than later, deliberately: the index that consumes this is
[M10.1](../../developePlan.md), so the gap would not have surfaced until
something was already being built against the wrong shape. Additive keys do not
bump `schema_version`.

**Populated since Phase 10 Stage 1**, and read **live** rather than from the
snapshot. An assignment is not part of a published version — the same published
set is assigned and unassigned without republishing — so the document joins them
at read time. Two consequences worth stating for any reader of this endpoint: a
set published before that stage shipped still shows its current assignments, and
an assignment change is visible without a new version.

The authoring UI that creates these rows is M13.6, and the `conditional` mode
together with the `category` / `tag` / `attribute` / `price_range` targets are
resolved by M19.4 — until then a storefront renderer reads `all` and `manual`
and skips the rest.

Snapshots written before `mode` existed are normalised on read and default to
**`manual`**, never `all` — guessing `all` would silently widen an assignment
from one product to a whole catalogue.

**`price_config` is `snake_case`, always.** The stored JSON is `camelCase`
because its schema is TypeScript (M7.3); the document is converted per pricing
type — `amount_minor`, `basis_points`, `free_characters`, and tiers as
`min_quantity` / `max_quantity` / `amount_minor`. Passing the stored object
through unchanged put **two spellings of the same field in one document**,
depending on whether a value was priced through `price_config` or through the
`price_type` / `price_amount_minor` columns. An open-ended tier keeps
`max_quantity: null` explicitly, because an evaluator must tell it apart from
absent.

> **This was designed as `DELETE /option-sets/:id?hard=true` and built as a
> distinct path.** A query parameter that turns a reversible action into an
> irreversible one is a single typo away from erasing a merchant's work, and it
> makes the two operations indistinguishable in an access log — the one place
> anyone looks after an accident. The capability is the same because the
> authority is the same; the path differs because the consequence does.

`DELETE /option-sets/:id` is always permitted and reverses; it soft-deletes the
set and cascades to its groups, options, values, rules and assignments.

**Deleting a published set advances `config_version`** (M9.4b). The config
document is assembled from published snapshots, so removing one changes what
every storefront is served — and `config_version` is the only thing that tells a
plugin to refetch. Without the bump, `GET /store/config` keeps answering `304`
and shops go on rendering options the merchant deleted. Measured before it was
fixed: the document lost its only set while the version stayed at 1.

Deleting a **draft** does not bump, and must not: a draft was never in the
document, so invalidating every storefront cache for it would cost a full
refetch for a change no customer can observe.

Both delete routes bump, and the pair does not double-bump: the usual
delete-then-erase sequence advances the version once, on the soft delete. The
rule lives in `ConfigVersionService` and is enforced by
`bin/check-config-invalidation.sh`, which fails when a new writer of published
configuration does not call it.

`DELETE /option-sets/:id/permanent` accepts a set that was never soft-deleted, so
it can erase live published configuration on its own — which is why it bumps
independently rather than relying on a preceding soft delete. It erases the set
and everything under it, and
is **refused with `409 CONFLICT` when any order ever referenced one of its option
keys.** `order_selections` stores `option_key` denormalized with no foreign key
([ADR-016](DECISIONS.md#adr-016--option_key-outlives-its-option-by-design)) so an
order survives its option being deleted — which means nothing in the schema
prevents a permanent delete from leaving an order line naming an option that no
longer exists. This check is that protection. It matches on key within the store
and includes already-deleted options, so a two-step delete cannot erase what a
one-step delete refuses.

It returns `200` with the counts removed rather than `204`: a merchant
confirming an irreversible act deserves to see its scope. The counts include
`items` — presentational headings and paragraphs belonging to the deleted groups.

**A delete and its cascade are one transaction.** The parent row and every child
it owns are marked in a single commit, so a failure cannot leave the children
deleted and the parent live. Concurrent deletes of the same resource all return
success and record **one** audit entry between them.

**`409 CONFLICT` can mean "try again".** Two transactions touching the same rows
in different orders are resolved by the database rolling one back. That surfaces
as a conflict rather than a `500`, because it is transient and a retry will
usually succeed.
| `POST /option-sets/:id/duplicate` | `option_sets:edit` | `[built]` |
| `POST /option-sets/:id/publish` | `option_sets:publish` | `[built]` |
| `GET /option-sets/:id/publish-check` | `option_sets:view` | `[built]` |
| `GET /option-sets/:id/versions` · `GET /option-sets/:id/versions/:version` | `option_sets:view` | `[built]` |
| `POST /option-sets/:id/rollback` | `option_sets:rollback` | `[built]` |
| `POST /option-sets/:id/reorder` | `option_sets:edit` | `[built]` |
| `GET /option-sets/:id/assignments` | `option_sets:view` | `[built]` |
| `POST /option-sets/:id/assignments` | `products:assign` | `[built]` |
| `DELETE /option-sets/:id/assignments/:externalProductId` | `products:assign` | `[built]` |

**`editor` can edit but cannot publish**, and that is the single most important
line in the permission matrix. Editing is safe; publishing changes a live
storefront and what customers are charged. An agency contractor should be able to
build an option set without pushing it live.

### `GET /v1/option-sets` **[built]**

Cursor-paginated. Filters: `status` (`draft` · `published` · `archived`),
`storeId`, `q` (name search).

**A filter cannot widen tenant scope.** The tenant predicate is merged *after* the
caller's filters, so a supplied `tenantId` is overwritten rather than honoured.

### `DELETE /v1/option-sets/:id` — soft and hard **[built] [7g]**

Two distinct operations, and the sketch has a route for only one.

**Soft delete** (default) hides the set and excludes it from published config.
Historic orders are unaffected, because `order_selections` stores keys
denormalised (ADR-016).

**Hard delete** (`?hard=true`) is permitted **only when no order has ever
referenced it**. It is a separate operation with a precondition, not a stronger
form of the same one.

**Errors:** `CONFLICT` (409) when an order references it — the message names the
count, because "you cannot delete this" without a reason is not actionable.

### `POST /v1/option-sets/:id/assignments` **[built]**

Which products an option set applies to
([M13.6](../../developePlan.md)) — the write half of the picker; `GET /products`
is the read half.

**The first place in the product that creates a `MANUAL` assignment.** Until
Phase 13 the only source was `demo.seed.ts`, which is why Phase 10's renderer had
nothing real to resolve.

```jsonc
// Request body
{ "externalProductIds": ["1042", "1043"] }   // WooCommerce ids, not ours

// → 200
{ "data": {
    "assignments": [ { "id": "0f3c…", "mode": "manual",
                       "targetType": "product", "targetRef": "1042",
                       "priority": 0,
                       "productName": "Custom Hoodie",   // null if not in the catalogue
                       "productStatus": "publish" } ],
    "configVersion": 8 } }
```

**`productName` and `productStatus` are joined from `store_products`**, added
2026-09-02 for [M13.6](../../developePlan.md). Without them a picker renders
`1042` where a merchant expects a product name, and it cannot be resolved
client-side: `GET /products` takes only `storeId`, `search`, `limit` and `cursor`
— **no id filter** — so naming N assignments would mean paging the whole
catalogue or making N searches.

Both are `null` when the product is not in `store_products`: either the catalogue
has not synced yet ([M19.1](../../developePlan.md)) or it was deleted upstream
after being assigned. A **`LEFT JOIN`**, deliberately — an inner one would hide
exactly the rows that need attention, and a merchant reading "assigned to 4
products" should know when one no longer exists.

⚠️ **The join is scoped by `storeId`, not by `targetRef` alone.** WooCommerce
numbers products from 1 on every install, so two shops routinely share ids; an
unscoped join returns the assignment **twice**, named from whichever store MySQL
orders first. Mutation-proven — and the first version of that test asserted only
the name and let the mutant through.

**`200`, not `201`.** The call is idempotent, so a repeat creates nothing and
claiming a resource was created would be false. `DELETE` takes the **WooCommerce**
product id in the path — not a UUID, so it is deliberately not parsed as one.

⚠️ **`mode` is not a field the caller supplies.** This endpoint writes `manual`
and `product` itself. Accepting the mode from a client would mean trusting it to
send the value the storefront requires, and a wrong one **does not fail loudly**:
`Config\ProductIndex` treats an unrecognised mode as neither `all` nor `manual`,
skips the assignment and counts it as deferred — so the option never renders,
with a skip counter as the only trace. `ALL` is a property of the set rather than
a product choice, and `CONDITIONAL` needs the rule tree Phase 17 will build.

**Every write advances `config_version`.** Assignments are a **live** read in the
storefront document rather than part of a published snapshot, so a write that did
not bump would leave every connected plugin serving a document it believes is
current — the option appearing only after some later, unrelated publish. Enforced
by `bin/check-config-invalidation.sh`, and mutation-proven.

**Idempotent, and the constraint is real.** `uq_assignments_set_target
(optionSetId, targetType, targetRef, deletedAt)` was added in Phase 13 Stage 0
(finding **A1**): the table previously had nothing unique, so the same set could
be assigned to the same product any number of times. The storefront survived it —
`ProductIndex` keys by product then set, so duplicates collapse — but the picker
would list the set twice and unassigning would remove one row while the option
kept rendering. The service skips products already assigned so that a double
submit, which is ordinary in a UI, never surfaces as a constraint violation the
merchant did not cause.

`deletedAt` is in the key because these rows are soft-deleted: without it,
re-assigning a product a merchant had previously unassigned would collide with
its own tombstone. **`ALL` assignments are not covered** — their target columns
are NULL and MySQL treats NULLs as distinct — which is acceptable because this
endpoint authors only `MANUAL`.

⚠️ **A product must exist in the set's own store** (finding **A3**). `targetRef`
holds a WooCommerce id and has **no foreign key**: the product lives on the
merchant's site, not in this database, so nothing in the schema stops a set being
assigned to a product belonging to another store — accepted, stored, and silently
never rendering, because the plugin indexes by an id that does not exist there.
The service checks `store_products` for that set's store before writing, and one
unknown id refuses the **whole** request rather than assigning part of it.

**Unassigning is a soft delete**, and only ever touches a live row. Unassigning
twice answers `404` and does not advance `config_version` — mutation-proven:
relaxing that filter let the second call match the tombstone and report success
for work it did not do.

### `POST /v1/option-sets/:id/publish` **[built]**

**Capability:** `option_sets:publish`. **Response:** `200 OK`

Publish is a transaction: validate the whole set, increment `version`, stamp
`published_at` and `published_by`, write an **immutable snapshot**, bump the
store's `config_version`, and trigger invalidation.

**Pre-publish checks are surfaced before the button, not as errors after it.**
`GET /option-sets/:id/publish-check` returns what would block or warn:

- options with no values
- required options hidden by their own rule
- pricing referencing a removed value
- rules pointing at deleted targets
- a set with no product assignment — publishing to nothing

> **Two validators are named but not implemented in Phase 7.** M7.4 says publish
> validates "including M17.3 cycle detection and M14.4 regex complexity". Both are
> later phases. They are **registered extension points**, so Phase 14 and Phase 17
> add a validator to a list rather than reopening the publish transaction.

> **Two of the five checks above are also deferred, and for different reasons.**
> *"Required options hidden by their own rule"* needs rule **evaluation**, which
> is M17.3. *"Pricing referencing a removed value"* has no subject: no registered
> pricing schema names a value id, so there is nothing to dangle until a type that
> does exists. The three that run today — options with no values, rules whose
> target was deleted, and a set assigned to nothing — are joined by a fourth this
> phase added: a set with no enabled options at all.
>
> Findings carry a `severity`. A **blocker** refuses the publish (`400`); a
> **warning** does not, and is recorded in the audit trail by code, so "did anyone
> know this went live unassigned?" is answerable afterwards.

**Publish is serialized per option set.** Two simultaneous publishes must not
interleave into a half-built snapshot; the second waits and then sees the first's
version.

**Errors:** `VALIDATION_FAILED` (400) with per-item detail; `VERSION_MISMATCH`
(409) if the draft changed since it was loaded; `INSUFFICIENT_ROLE` (403).

### `POST /v1/option-sets/:id/rollback` **[built]**

```jsonc
{ "version": 5, "note": "reverting the holiday pricing" }
```

**Rollback publishes a prior snapshot as a new version rather than rewriting
history.** Version 8 rolling back to 5 produces version 9 whose content matches 5.
Rewriting would make the audit trail a lie, and the merchant who needs rollback at
9pm is exactly the one who will later need to know what happened.

**⚠️ Rollback restores what storefronts receive, not what the editor shows.**
The snapshot becomes the published document; the live rows — the working draft —
are left exactly as they are. Those are different things: a rollback that
overwrote the draft would destroy the edits a merchant was making when they hit
the problem, which is the work they are least willing to lose. A dashboard should
say so, because an editor that looks unchanged after a rollback otherwise reads
as a rollback that failed.

It carries `rowVersion` like every other write. A merchant picks a version from a
history list, and a list that went stale while it was on screen means reverting on
the strength of something that has since changed.

**Errors:** `NOT_FOUND` (404) for an unknown version; `VERSION_MISMATCH` (409) if
the set changed since the history was loaded; `INSUFFICIENT_ROLE` (403).

`GET /option-sets/:id/versions` lists history newest first **without** snapshots,
which are large and rarely all wanted at once.
`GET /option-sets/:id/versions/:version` returns one snapshot exactly as the
storefront received it — the read M7.4's "diff any version against the current
draft" needs, and the reason a merchant can see what they are rolling back to
before they do it.

**Rollback does not restore the live rows.** It changes what storefronts
receive, not what the editor shows. Those are different things by design: a
rollback that silently overwrote the working draft would destroy the edits a
merchant was making when they hit the problem they are rolling back from.

**Three of M7.4's five pre-publish checks run today.** *"Required options hidden
by their own rule"* needs rule evaluation (M17.3), and *"pricing referencing a
removed value"* has no subject — no pricing schema in the registry names a value
id. Both arrive by appending to `PUBLISH_VALIDATORS`, which is what makes the
extension point real rather than promised. Two further checks not in M7.4's list
are included: a set with no enabled options blocks, and a set assigned to nothing
warns.

---

## GROUPS · OPTIONS · VALUES

**Realm:** tenant. Nested resources whose paths do **not** name a tenant — scoping
is entirely the data layer's job, which is why the parent-scoped repository is
built before any of these endpoints.

| Route | Capability | State |
|---|---|---|
| `POST /option-sets/:id/groups` · `PATCH /groups/:id` · `DELETE /groups/:id` | `option_sets:edit` / `:delete` | `[built]` |
| `POST /groups/:id/options` · `PATCH /options/:id` · `DELETE /options/:id` | `option_sets:edit` / `:delete` | `[built]` |
| `POST /options/:id/values` · `PATCH /values/:id` · `DELETE /values/:id` | `option_sets:edit` / `:delete` | `[built]` |
| `POST /groups/:id/duplicate` · `POST /options/:id/duplicate` · `POST /values/:id/duplicate` | `option_sets:edit` | `[built]` |
| `POST /groups/:id/reorder` · `POST /options/:id/reorder` | `option_sets:edit` | `[built]` |
| `GET /option-sets/:id/groups` · `GET /groups/:id/options` · `GET /options/:id/values` | `option_sets:view` | `[built]` |
| `GET /groups/:id` · `GET /options/:id` · `GET /values/:id` | `option_sets:view` | `[built]` |
| `POST /groups/:id/items` · `PATCH /items/:id` · `DELETE /items/:id` | `option_sets:edit` | `[built]` |
| `POST /groups/:id/items/reorder` | `option_sets:edit` | `[built]` |
| `GET /groups/:id/items` · `GET /items/:id` | `option_sets:view` | `[built]` |
| `POST /option-sets/:id/rules` · `PATCH /rules/:id` · `DELETE /rules/:id` | `option_sets:edit` | `[built]` |
| `POST /option-sets/:id/rules/reorder` | `option_sets:edit` | `[built]` |
| `GET /option-sets/:id/rules` · `GET /rules/:id` | `option_sets:view` | `[built]` |
| `POST /option-sets/:id/rules/test` | `option_sets:view` | `[built]` |

> **`rules/test` is a read, and `option_sets:view` is deliberate.** It answers
> *"what would a customer see, given these answers?"* — nothing is stored,
> nothing is charged — so a viewer may test what an editor authored. It reads the
> merchant's **draft**, not the published snapshot, because a rule being tested
> has usually not been published yet (ADR-053).
>
> ⚠️ **`POST` for a request that mutates nothing.** The answers map can carry an
> operand up to 5000 characters against any number of options, past what a query
> string should hold.
>
> **Rules are nested under the SET, not a group.** A rule's conditions may name
> options in any group, and its target may be a group, an option or a value
> anywhere in the set — so a group is the wrong parent, and nesting under one
> would imply a scope the engine does not have.
>
> `conditions` is a **flat array** of `{ optionId, operator, value? }`, with
> `matchType` (`all` | `any`) as a sibling field rather than a key inside it.
> Nine operators; three operand shapes — `is_empty` / `is_not_empty` take none,
> `in` / `not_in` take a list, the rest take a single value whose type the
> operator decides. `greater_than` and `less_than` require a **number**, and
> `contains` a **string**: text has no ordering two languages agree on, and
> `contains 1` would otherwise match the answer `"10"`.
>
> ⚠️ **`sortOrder` is presentation, not precedence.** M17.2 makes evaluation
> order-independent; the order here decides what a merchant reads in the rule
> list and nothing else.
>
> ⚠️ **A rule cannot move between sets.** `targetId` and every condition's
> `optionId` name rows in the set the rule was created in, so `PATCH` accepts no
> `optionSetId`. `isEnabled` is not accepted either — its only writer today is
> the cascade, recording that a target was deleted.

> **Presentational items carry `option_sets:edit` for deletion too**, unlike
> their siblings above, which split `:edit` from `:delete`. That is deliberate and
> recorded on the controller: an item is part of an option set's authored content,
> and someone trusted to add a price-bearing option is not separately untrusted
> with a heading above it.
>
> They were absent from this table for the whole of Phase 14 — the routes shipped
> and the contract was never updated, so `check-openapi` failed on every run.
> A gate that is always red is a gate everyone learns to ignore, which is worse
> than not having it.

> **Reads were missing from this table** until the routes were built and
> `check-api-contract.sh` refused them. The sketch listed only mutations, but a
> dashboard cannot render an editor without fetching what it is editing, and a
> child cannot be loaded through its set alone once it is addressable by id.
> They are listed as their own rows because they carry `:view`, not `:edit` —
> the capability split is the point.

**No pagination on these lists.** A set's groups, a group's options and an
option's values are bounded by what a merchant can usefully build and are always
fetched whole by the editor. A cursor here would add a round trip to every render
for a page size no real set reaches.

That bound is **enforced**, not assumed: 100 groups per set, 200 options per
group, 500 values per option. Exceeding one is `400 VALIDATION_FAILED` with
`LIMIT_REACHED`. These are structural ceilings that protect an unpaginated list
and a subtree copied inside one transaction — not plan quotas, which are
Phase 22 and answer `PLAN_LIMIT_EXCEEDED` instead.

**Keys collide two ways.** A key already in use answers `400 VALIDATION_FAILED`
with `DUPLICATE_KEY`. When two requests race — both pass the check, both insert —
the database constraint decides, and the loser gets `409 CONFLICT` with the same
`DUPLICATE_KEY` detail. A client may retry the 409; the 400 will not succeed on
retry. Neither response echoes the colliding value.

> **Duplicate and reorder exist at every level**, not only for option sets. M7.2
> says the lifecycle operation set is "inherited by groups, options, and values
> alike", and deep-copying a group with its options and values is what a merchant
> building variants actually wants. The sketch lists duplicate only for option
> sets and reorder only for groups.
>
> This note previously claimed duplicate existed at every level while no
> `POST /values/:id/duplicate` was documented or built, and reorder existed only
> for groups — so a merchant could rearrange groups but not the options inside
> one, or the values a customer reads in order. Both were found auditing the
> phase against M7.2's table rather than against the contract, which had
> inherited the same gap.

A value's copy is **never the default**: two defaults on one option is a state no
storefront can render, and a copy silently claiming it would change which value
is pre-selected.

### Enable and disable

A soft toggle, **distinct from soft delete**, exposed as `isEnabled` on `PATCH`.
Disabled items are retained and excluded from published config — the escape hatch
for "turn this off for the holidays" without losing the work.

`deleted_at` cannot serve this: one hides permanently and is a cleanup action, the
other is reversible and expected to be undone.

### `key` immutability

An option's `key` is **immutable once that option has been published**. Not once
the *set* has — an option added to a published set has never itself been published,
and its key is still free.

`order_selections` stores `option_key` denormalised, so a mutable key makes every
historic order unreadable. Labels change freely because they are snapshotted per
order (M12.1).

**Errors:** `CONFLICT` (409) on an attempt to change a published key.

### Cascade on delete

Stated explicitly rather than inherited from the ORM:

```text
delete option_set   → soft-deletes groups, options, values, rules, assignments
delete group        → soft-deletes its options; rules targeting it are disabled + flagged
delete option       → soft-deletes its values; rules referencing it are disabled + flagged
delete value        → BLOCKED if it is the target of an enabled rule
```

**A rule left pointing at a deleted target is disabled and surfaced to the
merchant** — never silently dropped, never left to fail at evaluation time. The
fourth rule *refuses* the delete, and is the one most likely to be omitted because
it is the only one that fails rather than cascades.

### `POST /v1/option-sets/:id/reorder` **[built]**

Bulk, gap-tolerant integers, so a single move is one write rather than renumbering
every sibling.

```jsonc
{ "groups": [{ "id": "…", "sortOrder": 10 }, { "id": "…", "sortOrder": 20 }] }
```

---

## CONNECTION — `/v1/connect/*`

**Implements:** [AC8](../../developePlan.md) — no SaaS secret ever ships inside the
plugin. Every installation is treated as potentially hostile.

| Route | Realm | Capability | State |
|---|---|---|---|
| `POST /connect/initiate` | none — `@Public()` | — | `[built]` |
| `POST /connect/requests/describe` | tenant | `stores:connect` | `[built]` |
| `POST /connect/authorize` | tenant | `stores:connect` | `[built]` |
| `POST /connect/exchange` | none — `@Public()` | — | `[built]` |

### Four decisions, settled here

The handshake in [M8.1](../../developePlan.md) is a sketch. Four things it leaves
open change the shape of the phase, and each is decided below with its reasoning
so a reader can disagree with the argument rather than guess at the intent.

**1. The cloud returns the redirect URL; the plugin does not build it.**
`initiate` takes the site's parameters and returns `authorize_url` complete. The
alternative — the plugin assembling `app.optionia.com/connect?…` itself — bakes
the cloud's URL shape into software installed on thousands of merchant sites that
**cannot be redeployed**. Renaming a query parameter would then be impossible.
This is the decision that makes `initiate` an endpoint rather than a constant.

**2. `state` is opaque to the cloud: hashed at rest, echoed through the browser.**
The plugin generates it, the cloud stores only `SHA-256(state)`, and the plaintext
travels `authorize_url` → dashboard → `authorize` → callback. The plugin compares
what returns against what it kept. That is the CSRF defence, and it works *because*
the cloud cannot influence the value.

M8.1's acceptance requires the code be "bound to `state`", and the binding is to
the hash — so a database dump yields no usable token, and `exchange` still verifies
the binding.

**3. PKCE is S256 only. There is no `plain` fallback.**
The plugin requires PHP 7.4+, where `hash('sha256', …)` is always available.
`plain` exists in the OAuth spec for constrained clients that cannot hash;
WordPress is not one. Offering both lets an attacker choose the weaker.

**4. `authorize` returns JSON, not a 302.**
The dashboard is a single-page app holding a tenant JWT in memory. A 302 would be
followed by `fetch` and never seen by the application, and a JWT cannot ride a
browser redirect. It returns `{ redirect_url }` and the dashboard navigates
deliberately — consistent with every other tenant-realm endpoint.

### Two lifetimes, and why they differ

| Artefact | Lives | Single-use |
|---|---|---|
| **Connection request** | 30 minutes | yes |
| **Authorization code** | 5 minutes | yes |

**The code is 5 minutes** — [M8.1](../../developePlan.md)'s acceptance, and the
reason is the window an intercepted code is useful in. Redemption is
machine-to-machine and takes milliseconds; five minutes is generous for a retry
after a network failure and short enough that a code captured from a redirect
URL, a browser history or a proxy log is almost always already dead.

**The request is 30 minutes** because a human is in the middle of it. A merchant
who clicks *Connect* may have no account yet: they sign up, verify an email,
possibly read the approval screen twice. Five minutes would fail that merchant
routinely, and a connection flow that times out while someone reads it produces
exactly the support ticket [M8.1b](../../developePlan.md) describes.

The two differ because the threat differs: a pending *request* grants nothing —
approving it still requires signing in as a tenant member — while a *code* is
one exchange away from a credential.

An expired request answers `TOKEN_INVALID` from `authorize`; an expired code
answers the same from `exchange`. Both move the store to `DISCONNECTED` if it
reached `CONNECTING`.

### Why two routes are unauthenticated

Authentication is **global opt-out**: a route is protected unless it carries
`@Public()`. `initiate` and `exchange` are the only unauthenticated endpoints in
the API outside `/auth/*`, which needs justifying rather than assuming.

`initiate` is called by a plugin that **holds no credential yet** — that is the
point of the handshake. It creates nothing durable, stores nothing, and returns
only a URL. Its defence is rate limiting.

`exchange` is called server-to-server by the plugin, and **the code is the
credential**. Its defences are the four M8.1 requires: single-use, ≤5 minutes,
bound to `site_url`, and bound to a `state` hash — plus the PKCE verifier, which
is what stops an intercepted code being redeemed by anyone but its originator.

---

### `POST /v1/connect/initiate` **[built]**

Begins a connection. Called by the plugin when a merchant clicks *Connect
Optionia*, before any credential exists.

**Rate limit:** 10 per hour, per site URL — a merchant retries a failed connection
a handful of times; a script does not.
**Response:** `200 OK`

```jsonc
// Request
{ "site_url": "https://shop.example.com",
  "callback": "https://shop.example.com/wp-admin/admin.php?page=optionia-connect",
  "push_url": "https://shop.example.com/wp-json/optionia/v1/push",  // optional
  "state": "…",              // opaque, plugin-generated
  "challenge": "…",          // base64url(SHA-256(verifier))
  "plugin_version": "1.0.0" }

// Response
{ "data": { "authorize_url": "https://app.optionia.com/connect?request=01a0…&state=…" } }
```

| Field | Rules |
|---|---|
| `site_url` | absolute `https://` URL, ≤ 255 chars. **`http://` is refused** — a credential must never cross a plaintext connection |
| `callback` | absolute URL whose origin **equals** `site_url`'s; ≤ 500 chars |
| `push_url` | optional; same rules as `callback`. The plugin's REST route, stored on the store |
| `state` | 43–128 chars, URL-safe. Stored as a SHA-256 hash; the plaintext is echoed, never persisted |
| `challenge` | 43 chars, base64url — exactly one SHA-256 digest |
| `plugin_version` | semver, ≤ 20 chars |

**The callback must share the site's origin.** Accepting an arbitrary callback
would let an attacker start a connection for someone else's shop and have the
code delivered to a host they control.

**`push_url` is a different URL from `callback`, and held to the same rule for a
longer-lived reason.** `callback` is a *browser* redirect to a WordPress admin
screen — a server posting there reaches a login page, not the plugin. `push_url`
is the plugin's own REST route, which authenticates by signature rather than by
session, and it is stored on the store rather than expiring with the handshake.
So an attacker who slipped in their own host would not intercept a single code:
they would be told whenever that merchant publishes, indefinitely.

It is **optional**. A plugin build predating the route still connects, and a
store without one falls back to the fifteen-minute conditional pull
([M9.3](../../developePlan.md)) — behind by minutes rather than broken. It is
refreshed on every reconnect, because reconnecting is exactly when a merchant
has upgraded the plugin, and because a site that moved address sends a different
URL that must replace the stale one.

**`authorize_url` carries `state` back, and that is deliberate.** The cloud stores
only `SHA-256(state)`, so it cannot reconstruct the plaintext to put in the final
redirect — and the plugin must receive its original `state` on the callback or it
cannot verify the response is the one it started.

Carrying it through the browser exposes nothing new: the value is already destined
for that browser, arriving on the callback URL either way. What matters is that it
never reaches the database in a readable form, so a dump of `store_connection_codes`
yields no usable CSRF token.

> An earlier draft said `state` is "never stored in plaintext" while `authorize`
> returned "the merchant's original `state`" from a body carrying only a request
> id. Both cannot be true — the cloud had no source for the plaintext. Found while
> analysing what `[8b]`'s table must hold, which is the point of settling a schema
> against a contract rather than alongside it.

**Errors:** `VALIDATION_FAILED`, `RATE_LIMITED`.

---

### `POST /v1/connect/requests/describe` **[built]**

What a pending connection request is asking for, so the approval screen can name
the site ([M13.3](../../developePlan.md)). **Rate limit:** 60 per hour.

```jsonc
// Request — the same two fields `authorize` takes
{ "request": "0f3c…", "state": "…" }

// → 200
{ "data": { "site_url": "https://acme.example",
            "plugin_version": "1.0.0",
            "expires_at": "2026-09-02T07:30:00.000Z" } }
```

🔴 **Added 2026-09-02.** `authorize` took `{request, state}` and returned
`{redirect_url}`, and nothing exposed the `siteUrl` the row had held all along —
so the approval screen could only ask *"approve this?"* without saying **what**,
on a screen whose entire purpose is consent. A merchant handed a link would
approve a connection to a site they could not see named.

⚠️ **`state` is required, and it is what makes this safe.** A pending request has
**no tenant** — `tenantId` is written at `authorize`, not at `initiate` — so the
tenant scoping every other read relies on cannot apply here. Keyed on the id
alone, this would be a **UUID-guessable oracle returning merchants' site URLs**
to any signed-in user. The `state` (43–128 base64url, stored only as a hash,
compared with `tokensMatch()`) is the credential that closes it.

⚠️ **A `POST` that writes nothing.** The verb describes the *input*, not the
effect: a secret in a query string lands in browser history, `Referer` headers
and server logs. Calling this does not consume the request — a merchant may
reload the approval screen, and only `authorize` claims it.

**Every refusal is the same `404`**, with a body that never names a site: unknown,
expired, already approved and wrong `state` are indistinguishable. Distinguishing
them would restore the enumeration this shape prevents — and unlike `authorize`,
this endpoint *returns data*, so the prize for a correct guess is a merchant's
URL. Mutation-proven: removing the state, expiry or approved checks each fails
the suite.

### `POST /v1/connect/authorize` **[built]**

The merchant, signed in to the dashboard, approves connecting a site to their
tenant. This is the only step with a human in it.

**Realm:** tenant. **Capability:** `stores:connect`.
**Rate limit:** 30 per hour, per tenant — a merchant approves a handful of stores;
a script enumerating request ids does not.
**Response:** `200 OK`

```jsonc
// Request
{ "request": "01a0…",        // the id from `authorize_url`
  "state": "…" }             // echoed from `authorize_url`, verified against its hash

// Response
{ "data": { "redirect_url": "https://shop.example.com/wp-admin/…?code=…&state=…" } }
```

| Field | Rules |
|---|---|
| `request` | UUID. Must be pending, unexpired, and not already approved |
| `state` | must hash to the value stored at `initiate` — a mismatch is `TOKEN_INVALID` |

Creates the store in `CONNECTING` and issues a one-time authorization code. The
`redirect_url` carries the code and the `state` the dashboard read from
`authorize_url` — the cloud holds only its hash and cannot produce it otherwise.

**Reconnecting an existing site reuses its store row.** `uq_stores_tenant_url` is
`(tenant_id, store_url)`, and reconnection is a *normal* path, not an error:
[M8.1b](../../developePlan.md)'s state machine runs `REVOKED → DISCONNECTED →
CONNECTING`, and the plan reaches it after a revocation, a site-URL change and a
credential rotation. A tenant re-approving a site they already hold therefore
moves that row back to `CONNECTING` rather than inserting a second one.

The alternative — `409 CONFLICT` — was rejected because it makes the recovery
path an error state. A merchant told to reconnect, who reconnects, would be told
they cannot. Reuse also preserves `store_id`, so a reconnected store keeps its
history, its analytics and any rows referencing it; a new row would silently
orphan all three.

⚠️ **Reuse is per tenant, and that is the security boundary.** The same URL under
a *different* tenant is a different store, which `uq_stores_tenant_url` already
permits — an agency and its client legitimately hold the same address. What must
never happen is one tenant's `authorize` reaching another tenant's row, so the
lookup is by `(tenant_id, store_url)` and never by URL alone.

**A pending request is single-use and lives 30 minutes.** Approving twice must not
mint two codes — the second call answers `TOKEN_INVALID`.

**Which capability.** `stores:connect` rather than `option_sets:edit`: connecting
a storefront is an ownership act, and an editor who can build options should not
be able to attach the workspace to a site they control. Held by owner and admin —
the permission matrix from [M6.5](../../developePlan.md) already drew that line,
and rotation carries its own `stores:rotate_credential` for the same reason.

**Audited** as `store.connect_authorized`, with the store and the site URL. The
merchant is a real actor in a real tenant, so the entry is scoped and queryable
like any other.

`initiate` is **not** audited, and the reason is structural rather than an
omission: it is `@Public()` and carries no tenant, while `audit_logs` is read
through a tenant-scoped query. An entry with a null tenant would be invisible to
every consumer — a row written to satisfy a rule nobody can read. M8.1b's "every
transition is logged" is therefore read as every transition **of a store**, and a
pending request is not yet a store: nothing exists to transition until `authorize`
creates or reuses one.

**Errors:** `VALIDATION_FAILED`, `TOKEN_INVALID` (unknown, spent or expired
request), `INSUFFICIENT_ROLE`, `RATE_LIMITED`.

---

### `POST /v1/connect/exchange` **[built]**

The plugin redeems its code for a store credential, server-to-server. The browser
is not involved.

**Rate limit:** 20 per hour, per site URL.
**Response:** `200 OK`

```jsonc
// Request
{ "code": "…", "verifier": "…", "site_url": "https://shop.example.com" }

// Response
{ "data": { "token": "osk_live_…",        // shown once, never recoverable
            "store_id": "01a0…",
            "tenant_name": "Sam's Store",
            "config_version": 0 } }
```

| Field | Rules |
|---|---|
| `code` | 43–128 chars, URL-safe |
| `verifier` | 43–128 chars — `base64url(SHA-256(verifier))` must equal the stored challenge |
| `site_url` | must equal the URL the code was issued for, **exactly after normalisation** |

**The code lives 5 minutes and is spent on first use** —
[M8.1](../../developePlan.md)'s acceptance in full: single-use, short-lived, bound
to `site_url`, and bound to a hash of `state`.

**"Exactly" means after the same normalisation `initiate` applied**, and the
distinction is the difference between a working flow and one that never succeeds.
`initiate` stores `store_connection_codes.site_url` normalised — lowercased host,
no trailing slash — while the plugin sends WordPress's `home_url( '/' )`, which
carries the slash (`Api/Client.php`). A literal byte comparison would therefore
refuse **every honest first exchange**:

```text
plugin sends   https://shop.example.com/
initiate stored https://shop.example.com     → raw equality: false
```

Both sides normalise before comparing. The binding is still exact — a different
host, scheme or port is still a refusal — it is exact between two values reduced
the same way. This is the third place the same rule appears, after `initiate`'s
callback-origin check and `[8i]`'s `X-Optionia-Site` comparison; it is one rule,
not three.

**The token carries a visible `osk_live_` prefix, and `token_prefix` stores the
eight characters *after* it.**

A constant prefix makes a leaked credential recognisable on sight and lets secret
scanners match it, which is worth the nine characters. But it cannot also be what
`store_credentials.token_prefix` holds: that column is `CHAR(8)` and exists "for
support identification", and the first eight characters of every token would then
be `osk_live` — identical for every credential in the system, identifying nothing.

So the two serve different purposes and hold different things: the token reads
`osk_live_<43 chars>`, and `token_prefix` holds the first eight characters of the
random part. Support can still ask "which credential ends in…" and get an answer
that discriminates.

**Every check is a refusal, and they are indistinguishable.** A spent code, an
expired one, a wrong verifier, a mismatched `site_url` — all answer
`TOKEN_INVALID` with the same message. Telling an attacker which of four
conditions they failed tells them what to fix.

**The token is returned once.** `store_credentials` holds only a SHA-256 hash and
an 8-character prefix for support identification. A merchant who loses it rotates;
they do not recover it.

**The store moves `CONNECTING` → `CONNECTED`** in the same transaction that spends
the code, so a failure cannot leave a store connected with no credential or a
credential with no store.

**Audited** as `store.connected`, with an **explicit tenant**. `exchange` is
`@Public()` and so has no tenant in context — but unlike `initiate`, the tenant is
*knowable*: `store_connection_codes.tenant_id` was set when the merchant approved.
The entry names it directly, so a completed connection is visible to the
tenant-scoped audit query like every other transition. `initiate` remains
unaudited because at that point no tenant exists to name.

**Errors:** `VALIDATION_FAILED`, `TOKEN_INVALID`, `RATE_LIMITED`.

---

## STORES — `/v1/stores/*`

**Realm:** tenant.

| Route | Capability | State |
|---|---|---|
| `GET /stores` | `stores:view` | `[built]` |
| `GET /stores/:id` | `stores:view` | `[built]` |
| `POST /stores/:id/disconnect` | `stores:connect` | `[built]` |
| `POST /stores/:id/rotate-credential` | `stores:rotate_credential` | `[built]` |

> Product listing still belongs to Phase 19 and stays in the deferred table: a
> contract row is a commitment to a shape, and that one is not known yet.

### `GET /v1/stores` and `GET /v1/stores/:id` **[built]**

The dashboard's store screen ([M13.3](../../developePlan.md)): which stores a
tenant has connected, and whether each is healthy.

**`stores:view`, not `stores:connect`.** Added in Phase 13 Stage 0 alongside
`products:view`. Seeing that a store went quiet three days ago is the question
support asks first, and it should not require the capability to disconnect one.
Granted to `owner`, `admin`, `editor` and `viewer`; **not** to `billing`.

```jsonc
// GET /v1/stores → 200
{ "data": [ {
    "id": "0f3c…", "name": "Acme Hoodies",
    "storeUrl": "https://acme.example",
    "status": "connected",
    "connectedAt": "2026-08-30T10:00:00.000Z",
    "lastSeenAt":  "2026-09-02T08:14:00.000Z",   // null = never checked in
    "configVersion": 7,
    "pluginVersion": "1.0.0", "wpVersion": "6.5",
    "wcVersion": "11.0.1",    "phpVersion": "8.4"
} ] }
```

⚠️ **Every field is named in code, and the entity is never returned.** `stores`
also carries `pushUrl` — a merchant-supplied callback URL with no screen to
appear on — and `tenantId`, which the caller already knows. Neither is a secret
(credentials live in `store_credentials`, so no token can leak this way), but
returning a row wholesale is how a column added in a later phase becomes part of
a public response nobody decided to publish. `StoresService.toSummary()` is the
allow-list, written as a function rather than an entity decorator so the decision
is visible where the query is.

**`lastSeenAt: null` means never**, which is not the same as stale. A store
connected an hour ago whose plugin has not yet run its daily heartbeat is
healthy; the dashboard must not render "last seen: never" as a fault.

**Unpaginated, deliberately.** A tenant has a handful of stores and plan tiers cap
them; a cursor here would be paging a list that fits on one screen.

**Another tenant's id answers `404`, not `403`** — the same answer as an id that
does not exist, so a caller cannot walk ids to learn what belongs to someone else
(ADR-010). Proven in `isolation-matrix.e2e-spec`, and the collection's leakage
test is mutation-proven: unscoping the repository fails it.

### `POST /v1/stores/:id/disconnect` **[built]**

The merchant disconnects a store from the dashboard. Revokes every live credential
and moves the store to `DISCONNECTED`.

**Rate limit:** 20 per hour, per tenant. Tighter than the global default because
this is a destructive ownership act, not a read.
**Response:** `200 OK`

```jsonc
// Request — no body. The store is named by the path.
// Response
{ "data": { "status": "disconnected", "credentials_revoked": 1 } }
```

**The storefront keeps working.** Revocation stops the plugin receiving *new*
configuration; it does not stop it serving the copy it already has
([AC3](../../developePlan.md)). A merchant who disconnects by accident loses the
ability to publish, not their shop.

**Idempotent.** Disconnecting an already-disconnected store answers `200` with
`credentials_revoked: 0`. A merchant clicking twice is not an error.

**Errors:** `NOT_FOUND` (unknown, or another tenant's), `INSUFFICIENT_ROLE`.

---

### `POST /v1/stores/:id/rotate-credential` **[built]**

Issues a new credential and revokes the old one. For a merchant who believes their
token leaked, and for scheduled rotation.

**Rate limit:** 20 per hour, per tenant — same reasoning as `disconnect`: each
rotation invalidates a live credential.
**Response:** `200 OK`

```jsonc
// Request — the body is optional; an empty body is valid.
{ "reason": "suspected disclosure" }

// Response
{ "data": { "token": "osk_live_…", "prefix": "7Kd2mQ8x", "rotated_at": "…" } }
```

| Field | Rules |
|---|---|
| `reason` | optional, ≤ 255 chars. Recorded in the audit trail |

**`prefix` is the eight characters *after* `osk_live_`, not the marker itself.**
An earlier example here showed `"osk_live"`, which was written before `[8e]`
settled the question and is the opposite of what the column means: every
credential begins with the same nine characters, so storing those would make
`store_credentials.token_prefix` a constant that identifies nothing. The marker
exists to make a leaked token recognisable; the prefix exists to tell two tokens
apart.

**Where the reason is read** is deferred to [Phase 26](../../developePlan.md), with
the rest of the audit trail. An earlier draft promised it "shown to the merchant in
the store's history" — no such route exists in Phase 8 or is planned in any of its
remaining steps, so that was a promise with no owner. The reason *is* captured, on
the audit entry, and the surface that displays it arrives with the audit reader.

**The old credential is revoked immediately, not at a grace period.** A rotation a
merchant asked for because they think the token leaked must take effect at once;
a window in which both work is a window in which the leaked one still works.

The plugin's next request answers `401` and it surfaces a reconnect notice —
[M8.6](../../developePlan.md)'s path, and the storefront keeps serving cache
throughout.

**Which states may rotate.** `CONNECTED` and `ERROR`.

`ERROR` is included deliberately, and the distinction matters: an erroring store
**still holds a live credential** — it reached `ERROR` from `CONNECTED` on a sync
or auth failure and nothing revokes on the way in, which is why
[M8.1b](../../developePlan.md) has it keep serving cache and recover to
`CONNECTED`. A merchant whose store is erroring, who suspects that error *is* a
compromised token, is exactly the person this endpoint exists for. Refusing them
would make the security feature unavailable in the one state that most suggests
it is needed.

`DISCONNECTED`, `REVOKED` and `CONNECTING` are refused because they hold no live
credential to replace: the first two had theirs revoked, and the third has not
been issued one yet. For those the answer is to connect, not to rotate.

**Errors:** `NOT_FOUND`, `INSUFFICIENT_ROLE`, `CONFLICT` (the store holds no live
credential to rotate).

---

## PRODUCTS — `/v1/products`

**Realm:** tenant.

| Route | Capability | State |
|---|---|---|
| `GET /products` | `products:view` | `[built]` |

### `GET /v1/products` **[built]**

The merchant's catalogue, for the assignment picker
([M13.6](../../developePlan.md)).

**Read-only, and permanently so.** `store_products` mirrors the merchant's
WooCommerce store: it is filled by [M19.1](../../developePlan.md)'s import and
refreshed by its sync. A dashboard that could edit it would be editing a copy —
the change would survive until the next sync and then vanish, which is worse than
not offering it.

**`products:view`, not `products:assign`.** Added in Phase 13 Stage 0 alongside
`stores:view`. Browsing a catalogue is not assigning to it, and `editor` already
held `products:assign` — permission to assign an option set to a catalogue it had
no permission to list. Granted to `owner`, `admin`, `editor` and `viewer`; **not**
to `billing`.

```jsonc
// GET /v1/products?storeId=<uuid>&search=Custom&limit=25&cursor=…
{ "data": [ {
    "id": "0f3c…",              // ours, stable across a sync
    "externalId": "1042",       // WooCommerce's — what an assignment stores
    "name": "Custom Hoodie", "sku": "HOOD-1",
    "type": "simple", "priceMinor": 8000, "status": "publish",
    "permalink": "https://acme.example/?p=1042", "imageUrl": null
  } ],
  "meta": { "pagination": { "cursor": "NDE6…", "hasMore": true, "limit": 25 } } }
```

| Field | Rules |
|---|---|
| `storeId` | **required**, uuid |
| `search` | ≤ 255 chars, matched as a **prefix** |
| `limit` | 1–100, default 25 |
| `cursor` | opaque, ≤ 512 chars. Clients must not construct one |

**`storeId` is required, deliberately.** A tenant may own several stores, and
merging their catalogues would present two products with the same name on two
storefronts as though they were interchangeable.

**Paged by `(name, id)`, not `(createdAt, id)`.** `ix_store_products_search
(storeId, name)` is the only useful index here: paging on `createdAt` would
filesort the whole catalogue for every page and present products in import order,
which is not an order a merchant can navigate. `id` breaks ties because two
products may share a name, and a keyset needs a total order — a name-only cursor
asks for `name > 'Custom Hoodie'` and **skips the second copy** when a page
boundary falls between them. Mutation-proven.

The cursor is a sibling of the timestamp one in `common/pagination`, keyed on
text. Its value is **length-prefixed** rather than delimited: a product named
`Shirt | Large` would break a `value|id` split, and the resulting cursor would
silently page from the wrong row.

⚠️ **The search is a prefix match**, because `LIKE 'term%'` uses the index and
`LIKE '%term%'` cannot. At the 30 products the seed creates the difference is
invisible, and nothing larger exists until M19.1 imports a real catalogue.
Recorded as finding **A4** of Phase 13 Stage 0: the day this needs substring
search is the day it needs a `FULLTEXT` index, which is a migration rather than a
different `LIKE` pattern.

**Wildcards in merchant input are escaped.** A search for `100%` means the
characters `100%`, not "everything" — `%`, `_` and `\` are neutralised before the
pattern is built.

**Scoped by a join, not a column.** `store_products` carries no `tenantId`; it
reaches one only through `stores`. A foreign `storeId` therefore answers `200`
with an **empty list** rather than `404` — the join eliminates every row, which is
not the same as the store being absent, and claiming `404` would state a contract
the code does not implement. Proven in `isolation-matrix.e2e-spec` and
mutation-proven by dropping the join.

## STORE — `/v1/store/*`

**Realm:** store. **Guard:** `StoreTokenGuard`.

| Route | State |
|---|---|
| `POST /store/heartbeat` | `[built]` |
| `POST /store/disconnect` | `[built]` |
| `GET /store/config` | `[built]` |
| `POST /store/orders` | `[built]` |

> **A store credential is an opaque token, not a JWT.** `store_credentials` stores
> a SHA-256 hash and an 8-character prefix; the plaintext exists only in the
> plugin. That is deliberate: [M8.6](../../developePlan.md) requires revocation to
> be *immediate*, and a JWT cannot be un-issued — a revoked store would keep
> working until expiry.
>
> `TokenAudience.STORE` existed in the JWT audience enum from Phase 6 and
> contradicted this decision by implying a store presents a JWT. **Removed in
> `[8c]`.** `PLATFORM` stays: it is a real JWT audience whose routes arrive in
> Phase 26, so one was waiting and the other was wrong.

### `StoreTokenGuard` **[8c]**

**Credential:** `Authorization: Bearer <token>` — the same header shape as a
tenant JWT carrying a different kind of secret. The plugin already ships this
(`Api/Client.php`), and under [M7.7](../../developePlan.md) an installed plugin
cannot be redeployed, so the cloud adapts to the header rather than choosing one.

The guard resolves the credential by `SHA-256`, joins to `stores` for the tenant
the credential does not carry, and checks three columns:

| Check | Rule |
|---|---|
| `revoked_at` | non-null → refuse. This is why the credential is not a JWT |
| `expires_at` | null means **no expiry**; a past value → refuse |
| store row | absent → refuse, via an `INNER JOIN` rather than a null tenant |

**Every failure is the same `401 UNAUTHENTICATED`** — missing, malformed,
unknown, revoked, expired, or store-deleted. Distinguishing them tells an
attacker which half of a guess was right, and gives the plugin one reconnect
trigger instead of six.

**Context established:** `realm: 'store'`, `tenant_id` (through the store), and
`store_id`. **No user** — a store is not a person, and `audit_logs.user_id` is
nullable so a store-authenticated write records an absent actor rather than an
invented one.

**`store_credentials.scopes` is not read, and that is correct.** Every store
credential carries the same fixed scope — *read config, write events, heartbeat*
([M6.5](../../developePlan.md)) — so there is nothing per-credential to check and
the guard does not look. The column exists for a per-credential permission model
that was considered and not adopted: a plugin install needs all three or it
cannot function, and a credential that can heartbeat but not read config
describes a broken install rather than a useful restriction.

Stated here because a column named `scopes` that no code reads reads two ways to
a later author — *enforcement is missing* or *enforcement is elsewhere* — and both
are wrong. Reintroducing per-credential scopes would be a contract change, not an
implementation detail.

**`last_used_at` is throttled to one write per 5 minutes.** The column answers
"when did this store last talk to us", a question asked in days; writing it on
every request would turn a read path into a write path, and the heartbeat alone
is 60 requests an hour per store. The write is also non-fatal: a failed
timestamp must not turn an authenticated request into a `500`.

**Routes in this realm carry `@StoreRoute()`, never `@Public()`.** Authentication
is global and `@Public()` means *none* — a store route behind it that lost its
guard would be open to anyone. `@StoreRoute()` instead tells `JwtAuthGuard` to
stand aside for another realm: a route that carries it and forgets
`StoreTokenGuard` reaches the handler with no realm, no tenant and no store, so
it is unusable rather than unprotected. A permanent probe in
`test/store-realm.e2e-spec.ts` asserts exactly that.

### `GET /v1/store/config` **[built]**

The document a storefront renders from ([M9.1](../../developePlan.md)). Returns
the M7.5 config document for the store named by the presented credential.

**Rate limit:** 120 per hour, per store. A fifteen-minute cron is 4; the rest is
headroom for push-triggered pulls, a merchant pressing "Sync now", and retries.

**Response:** `200 OK` with the document, or `304 Not Modified` with no body.

```jsonc
// Request
GET /v1/store/config
If-None-Match: W/"01a0-store-uuid-42"

// Response — 200
ETag: W/"01a0-store-uuid-43"
Cache-Control: private, no-cache, must-revalidate

{ "data": { "schema_version": 1,
            "config_version": 43,
            "store_id": "01a0-store-uuid",
            "generated_at": "2026-08-28T10:00:00.000Z",
            "option_sets": [ /* … */ ] } }

// Response — 304, no body
ETag: W/"01a0-store-uuid-42"
```

**The ETag is `config_version`, scoped to the store, and weak.**

`W/"<store_id>-<config_version>"`. Each part earns its place:

- **`config_version`, not a body hash.** Hashing means building the document —
  the expensive thing a conditional request exists to avoid — and the body is
  not byte-stable anyway, since `generated_at` and `meta.timestamp` are stamped
  per request. `config_version` advances on publish and rollback and on nothing
  else, which is exactly the question being asked.
- **Scoped to the store.** A bare `"42"` is a claim about a number, not a store,
  and two stores at version 42 hold entirely different documents. Any shared
  cache keyed on the validator alone would serve one merchant's options to
  another.
- **Weak (`W/`).** Two responses at the same version differ byte-for-byte, so a
  strong validator would claim something this endpoint cannot honour.
  `If-None-Match` accepts a list and `*`; both are handled, because a false miss
  costs a full document build and a full download.

**A `304` does not build the document.** It costs one indexed read of
`stores.configVersion`. An implementation that built the document and then
discarded it would return a correct `304` having paid the full price — invisible
to a test that only checks the status code, so
`test/config-delivery.e2e-spec.ts` counts queries rather than trusting it.

**The envelope applies here as everywhere.** The document sits under `data`. It
was tempting to exempt this route so responses would be byte-stable for a CDN,
but freshness here is decided by version rather than by bytes, `UNWRAPPED_ROUTES`
is matched on path, and a shipped plugin cannot be updated in step with a shape
change — the reason the envelope mismatch found in Phase 9 was expensive.

### `POST /v1/store/orders` **[built]**

One completed order, reported for analytics
([M12.7](../../developePlan.md), feeding [Phase 25](../../developePlan.md)).
Written by the plugin *after* checkout completes and drained by cron — never
during the checkout request, because a slow cloud must not cost a customer
latency on their most valuable click.

**Rate limit:** 300 per hour, per credential. One request per order with no
batching, so this is a real order rate plus retries; a busy shop at five orders a
minute still fits. Keyed on the credential hash for the same reason the
heartbeat is. A store that legitimately exceeds it is not lost — the plugin's
queue holds unreported orders and drains them next run, so a `429` delays a
report rather than dropping it.

**Response:** `200 OK` — **not `201`**. The call is idempotent, so a retry after a
lost response returns the same `200` as the first delivery. A `201` would claim a
row was created on a request that created nothing, and the plugin cannot tell the
two apart anyway: both mean "stop retrying", which is the only thing it acts on.

```jsonc
// Request
{ "external_order_id": "1042",            // WooCommerce's id — the idempotency key
  "order_total_minor": 17900,             // integer minor units
  "currency": "GBP",
  "option_revenue_minor": 9900,           // the portion attributable to options
  "occurred_at": "2026-08-30T10:00:00Z",  // the STORE's clock, not arrival time
  "selections": [
    { "option_key": "finish", "option_label": "Finish",
      "value_key": "lux", "value_label": "Luxury",
      "price_delta_minor": 9900, "config_version": 7 }
  ] }

// Response
{ "data": { "id": "0f3c…", "duplicate": false } }
```

| Field | Rules |
|---|---|
| `external_order_id` | 1–64 chars. A **string**, not a number: it is WooCommerce's identifier, and HPOS and order-numbering plugins both produce ids that are not plain integers |
| `order_total_minor` | integer ≥ 0, minor units |
| `currency` | exactly 3 chars; stored upper-cased |
| `option_revenue_minor` | integer, optional (default `0`) |
| `occurred_at` | ISO-8601 |
| `selections` | ≤ 200 entries |
| `selections[].option_key` | 1–64 chars |
| `selections[].option_label` | ≤ 200 chars — **the plugin truncates to this before sending** |
| `selections[].value_key` | 1–64 chars, nullable — null for a free-text option |
| `selections[].value_label` | ≤ 500 chars, nullable |
| `selections[].price_delta_minor` | integer, **signed** — a discount option is legitimate |
| `selections[].config_version` | integer ≥ 0, optional |

**Idempotent on `(store_id, external_order_id)`.** The plugin retries whenever a
response is sent but never received, so the same order arrives twice. The
guarantee is the unique index `uq_order_events_external`, and the service upserts
against it with `INSERT … ON DUPLICATE KEY UPDATE` rather than checking first: a
`SELECT`-then-`INSERT` looks like it handles this and does not, because WordPress
cron is not single-threaded and two overlapping drains can both find no row. One
would win and the other would surface a constraint violation as a `500` — telling
a correctly-behaving plugin to retry forever.

⚠️ **No `LAST_INSERT_ID(id)` in the upsert**, the usual idiom for reading back an
upserted key. It takes an *integer* and `order_events.id` is `char(36)`, so MySQL
answers `Truncated incorrect INTEGER value` and the whole report `500`s —
measured, on the first run of the idempotency tests. A following `SELECT` reads
the id on both paths.

**Selections are replaced, not appended**, and the whole thing is one
transaction. Appending would double-count every option on a second delivery — the
analytics corruption idempotency exists to prevent, and invisible in the event
row alone because the parent *is* correctly deduplicated. The transaction matters
for the opposite failure: a crash between the delete and the insert would leave
an order with no selections, which reads as a plain product sale rather than as a
missing write.

⚠️ **Free text never leaves the merchant's server.** `order_selections.valueLabel`
can hold personal data — an engraving message, a gift note, a name — so the
plugin sends the chosen value's label (`"Luxury"`) and `null` for free-text option
types. Phase 25 asks how many customers bought engraving and what it earned, not
what they wrote. The field is validated at 500 rather than forbidden, because a
fixed-choice label is legitimate; **the restraint is the plugin's**, and is
asserted on that side. This keeps [ADR-014](../DECISIONS.md)'s hard-erase path a
safeguard rather than a routine obligation.

**The store id comes from the credential and is never read from the body.**
`forbidNonWhitelisted` already rejects a body carrying `store_id`, but that
proves the validation pipe rather than the service — a service trusting its input
passed every request-level test until a direct-call test was added. Cross-tenant
revenue attribution is the worst defect this route could carry, so it is tested
where it would actually happen.

**Order ids are scoped to the store.** WooCommerce ids restart at 1 on every
install, so two stores reporting order `1` are two different orders.

### `POST /v1/store/disconnect` **[built]**

The plugin telling the cloud it is leaving.

🔴 **Why this exists.** A merchant pressing **Disconnect** in WordPress left a
**live credential** behind. The plugin's own disconnect is deliberately *local* —
it clears its token so a merchant can recover even with the cloud unreachable —
and nothing told the backend. The store stayed `connected`, its credential stayed
valid, and the dashboard offered a Disconnect for a store already gone.

⚠️ **Reconciling through the heartbeat cannot work.** A disconnected plugin has
**deleted the credential** the heartbeat authenticates with, so it can never
report in again. The message has to be sent *before* the plugin forgets.

**Safety.** It revokes only the credential that authenticated the call, so it can
do nothing a stolen token could not already do — and a thief revoking their own
access is the one abuse nobody minds. `SiteMatchGuard` still requires the call to
originate from that store's own address.

**Idempotent**, answering `200` for a store already disconnected: the plugin calls
this on its way out and must not be blocked by the answer.

**Rate limit:** 20 per hour, per store.

```json
{ "disconnected": true }
```

### `POST /v1/store/heartbeat` **[built]**

A daily authenticated ping. The support and analytics backbone
([M8.5](../../developePlan.md)): it reveals stale installs and dead connections
before a merchant reports them.

**Rate limit:** 60 per hour, per store — a daily job with retries, not a stream.
Keyed on the **hash of the presented credential**, because the throttler is
ordered ahead of authentication (so an unauthenticated flood costs no database
lookup) and `store_id` is not yet in context when the key is computed. A
credential belongs to one store, so the two are equivalent here. Without this the
key falls back to the address, and an agency running many shops on one server
gives all of them a single shared budget.
**Response:** `200 OK`

```jsonc
// Request
{ "plugin_version": "1.0.0", "wp_version": "6.5.2", "wc_version": "8.7.0",
  "php_version": "8.2.15",
  "connection_state": "connected",        // the plugin's own view
  "config_version": 42,                   // what it currently serves
  "cache_age_seconds": 3600,
  "supported_schema_version": 1,          // the shape this build can read
  "schema_refused": false }               // whether that limit has bitten

// Response
{ "data": { "config_version": 43,          // what the cloud has
            "status": "connected",         // the cloud's view
            "reauthorize": false } }
```

| Field | Rules |
|---|---|
| `plugin_version`, `wp_version`, `wc_version`, `php_version` | ≤ 20 chars each |
| `connection_state` | one of the five states — **all five accepted**, including the ones a healthy plugin would never report |
| `config_version` | integer ≥ 0 |
| `cache_age_seconds` | integer ≥ 0 |
| `supported_schema_version` | integer ≥ 0 — the highest document shape this plugin build understands |
| `schema_refused` | boolean — whether this store last turned a document away |

**`schema_refused` is how the cloud learns a plugin is too old** (M9.5). The
plugin refuses a `schema_version` above its build and keeps the previous copy —
correct, and silent: that shop serves stale configuration while every other
signal says it is healthy. Without this field, "merchant needs to update their
plugin" is knowable only by asking them.

The two schema fields answer different questions and are deliberately separate.
`supported_schema_version` is a **capability** — true of every store on that
build, and current when it equals what the cloud sends.  `schema_refused` is an
**operations signal** — this shop is stale right now. Conflating them would make
every store look like it needed attention.

A refusal is recorded as `store.schema_unsupported`, deduplicated on the plugin
version: a store in this state reports it on every heartbeat, and a trail saying
so daily for a month is one support reads and misbelieves.

**The response is how a plugin learns it is behind.** `config_version` higher than
the one sent means new configuration is waiting; `reauthorize: true` means the
cloud requires a fresh handshake — a site URL change, or a credential revoked
elsewhere.

⚠️ **`reauthorize` is structurally `false`**, and the field ships anyway. Neither
trigger can fire on a `200`: a revoked credential never reaches this handler
because `StoreTokenGuard` answers `401` first, and a site mismatch answers `403`
from its own guard — an error response carries no `data`, so it cannot set this
flag either.

It becomes reachable when something can require re-authorisation **without
refusing the request**, which is an operator action against a store that is still
serving. The field exists from day one because the plugin **cannot be redeployed**
(M7.7) to start reading it later.

No test should assert `reauthorize === false` as though it proved logic — it
asserts a constant, which is how a test comes to look like coverage while
verifying nothing.

**Reconciliation.** `connection_state` is the plugin's *own* view, and it can
disagree with `stores.status` — a database restore, a migrated site, a cloned
staging environment. A mismatch is recorded rather than silently overwritten,
because whichever side is wrong, guessing produces the support ticket M8.1b
describes.

**It is recorded as `store.state_mismatch` in the audit trail**, carrying both
views — **once per disagreement, not once per ping.**

A store that cannot be reconciled disagrees on every heartbeat: daily that is 365
entries a year, and against the 60-per-hour limit a misbehaving plugin writes
1,440 a day for one store. The trail is its own memory — the last recorded
mismatch says what was already reported, so an unchanged disagreement is a
repetition and a changed one is news. Phase 26's operations surface does not exist yet, and the audit trail is
already the same shape as the requirement: something a human should see,
attributable, timestamped, and queryable per tenant. Inventing an operations table
now would build the wrong thing twice — Phase 26 will design one — and add a fifth
accumulating table to the four already awaiting retention in
[M34.1](../../developePlan.md).

The honest limit: an audit entry is a record, not a queue. Nobody is paged. That
is equally true of a Phase 26 ops row until its reader exists, so this defers the
same work without pretending otherwise.

**The cloud never adopts the plugin's claim.** `stores.status` is not written from
`connection_state` under any circumstance. The plugin's view is one of the two
things in dispute — a cloned staging site reports on a production store it is
impersonating, and believing it would let a clone degrade the original.

**`ERROR` is not reachable from this endpoint**, and that follows from the same
rule. The state machine's `CONNECTED → ERROR` edge is a *sync or auth failure*;
a heartbeat is the plugin **succeeding** at reaching the cloud, which is the
opposite event. Config-sync failures belong to `[phase 9]`, which owns that
transition and its `store.errored` entry.

**All five states are accepted, deliberately.** A plugin can only truthfully
observe `connected` or `error` — it cannot know it was revoked, having received a
`401` — so narrowing the field to those two looks tighter. It would reject the
anomalous report at validation and lose the exact signal this endpoint exists to
capture: a `400` says nothing, while a recorded mismatch says a site is confused.

**Errors:** `VALIDATION_FAILED`, `UNAUTHENTICATED` (unknown or revoked
credential), `RATE_LIMITED`.

---

## Connection state machine

Connection state is an **explicit, persisted state machine on both sides** — never
inferred from whether a token happens to be present. Ambiguous state is the
largest source of support tickets in this category of product: the merchant sees
"connected", the cloud disagrees, and nobody can tell which is right.

| From | To | Trigger |
|---|---|---|
| `DISCONNECTED` | `CONNECTING` | `authorize` approves a request |
| `CONNECTING` | `CONNECTED` | `exchange` redeems the code |
| `CONNECTING` | `DISCONNECTED` | the code expires unredeemed |
| `CONNECTED` | `ERROR` | repeated authenticated failures |
| `ERROR` | `CONNECTED` | a request succeeds |
| `CONNECTED` · `ERROR` | `REVOKED` | the cloud revokes, or a rotation supersedes |
| any | `DISCONNECTED` | the merchant disconnects |

**Every transition is recorded in the audit trail** with actor, previous state and
new state — M8.1b's acceptance is that both sides agree after any transition, and
a transition nobody logged cannot be reconciled afterwards.

**`ERROR` and `REVOKED` never stop the storefront.** A store in either state still
sells; it simply cannot receive new configuration
([AC3](../../developePlan.md)). This is the trust commitment, not an
implementation detail: a merchant whose shop breaks because a SaaS credential
lapsed does not renew.

### Site-URL change detection

Every plugin request carries **`X-Optionia-Site`**, the site's own `home_url()`.
A store's URL is recorded once at connection and is not editable afterwards, so
the check is a comparison: if the header does not match `stores.store_url`, the
request is refused and re-authorization required.

Without it, a cloned staging site inherits production's credential and begins
reporting orders as though it were the live shop — the clone reports its own URL
while the credential still names the original, which is precisely what makes the
mismatch detectable.

**The comparison is against the store's recorded URL, not a global lookup.**
`uq_stores_tenant_url` is `(tenant_id, store_url)`, so the same URL may
legitimately exist under two tenants — an agency and its client — and a global
uniqueness check would refuse a connection that is entirely valid.

> An earlier draft said the credential is "bound to the `site_url` it was issued
> for" and that the check is against "the credential's own bound URL".
> `store_credentials` has **no URL column**; it reaches one only through
> `store_id`. Stating it that way described a binding that does not exist, and
> would have had `[8i]` build against a mechanism rather than a fact.

**Normalisation matters here.** `https://shop.example.com` and
`https://shop.example.com/` are the same site and must compare equal; WordPress's
`home_url( '/' )` returns the trailing slash. Both sides normalise to origin plus
path without a trailing slash, lowercased host, before comparing — otherwise a
merchant's own site fails the check and the feature reads as broken.

**Errors:** a mismatch answers `403 FORBIDDEN`, not `401`. The credential is
genuine; the *site presenting it* is not the one it was issued to, and a 401 would
send the plugin into a reconnect loop it cannot win by retrying.

> An earlier draft said `403` **with `reauthorize: true`**. Those are mutually
> exclusive: `reauthorize` lives in the heartbeat's `200` body, and an error
> response is `{ error, meta }` with no `data` at all. The status is the signal —
> a plugin that receives `403` from a site check knows the cloud will not accept
> it from this address, which is the whole message.

**A mismatch refuses the request. It does not revoke the store.**

`X-Optionia-Site` is a plain HTTP header, and anyone holding the credential
controls its value. If a mismatch revoked, then whoever stole a token could also
**disconnect the merchant's live store** by sending one bad header — turning a
read-only compromise into a denial of service. A merchant migrating their domain
legitimately would kill their own store on the first request from the new address.

So the clone is blocked and the original keeps working, which is the outcome
[M8.1b](../../developePlan.md) actually asks for: *"a cloned site cannot silently
reuse the original's credential."* Silently is the operative word — refusing
without recording would leave `stores.status` reading `connected` while a clone
hammered the endpoint, and nobody would learn it existed.

**Every mismatch is therefore audited** as `store.site_mismatch`, naming both the
expected and the presented URL. Revocation stays a decision a human makes —
`POST /stores/:id/disconnect`, or an operator acting on the evidence in
`[phase 26]` — because whichever site is wrong, the cloud cannot tell which one
from a header alone.

**Where the check runs.** In its own guard, applied alongside `StoreTokenGuard`
rather than inside it. `StoreTokenGuard` answers *"is this credential valid"* and
holds an invariant — every failure is the same `401` — that a `403` would break.
This answers a different question, *"is this the site it was issued to"*, and
keeping them separate means Phase 9's config-sync routes inherit both by adding
one decorator.

---

## Concurrency

Every mutating request on an option set carries the `rowVersion` it loaded.

```jsonc
// Request:  { "name": "Updated", "rowVersion": 7 }
// Conflict: 409
{ "error": { "code": "VERSION_MISMATCH",
             "message": "This option set was changed by someone else." },
  "data": null }
```

**Never last-write-wins.** Two people editing one option set is normal in an
agency, and losing an afternoon's work to a colleague's save is unforgivable in an
authoring tool. The 409 carries the current server state so the dashboard can offer
a real choice — reload, or view what changed — rather than an error toast.

Autosave carries the same check and **degrades gracefully**: an autosave conflict
warns rather than discarding.

The 409 carries the current version in `details`, so a client knows what to
reload without a second request:

```jsonc
{ "error": { "code": "VERSION_MISMATCH",
             "message": "This option set was changed by someone else.",
             "details": [{ "field": "rowVersion", "code": "STALE",
                           "params": { "current": 9 } }] } }
```

**`rowVersion` is optional, deliberately.** Omitting it means "I have not loaded
a version", which scripts, migrations and background jobs legitimately have not.
Requiring it would break every non-dashboard caller to guard against a failure —
two editors overwriting each other — that only editors have.

**Where it is carried.** `PATCH /option-sets/:id` and `POST
/option-sets/:id/publish` take it in the body; `DELETE /option-sets/:id` takes it
as a query parameter, because `DELETE` bodies are dropped by some proxies and
refused by some clients.

**A child edit makes a parent version stale.** Adding a group, option or value
advances its set's `rowVersion`, so a set-level save loaded before that edit is
refused. Without it, two people editing different parts of one set would never
see each other.

**The check is a predicate on the write, not a comparison before it.** Reading
the version, comparing, then writing leaves a window in which another editor
commits between the two. The `WHERE rowVersion = ?` means the database decides:
of two concurrent saves exactly one matches a row. A pre-flight comparison also
runs, for the cases a predicate cannot reach — a save that turns out to change
nothing must still be refused if it is stale, or the *next* save is the silent
overwrite.

---

## Deferred to later phases

Documented when their controllers are written, per M7.7's acceptance — *"before
its controller is written"*, not all sixty-five now. Documenting an endpoint whose
shape is still a guess produces a contract that has to be rewritten, which is the
opposite of what a contract is for.

> **A row here names one phase, so a surface spanning several cannot share one.**
> `/stores/*` was a single row marked Phase 8, and its four endpoints belong to
> three different phases — disconnect and rotate to 8, the list screen to 13,
> products to 19. `/store/heartbeat` sat in a row marked "8–9" while
> [M8.5](../../developePlan.md) places it squarely in 8. A coarse row lets a
> later phase build against a contract that never described its endpoint, which
> is the failure this table exists to prevent.

| Surface | Phase |
|---|---|
| `GET /stores/:id/products` | `[phase 19]` — [M19](../../developePlan.md), product sync |
| `/store/config` | **9** — [M9.1](../../developePlan.md), config delivery |
| `/store/events`, `/store/orders` | 9 |
| `/option-sets/:id/rules/*` | **17** — the table exists, the engine does not |
| `/option-sets/:id/effective-options` | 13 — the resolver preview; assignments themselves are `[built]` above |
| `/plans`, `/subscription/*`, `/usage` | 22 |
| `/analytics/*` | 25 |
| `/admin/*` | 26 |
| `/webhooks/*` | 22, 9 |

> **Rules are listed in M7.7's surface but no Phase 7 milestone builds them.**
> `option_rules` exists from Phase 5 and rule CRUD and evaluation are
> [Phase 17](../../developePlan.md). Phase 7 honours the cascade above — a rule
> targeting a deleted group is disabled and flagged — against a table nothing else
> writes to yet. Shipping the endpoints here would be scope the milestone does not
> ask for.
