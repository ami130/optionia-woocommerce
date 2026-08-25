# API Contract — v1

**Status:** authoritative for every endpoint listed here.
**Rule:** an endpoint is documented here *before* its controller is written
([M7.7](../../developePlan.md)).

This document is the **design**. The OpenAPI spec generated from the controllers
is a **description**. They will occasionally disagree, and that disagreement is
the signal that a controller drifted from its contract — which is why the
generated spec never replaces this file.

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
            "pagination": { "nextCursor": "eyJpZCI6…", "hasMore": true, "limit": 50 } } }
```

`limit` defaults to 50 and is capped at 100. The cursor is opaque and clients must
not construct one; its encoding is an implementation detail that may change.

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

### `POST /v1/auth/register`

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

### `POST /v1/auth/verify-email`

**Rate limit:** 10 per hour. **Response:** `200 OK`

```jsonc
{ "token": "…" }                     // → { "data": { "verified": true } }
```

**Errors:** `TOKEN_INVALID` (401) for expired, already-used, and never-existed
alike — distinguishing them confirms a token was once valid.

### `POST /v1/auth/resend-verification`

**Rate limit:** 3 per hour, per address — this endpoint sends mail to an address
the caller names, which is the email-bombing vector M6.1 warns about.

**Response:** `202 Accepted`, identically whether the address exists, is already
verified, or is unknown.

### `POST /v1/auth/login`

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
- `FORBIDDEN` (403) — email not verified. Safe to distinguish, because the caller
  has already proven they hold the password.
- `RATE_LIMITED` (429).

### `POST /v1/auth/refresh`

Exchanges a refresh token for a new one. **Rate limit:** 60 per hour.
**Response:** `200 OK` → `{ "data": { "refreshToken": "…" } }`

**Rotation and reuse detection.** Each refresh mints a new token and marks the old
one spent. A token presented twice means a copy was stolen — the legitimate holder
has the replacement — so **the entire family is revoked**, not just the replayed
token. Revoking only that one would log the victim out while leaving the attacker
signed in.

**Errors:** `TOKEN_INVALID` (401) for every failure, including detected reuse.
Telling an attacker their replay was noticed tells them the token was real; the
detection is for operations, which get a warning log.

### `POST /v1/auth/logout`

**Rate limit:** 60 per hour. **Response:** `204 No Content`, whether or not the
token was live — a different answer for an unknown token confirms which exist.

Revokes the refresh family **and** stamps `sessions_invalidated_at`, so the access
token stops working immediately rather than surviving until it expires (ADR-024).

### `POST /v1/auth/request-password-reset`

**Rate limit:** 3 per hour, per address. **Response:** `202 Accepted`

**No row is written and no mail is sent for an unknown address**, and the response
is identical either way.

### `POST /v1/auth/reset-password`

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

| Route | Capability | Notes |
|---|---|---|
| `GET /tenants/me` | — | Any member may read their own workspace |
| `PATCH /tenants/me` | `tenant:delete`-adjacent; **owner only** | Renaming is an ownership act |
| `GET /tenants/me/members` | — | Any member may see who else is here |
| `POST /tenants/me/members/invite` | `members:invite` | owner, admin |
| `PATCH /tenants/me/members/:id` | `members:change_role` | **owner only** |
| `DELETE /tenants/me/members/:id` | `members:invite` | owner, admin |
| `GET /tenants/me/invitations` | `members:invite` | Pending invitations |
| `DELETE /tenants/me/invitations/:id` | `members:invite` | Revoke a pending invitation |

> **Three routes are absent from M7.7's sketch** and are added here: listing
> pending invitations, revoking one, and accepting one (below). All three are built
> in [M6.5b](../../developePlan.md) and all three are in its text. A pending-invite
> list with resend and cancel is named explicitly.

### `POST /v1/auth/accept-invitation`

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

### `POST /v1/tenants/me/members/invite`

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

### `PATCH /v1/tenants/me/members/:id` · `DELETE /v1/tenants/me/members/:id`

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

## OPTION SETS — `/v1/option-sets/*`

**Realm:** tenant. Every route tenant-scoped at the data layer, not by a predicate
a handler remembers to add.

| Route | Capability |
|---|---|
| `GET /option-sets` | `option_sets:view` |
| `POST /option-sets` | `option_sets:edit` |
| `GET /option-sets/:id` | `option_sets:view` |
| `PATCH /option-sets/:id` | `option_sets:edit` |
| `DELETE /option-sets/:id` | `option_sets:delete` |
| `DELETE /option-sets/:id?hard=true` → **see below** | `option_sets:delete` |
| `POST /option-sets/:id/duplicate` | `option_sets:edit` |
| `POST /option-sets/:id/publish` | `option_sets:publish` |
| `GET /option-sets/:id/versions` | `option_sets:view` |
| `POST /option-sets/:id/rollback` | `option_sets:rollback` |
| `POST /option-sets/:id/reorder` | `option_sets:edit` |

**`editor` can edit but cannot publish**, and that is the single most important
line in the permission matrix. Editing is safe; publishing changes a live
storefront and what customers are charged. An agency contractor should be able to
build an option set without pushing it live.

### `GET /v1/option-sets`

Cursor-paginated. Filters: `status` (`draft` · `published` · `archived`),
`storeId`, `q` (name search).

**A filter cannot widen tenant scope.** The tenant predicate is merged *after* the
caller's filters, so a supplied `tenantId` is overwritten rather than honoured.

### `DELETE /v1/option-sets/:id` — soft and hard

Two distinct operations, and the sketch has a route for only one.

**Soft delete** (default) hides the set and excludes it from published config.
Historic orders are unaffected, because `order_selections` stores keys
denormalised (ADR-016).

**Hard delete** (`?hard=true`) is permitted **only when no order has ever
referenced it**. It is a separate operation with a precondition, not a stronger
form of the same one.

**Errors:** `CONFLICT` (409) when an order references it — the message names the
count, because "you cannot delete this" without a reason is not actionable.

### `POST /v1/option-sets/:id/publish`

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

**Publish is serialized per option set.** Two simultaneous publishes must not
interleave into a half-built snapshot; the second waits and then sees the first's
version.

**Errors:** `VALIDATION_FAILED` (400) with per-item detail; `VERSION_MISMATCH`
(409) if the draft changed since it was loaded; `INSUFFICIENT_ROLE` (403).

### `POST /v1/option-sets/:id/rollback`

```jsonc
{ "version": 5, "note": "reverting the holiday pricing" }
```

**Rollback publishes a prior snapshot as a new version rather than rewriting
history.** Version 8 rolling back to 5 produces version 9 whose content matches 5.
Rewriting would make the audit trail a lie, and the merchant who needs rollback at
9pm is exactly the one who will later need to know what happened.

**Errors:** `NOT_FOUND` (404) for an unknown version; `INSUFFICIENT_ROLE` (403).

---

## GROUPS · OPTIONS · VALUES

**Realm:** tenant. Nested resources whose paths do **not** name a tenant — scoping
is entirely the data layer's job, which is why the parent-scoped repository is
built before any of these endpoints.

| Route | Capability |
|---|---|
| `POST /option-sets/:id/groups` · `PATCH /groups/:id` · `DELETE /groups/:id` | `option_sets:edit` / `:delete` |
| `POST /groups/:id/options` · `PATCH /options/:id` · `DELETE /options/:id` | `option_sets:edit` / `:delete` |
| `POST /options/:id/values` · `PATCH /values/:id` · `DELETE /values/:id` | `option_sets:edit` / `:delete` |
| `POST /groups/:id/duplicate` · `POST /options/:id/duplicate` | `option_sets:edit` |

> **Duplicate exists at every level**, not only for option sets. M7.2 says the
> lifecycle operation set is "inherited by groups, options, and values alike", and
> deep-copying a group with its options and values is what a merchant building
> variants actually wants. The sketch lists it only for option sets.

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

### `POST /v1/option-sets/:id/reorder`

Bulk, gap-tolerant integers, so a single move is one write rather than renumbering
every sibling.

```jsonc
{ "groups": [{ "id": "…", "sortOrder": 10 }, { "id": "…", "sortOrder": 20 }] }
```

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

---

## Deferred to later phases

Documented when their controllers are written, per M7.7's acceptance — *"before
its controller is written"*, not all sixty-five now. Documenting an endpoint whose
shape is still a guess produces a contract that has to be rewritten, which is the
opposite of what a contract is for.

| Surface | Phase |
|---|---|
| `/connect/*`, `/stores/*` | 8 |
| `/store/config`, `/store/heartbeat`, `/store/events`, `/store/orders` | 8–9 |
| `/option-sets/:id/rules/*` | **17** — the table exists, the engine does not |
| `/option-sets/:id/assignments`, `/effective-options` | 13 |
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
