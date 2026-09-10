# Config Document Contract

**Schema version 1. Frozen.**

The JSON a storefront fetches and renders from. The reference for both
implementations — the TypeScript that produces it and the PHP that consumes it —
so neither has to read the other's source to know what a field means.

This is **the single most important interface in the system**. Every other
contract in this repository can be revised by deploying; this one is read by a
plugin installed on merchant servers that cannot be redeployed on demand. A
change here that a shipped plugin does not understand takes storefronts down.

---

## The rule that makes this safe

`schema_version` describes the document's **shape**. `config_version` describes
its **content**.

The plugin refuses a document whose `schema_version` exceeds what it supports and
**keeps its previous copy** — `Config\Repository::store()` does this today, with
`SUPPORTED_SCHEMA_VERSION = 1`. A merchant on an old build keeps selling with
their last known-good configuration rather than losing their options.

That protection only works if the version is honest:

| Change | Bumps `schema_version`? |
|---|---|
| Adding a key a reader can ignore | **No** |
| Adding a member to an existing array | **No** |
| Removing a key, or renaming one | **Yes** |
| Changing a value's type or units | **Yes** |
| Changing what an existing key means | **Yes** |

**Bumping is a release, not an edit.** It ships with a plugin build that
understands the new shape, and every storefront on an older build stops receiving
updates until it upgrades. Nothing in Phase 7 bumps it.

Additive changes are why the envelope already carries `assignments` and `rules`
as empty arrays while Phase 13 and Phase 17 remain unbuilt: a plugin written
against v1 handles them from its first release, so filling them later is not a
breaking change.

---

## The document

```jsonc
{
  "schema_version": 1,
  "config_version": 42,
  "store_id": "01a03f9e-…",
  "generated_at": "2026-08-27T10:00:00.000Z",
  "option_sets": [
    {
      "id": "01a03f9e-…",
      "version": 7,
      "assignments": [],
      "groups": [
        {
          "id": "01a03fa1-…",
          "label": "Customization",
          "description": "Make it yours",     // omitted when unset
          "display_type": "inline",
          "sort_order": 10,
          "is_collapsible": false,
          "options": [
            {
              "id": "01a03fa4-…",
              "key": "print_placement",
              "type": "radio",
              "value_kind": "choice",
              "cardinality": "one",
              "label": "Print placement",
              "is_required": true,
              "sort_order": 10,
              "values": [
                {
                  "value_key": "none",
                  "label": "None",
                  "sort_order": 10,
                  "price_config": { "type": "fixed", "amount_minor": 0 },
                  "is_default": true             // present only when true
                },
                {
                  "value_key": "front",
                  "label": "Front",
                  "sort_order": 20,
                  "price_config": { "type": "fixed", "amount_minor": 1000 }
                }
              ]
            }
          ],
          "items": [
            { "kind": "heading", "content": "Make it yours", "sort_order": 5 }
          ]
        }
      ],
      "rules": [
        {
          "id": "01a03fb0-…",
          "target_type": "option",             // option · group · value
          "target_id": "01a03fa4-…",
          "action": "hide",                    // show · hide · require · unrequire · set_price · set_default
          "match_type": "all",                 // all · any
          "conditions": [
            { "option_id": "01a03fa4-…", "operator": "equals", "value": "no" }
          ],
          "action_value": { "amount_minor": 500 },  // omitted unless the action needs one
          "sort_order": 10
        }
      ]
    }
  ]
}
```

---

## Envelope

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | int | The shape. `1`. See above. |
| `config_version` | int | The store's content revision; advances on every publish and rollback. The plugin polls it to decide whether to re-fetch. |
| `store_id` | string | UUID of the store this document is for. |
| `generated_at` | string | ISO 8601 UTC, when the document was **assembled** — not when anything was published. The same content fetched twice differs only here. |
| `option_sets` | array | Published sets, oldest first. Empty is legal: a store with nothing published. |

`config_version` is `BIGINT` on both sides — `stores.config_version` here, and
`config_version bigint(20) unsigned` in the plugin's own table. It is a counter,
not a timestamp, and never decreases: a rollback advances it like any other
publish, because storefronts must re-fetch after one.

---

## Option set

| Field | Type | Meaning |
|---|---|---|
| `id` | string | UUID. The join key for analytics and order selections. |
| `version` | int | The publish that produced this content. Matches the snapshot it came from. |
| `assignments` | array | Where the set applies. **Always empty in Phase 7** (Phase 13). |
| `groups` | array | Ordered by `sort_order`, then `id`. |
| `rules` | array | Conditional logic (M17.5). Empty for any set published before it. |

### Rule

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID. |
| `target_type` | string | `option` · `group` · `value` — what kind of row `target_id` names. |
| `target_id` | string | The row the action acts on. **Not a foreign key**: a rule whose target is deleted is disabled and surfaced to the merchant rather than cascading away. |
| `action` | string | `show` · `hide` · `require` · `unrequire` · `set_price` · `set_default`. |
| `match_type` | string | `all` · `any` — how the conditions combine. |
| `conditions` | array | Flat, never nested. Each is `{ option_id, operator, value? }`. |
| `action_value` | object | **Omitted** unless the action needs one: `{ amount_minor }` for `set_price`, `{ value_key }` for `set_default`. |
| `sort_order` | int | ⚠️ **Presentation, not precedence.** M17.2 makes evaluation order-independent; this decides the order a merchant reads the rule list and nothing else. |

> **Nine operators**, in three operand shapes. `is_empty` and `is_not_empty`
> carry **no** `value` — the key is absent, not null. `in` and `not_in` take an
> array. `equals`, `not_equals` and `contains` take a scalar; `greater_than` and
> `less_than` take a **number**, because text has no ordering PHP and JavaScript
> agree on.
>
> **Disabled rules are absent entirely**, exactly as a disabled group, option or
> value is — so `is_enabled` and `disabled_reason` never appear. A rule the
> cascade disabled because its target was deleted is left out for the same
> reason, and the merchant is told at publish instead.
>
> **Contradictions resolve by meaning, never by order** (ADR-052): `hide` beats
> `show`, and `require` beats `unrequire`. Two rules setting *different*
> `action_value` payloads on one target have no principled winner and are refused
> at publish.

## Group

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID. |
| `label` | string | Shown to the customer. |
| `description` | string | **Omitted when unset.** |
| `display_type` | string | `inline` · `accordion` · `tab` · `modal` |
| `sort_order` | int | Ascending. Gaps are normal and intentional. |
| `is_collapsible` | bool | |
| `options` | array | |
| `items` | array | Headings, paragraphs, dividers — presentation only, no cart data. |

## Option

| Field | Type | Notes |
|---|---|---|
| `id` | string | UUID. Order selections reference the **`key`**, not this. |
| `key` | string | Stable identifier. Immutable after first publish, because order meta stores it. |
| `type` | string | The presentation. `radio` is the only type in Phase 7. |
| `value_kind` | string | What the option produces: `choice` · `text` · `number` · `file` · `date` · `colour` |
| `cardinality` | string | `one` · `many` |
| `label` | string | |
| `description`, `placeholder`, `help_text` | string | **Omitted when unset.** |
| `is_required` | bool | |
| `sort_order` | int | |
| `default_value` | string | **Omitted when unset.** For non-choice types. |
| `validation`, `display` | object | Type-specific. **Omitted when unset.** Shapes are per type; `radio` uses none of them. |
| `pricing` | object | **Option-level** price. `snake_case`, like `price_config`. **Omitted when unset.** See below. |
| `values` | array | |

### Option-level `pricing` vs. value-level `price_config`

Two different fields carrying two different things, and a reader must not accept
one where the other belongs:

| Field | Lives on | Types |
|---|---|---|
| `price_config` | a **value** | `fixed`, `percentage` |
| `pricing` | an **option** | `per_char`, `per_unit`, `tiered` |

An option with no values — text, date, number, file — has no value row to carry
`price_config`, so its price hangs on the option. `per_char` and `per_unit` are
the two types `PRICING-SPEC.md` defines there, and they are the two whose amount
depends on **what the customer supplied** rather than on which value they picked.

```jsonc
{ "type": "per_char", "amount_minor": 25, "free_characters": 10 }
{ "type": "per_unit", "amount_minor": 200 }
{ "type": "tiered",   "tiers": [
    { "min_quantity": 1,  "max_quantity": 9,    "amount_minor": 100 },
    { "min_quantity": 10, "max_quantity": null, "amount_minor": 80 }
]}
```

Each is accepted only where it means something: `per_char` on `text_field` and
`textarea`, `per_unit` and `tiered` on `number_field`, `range` and `quantity`.
The type registry refuses the rest, because an evaluator dispatching on `type`
alone would otherwise charge for the length of an upload token or bracket a date.

**Tiers cover every quantity from 1 upward.** The first starts at `1`, the last
is open-ended, and they are contiguous with both bounds inclusive — the schema
refuses a set with a gap at either end or in the middle, because a quantity no
bracket covers is a configuration whose behaviour nobody decided. A merchant
wanting a minimum order sets `min` on the option, which produces a message a
customer can act on.

⚠️ **`tiered` was a `price_config` type until M16.3**, which made it configurable
only on a chosen value — a radio, which has no quantity to bracket. A merchant
could save a tiered price and have it charge nothing.

⚠️ **`per_unit` has no `free_units`**, unlike `per_char`'s `free_characters`. A
free allowance on a quantity is a volume discount, which `tiered` expresses with
brackets a merchant can see.

`free_characters` is **always present** for `per_char`, `0` when the merchant set
none: a reader must tell "charge from the first character" from "never
configured", even though the two behave identically.

⚠️ **This field was published verbatim until M16.2** — `camelCase`, while the
document and this contract are `snake_case`. Latent only because the plugin read
`type` and nothing else, which spells the same either way. The first evaluator to
read the amount would have found it absent and charged nothing for every
engraving.

## Value

| Field | Type | Notes |
|---|---|---|
| `value_key` | string | Stable identifier. Stored in order meta. |
| `label` | string | Snapshotted per order, so renaming later does not rewrite history. |
| `sort_order` | int | |
| `price_config` | object | Always present. See below. |
| `image_url`, `color_hex`, `sku_suffix`, `weight_delta_grams` | | **Omitted when unset.** |
| `is_default` | `true` | **Present only when true.** Never `false`. |

## Presentational item

| Field | Type | Notes |
|---|---|---|
| `kind` | string | `heading` · `paragraph` · `divider` · `rich_text` |
| `content` | string | For `rich_text`, merchant-authored markup — sanitised at publish **and** at render. |
| `sort_order` | int | |
| `display` | object | **Omitted when unset.** |

---

## Pricing

**Money is an integer count of minor units. Always.** `1000` is £10.00. There is
no decimal, no float, and no currency in the document — the store's currency
governs, and a number that means different things in two places is a rounding
error waiting to reach a merchant's revenue.

Percentages are **basis points**: `250` is 2.5%. Same reason — `0.1 + 0.2 !== 0.3`
in binary floating point, and a percentage that drifts produces a different total
on two machines.

```jsonc
{ "type": "fixed",      "amount_minor": 1000 }
{ "type": "per_unit",   "amount_minor": 50 }
{ "type": "percentage", "basis_points": 250 }
{ "type": "per_char",   "amount_minor": 25, "free_characters": 10 }
{ "type": "tiered",     "tiers": [
    { "min_quantity": 1,  "max_quantity": 9,    "amount_minor": 100 },
    { "min_quantity": 10, "max_quantity": null, "amount_minor": 80 }
]}
```

`price_config` is **always present**, whichever way a value was priced. A value
configured through the pricing JSON and one priced through its columns produce
the same shape — anything else puts two spellings of one field in a document two
evaluators read ([ADR-032](DECISIONS.md#adr-032--the-published-projection-is-a-type-not-a-convention)).

`max_quantity: null` means open-ended and is **explicit**, never omitted: a
reader must tell "no upper bound" from "not specified".

Negative amounts are legal. A value may be a discount.

---

## What is deliberately absent

The document sits on merchant servers and is fetched by storefronts. Anything
unnecessary is needless exposure, so a field appears only if the plugin needs it.

| Absent | Why |
|---|---|
| `tenant_id` | Identifies the merchant's account, not their storefront. |
| `row_version` | An editor's optimistic lock. Meaningless to a renderer. |
| `created_at`, `updated_at`, `deleted_at` | Audit fields. Freshness is `config_version` and `generated_at`. |
| `published_by` | A user id. A storefront document naming a merchant's staff serves nobody. |
| `is_enabled` | **Disabled things are absent entirely.** |
| Parent ids | The document is a tree; a child naming its parent is the same fact twice, and two ways to disagree. |
| Drafts | Only published snapshots. An edit does not reach a storefront until it is published. |

**Disabled is absence, not a flag.** A disabled group, option or value does not
appear. Shipping it with a flag makes every consumer — renderer, evaluator, PHP
and TypeScript alike — responsible for remembering to check it, and one of them
will forget. The failure is an option appearing on a storefront the merchant
switched off.

---

## Reading it safely

1. **Check `schema_version` first.** Refuse anything higher than you support and
   keep the previous copy. Do not attempt partial parsing.
2. **Treat absent as absent, not as false.** `is_default` missing means "not the
   default"; `description` missing means there is none.
3. **Ignore keys you do not recognise.** They are additive by definition, and a
   reader that rejects them turns a compatible change into an outage.
4. **Never write to it.** It is a snapshot of what was published; the source of
   truth is the dashboard.
5. **Money is an integer.** Do not parse it as a float, and do not format it
   without the store's currency.

---

## Provenance

Produced by `ConfigDocumentBuilder` from **immutable published snapshots**, never
from live rows — the live rows are the merchant's working draft. Each set
contributes the snapshot its most recent publish wrote, so the same document
requested twice is identical unless something was published in between.

**No endpoint serves this yet.** `GET /store/config` is Phase 8–9 and needs
store-token authentication, which does not exist. The builder is deliberately
ahead of its consumer so the contract describes something real rather than
something planned — but nothing in Phase 7 fetches a document.

**Snapshots outlive the code that wrote them, so the shape is guaranteed on
read.** A snapshot written before a key joined the envelope does not carry it,
and shipping it verbatim would contradict this contract. Mandatory keys are
filled in when the document is assembled; snapshots themselves are **never
rewritten**, because they are the record of what was actually published. This is
what makes "additive changes do not bump `schema_version`" true rather than
aspirational.

**Retention is not defined here.** `option_set_versions` grows one row per
publish, and pruning is Phase 26b's (retention per plan). A consumer must not
assume a version referenced by an older document is still fetchable — the
document it holds is complete on its own, which is why it embeds content rather
than referencing versions by number.

A published set whose snapshot is missing is **skipped rather than fatal**. That
state cannot arise — publish writes both in one transaction — but one corrupted
set must not take a whole storefront's configuration down with it.

Ordering is deterministic throughout: sets by creation, and every child list by
`sort_order` then `id`. Two builds of unchanged data produce the same bytes, so a
merchant comparing documents sees only real differences.
