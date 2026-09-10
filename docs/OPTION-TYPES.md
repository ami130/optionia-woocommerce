# Option Types

**The definitive list of what Optionia supports.** M14.5 requires that any public
claim about type counts be counted from this file rather than estimated — so this
is the source, and anything absent here is unsupported however complete it may
look elsewhere.

Each entry gives the three axes from
[M5.4b](../developePlan.md), what validates it, how it prices, and where it is
authored.

---

## The three axes

A type is not a flat name. It is three independent facts:

| Axis | Meaning |
|---|---|
| `value_kind` | What kind of value it produces — `choice`, `text`, `number`, `date`, `file` |
| `cardinality` | How many may be selected — `none`, `one`, `many` |
| `presentation` | How it draws — the registry key |

**This is why a "single-select colour swatch" and a "multi-select colour swatch"
are one entry, not two.** The axes carry the behaviour; the presentation carries
only the rendering. `radio` and `dropdown` are the *same* option asked twice, drawn
differently.

---

## Supported today

| Presentation | `value_kind` | `cardinality` | Takes values | Authorable in the dashboard |
|---|---|---|---|---|
| `radio` | `choice` | `one` | yes | ✅ |
| `dropdown` | `choice` | `one` | yes | ✅ |
| `checkbox` | `choice` | `one` | yes | ✅ |
| `color_swatch` | `choice` | `one` | yes | ✅ |
| `image_swatch` | `choice` | `one` | yes | ✅ |
| `text_field` | `text` | `none` | **no** | ✅ |
| `textarea` | `text` | `none` | **no** | ✅ |
| `number_field` | `number` | `none` | **no** | ✅ |
| `range` | `number` | `none` | **no** | ✅ |
| `quantity` | `number` | `none` | **no** | ✅ |
| `date_picker` | `date` | `none` | **no** | ✅ |
| `time_picker` | `date` | `none` | **no** | ✅ |
| `datetime_picker` | `date` | `none` | **no** | ✅ |
| `hidden` | `text` | `none` | **no** | ✅ |

⚠️ **`cardinality` is `one` for all five *choice* types, though M14.1's table
says `one | many` for three of them.** (`text_field` is `none`: it produces one
string, not a selection from a set.) `Engine\SelectionResolver` requires a
**scalar** selection and answers `ERROR_NOT_SCALAR` for the array a multi-select
posts, so registering `many` would let the API accept what the storefront refuses
at add-to-cart — after a merchant had published it. `many` arrives with the stage
that builds the array path through resolver, cart, labels and order.

✏️ **The swatches became authorable once the value editor could set a colour or
an image.** They were registered and deliberately withheld until then — the two
bars working as intended: the API registers a type when the *server* can validate
it, the dashboard offers one when it can also **author and re-open** it. A merchant
picking "colour swatch" with no way to set colours would have published something
that renders as plain radios.

The colour and image fields appear **only** for the swatch types. A colour is
validated in three places — the API's DTO, this schema, and the storefront
template — because it reaches a `style` attribute, where `esc_attr` alone would
happily emit `red; background-image:url(...)`.

**All fifteen presentations the enum declares.** The gap that used to sit here —
a presentation exists in `Presentation` when the *schema* can store it, and in the
registry when the *server* can validate it — closed when `file_input` was
registered in Phase 15. `type-registry.spec.ts` now asserts the unregistered list
is **empty**, so the two bars cannot drift apart again without a test failing.

✏️ This paragraph read *"Fourteen of the fifteen"* until 2026-09-10, naming
`file_input` as the holdout. Phase 15 shipped it; this file did not notice. M14.5
makes this document the authority any public claim about type counts is counted
from, so a stale number here is the one that reaches a pricing page.

### Value grouping (`<optgroup>`)

A dropdown value may carry a `groupLabel`; values sharing one render under a
single `<optgroup>`. Blank or absent means **not grouped**, which is what every
dropdown authored before this existed has.

| | |
|---|---|
| Column | `option_values.groupLabel`, `varchar(200)`, nullable |
| Wire | `group_label`, **absent** when ungrouped |
| Offered for | `dropdown` only — `takesGroupLabel()` |

⚠️ **Groups are contiguous runs in `sort_order`, not a re-sort.** Two values
sharing a label with a third between them render as **two** groups with the same
heading. The merchant's ordering is authoritative, and `<optgroup>` cannot nest
or resume — regrouping silently would move values they deliberately placed.

⚠️ **A blank label is treated as no group**, not as a nameless one: an empty
`<optgroup label="">` renders as an unlabelled indent in every browser, which
reads as a rendering fault rather than a choice.

The other choice types ignore `group_label` entirely, which is why the dashboard
offers the field for `dropdown` alone — a field that silently does nothing is the
colour-swatch defect in reverse.

### Validation

The five choice types share `choiceValidationSchema`:

| Rule | Meaning |
|---|---|
| `minSelections` | 0–100, optional |
| `maxSelections` | 1–100, optional |
| — | A minimum above the maximum is rejected |
| — | An unknown field is rejected, never ignored |

`text_field` has its own `textValidationSchema`:

| Rule | Meaning |
|---|---|
| `minLength` | 0–5000, optional |
| `maxLength` | 1–5000, optional — **counted in graphemes** |
| — | A minimum above the maximum is rejected |

⚠️ **`maxLength` counts what the customer sees, not bytes.** `Engine\Text::measure()`
and `Intl.Segmenter` both count grapheme clusters, so a family emoji is **one**
character — one mark in the engraved material — where `strlen()` says 18 and
`String.length` says 11. The limit is **refused, never truncated**: cutting an
engraving charges for text the customer can read on the page and will not receive.

M14.4b makes `character_counter` **required** wherever `maxLength` is set, so the
dashboard derives it rather than offering a checkbox — "limit without counter" is
a state a merchant cannot express.

Plus `is_required` on the option itself, which every type carries and which is
therefore a column rather than a validation key.

### Pricing

The choice types price **per value**, never per option — a value's price does not
depend on how the option renders. The options with no values price at the
**option** level instead: `per_char` on `text_field` and `textarea` (M16.2),
`per_unit` on `number_field`, `range` and `quantity` (M16.2). Those two are the
types whose amount depends on *what the customer supplied* rather than on which
value they picked. Amounts are integer **minor units**; see `PRICING-SPEC.md`.

⚠️ **Position matters, and is enforced in three places.** `per_char` and
`per_unit` are charged on an option and refused on a value; `fixed`, `percentage`
and `tiered` are the reverse. The cloud's type registry refuses the wrong
combination at authoring time, the plugin's cache scanner warns about one that
reaches a published document, and the evaluator contributes nothing and reports
it. A type in the wrong place is never silently charged and never silently free.

⚠️ **Each applies only where its answer means something.** `per_char` not on
`file` (whose answer is a 64-character upload token), `date`, `number` or
`hidden` — whose value is the merchant's own `default_value`. `per_unit` only on
the three number types. Measured before the restriction: a `per_char` price on a
file option charged **32.00** for the length of a hash the customer never saw.

⚠️ **A quantity is capped at 1,000,000 whatever the merchant configures.** The
counterpart to the 5,000-grapheme ceiling on text, and it was missing until
M16.2: at 2.00 per unit with no `max` set, a customer typing `9999999999999`
added a line worth **20,000,000,000,078.00**. Over the ceiling the option is
reported as unpriced rather than charged or silently zeroed.

⚠️ The config document publishes five price types — `fixed`, `percentage`,
`per_unit`, `per_char`, `tiered` — and the plugin implements **all but
`tiered`**, which [Phase 16](../developePlan.md) adds. The plugin does not guess
at it: it reports an unimplemented type as unpriced rather than charging `0`,
because a measured case showed a 50% surcharge on an £80 product charging £80 and
losing the merchant £40 per unit with nothing saying so.

A `percentage` is taken of the product's **base price**, never of a running
total, so two 50% options on £80 add £40 each rather than £40 and £60 — the
order options are summed in is not defined by the schema and must not change
what a customer pays. `Engine\SelectionResolver::PRICED_TYPES` is the single
authority for what this build charges; the admin notice and the cart logger both
read it rather than restating it.

### Cart and order representation

Identical for every type, because the resolver never reads `presentation`:

| Where | Key | Holds |
|---|---|---|
| Cart item | `optionia.selections` | `{ option_id: value_key }` |
| Order item meta | `_optionia_selections` | the same map, snapshotted |
| Order item meta | `_optionia_price_delta` | the total added, in major units |
| Order item meta | `_optionia_config_version` | the revision it was priced against |
| Order item meta | `_optionia_sku_suffix` | `{ option_id: suffix }`, for fulfilment |
| Order item meta | *the option's label* | e.g. `Finish = Luxury`, for fulfilment |

🔴 **`sku_suffix` is recorded on the order, never applied to the product's SKU.**
`WC_Product::set_sku()` throws `WC_Data_Exception` on a duplicate, and two cart
lines of one product with the same option produce identical SKUs — so the
duplicate is the normal case rather than the odd one, and an uncaught throw on
`woocommerce_before_calculate_totals` would take the cart page down. Fulfilment
reads the order, so that is where the code lands.

Kept **keyed by option id rather than pre-joined**: a separator is a merchant's
convention (`-OAK-LG` or `_OAK_LG`), and an integration composes its own. Sorted
by option id, so one configuration always produces one SKU whatever order the
form submitted.

For `text_field` the map holds the customer's own text rather than a `value_key` —
sanitised in the resolver and escaped at display, because it is the first value a
**customer** supplies and the `value_key` lookup that made everything before it
trustworthy no longer applies.

---

## Declared but not yet supported

These exist in `Presentation` and are **rejected by the API** — `assertValidOption`
answers `UNSUPPORTED_OPTION_TYPE` naming what is supported. The plugin skips any
type it has no template for rather than rendering a fallback, because a control a
customer can use but the server cannot price is worse than no control.

**None. This list is empty as of Phase 15.**

| Presentation | Blocked on |
|---|---|
| — | — |

`file_input` was the last entry and left in Phase 15. The section is kept rather
than deleted because it is where the next declared-but-unbuilt presentation goes,
and an empty table states that positively — a deleted section would leave a
reader unsure whether the question had been asked.

✏️ **`dropdown_grouped` never became a type**, and that is the decision rather
than an omission: the axes, the values and the pricing are identical to
`dropdown` — only the drawing differs. It ships as a `groupLabel` on a value,
read by the dropdown template as `<optgroup>`. Registering a second type would
give merchants two ways to describe one thing, which is what the three-axis model
exists to prevent.

`checkbox`, `color_swatch` and `image_swatch` left this list in Stage 2a,
`text_field` in Stage 3b, `textarea` + `number_field` in Stage 3g, and
`file_input` in Phase 15 — **all fifteen presentations are now registered.**

### Two text types, one difference

`text_field` and `textarea` have **identical axes** — `text` / `none` / no
values. The only difference is whether a newline survives the resolver, which
`value_kind` cannot express, so `SelectionResolver::is_multiline()` keys on the
presentation for that one decision.

Measured before the distinction existed: an address typed as three lines was
stored as one run-on line.

### Numbers are not short text

`min`/`max` bound the **value**, not its length, and `step` describes a grid.
`"007"`, `"7"` and `"7.0"` are one quantity, so the resolver stores a canonical
form — which is also what lets two identical orders group into a single cart
line.

### ✏️ What text actually cost, versus what was predicted

This section used to say text needed *"a second resolution path through the
resolver, the cart, the pricing engine and the order — a stage of work, not a
registry entry"*.

**That estimate was wrong in both directions**, and the correction is worth
keeping because it is the kind of mistake that repeats:

- **Cheaper than predicted structurally.** The cart, pricing and order paths
  needed **no change at all** — `SelectionResolver` never reads `presentation`,
  `labels_for` already returned `{option, value}` strings, and `CartItemKey`
  hashes whatever payload it is given. The resolver needed **one branch**.
- **More expensive than predicted in a dimension the estimate missed entirely.**
  Text is the first value a **customer** supplies. Every type before it resolved
  against a merchant-authored `value_key`, and that lookup is what made the
  plugin's *"nothing here is trusted"* survivable — an unknown value was simply
  refused. Text removes that guarantee, so sanitising, output escaping, length
  enforcement and the counter's grapheme parity were the real work.

The lesson is not "estimates are hard". It is that a type's cost is not visible
from the registry: it is visible from **who supplies the value**.

---

## What options deliberately do not do

Two boundaries, stated here so they are decisions rather than discoveries.

### Optionia does not manage stock

**An option is not a SKU.** Modelling stock per option combination reintroduces
the exact combinatorial explosion that makes variants unusable — the problem
this product exists to solve. A free-text engraving has no stock. An uploaded
file has no stock.

What still holds, and is tested:

- **Product-level stock applies unchanged.** The add-to-cart filter returns any
  refusal it was handed **before** resolving anything, so a customer cannot order
  an out-of-stock product by configuring it. The plugin contains no stock logic
  at all — the guarantee is that one line, and
  `AdversarialAddToCartTest::test_a_refusal_by_woocommerce_is_never_overturned`
  is what holds it.
- **Variable products:** options layer *on top of* the chosen variation, and the
  variation's stock governs. Options never override it.
- **Backorder and stock-status messaging** stays WooCommerce's, untouched.

**Per-option stock is out of scope.** A merchant who needs it is asking for
variants, and should use variants.

### The storefront previews `fixed` prices only

A customer sees a live "+£5.00" beside the options as they choose — for `fixed`
prices. **The other four types show no estimate**, and the field simply carries
no running total until the cart.

| Type | Live estimate |
|---|---|
| `fixed` | **yes** |
| `percentage` | no — needs the product's base price, which the browser is not sent |
| `per_char`, `per_unit`, `tiered` | no — priced on the option, and the markup carries prices on values |

⚠️ **The estimate hides itself rather than showing a partial number.** A running
total that silently omitted a 50% surcharge would look complete and be wrong,
which is worse for a customer than no total at all.

**The price charged is always the server's**, and it is correct for all five
types. This is a display limitation, not a pricing one.

### One store, one currency

**A published amount is in the currency the store used when it was published,
and it is never converted.** The config document carries no currency field, by
design: a number meaning different things in two places is a rounding error
waiting to reach a merchant's revenue.

Complete for a single-currency store. Under a **currency switcher** — WOOCS,
Aelia, WPML Multicurrency — it is a limitation, and the price types split two
ways:

| Type | Under a switcher |
|---|---|
| `percentage` | **converts**, being relative to a base the switcher already converted |
| `fixed`, `per_unit`, `per_char`, `tiered` | do **not** convert — absolute amounts |

So "gift wrap +£5.00" charges **$5.00** when a customer switches to USD:
arithmetically correct, materially different.

⚠️ **Stated rather than fixed, deliberately.** The exchange rate lives inside the
switcher plugin, each with its own API — reading one means depending on software
this project does not control, and guessing one means charging a number nobody
configured.

**A merchant needing currency-relative option pricing has `percentage`**, which
converts correctly because it is relative. That is the honest workaround.

⚠️ **A live cart is the sharpest edge.** A delta is frozen as a count of minor
units at add-to-cart, and a currency change does not move it — measured, with the
base currency switched from 2 decimals to 0 between add-to-cart and checkout: a
line quoted at **85.00** charged **580**, because the frozen `500` meant £5.00
when quoted and ¥500 afterwards.

Nothing recomputes it, because recomputing is what the price freeze exists to
prevent. **Changing a store's currency is therefore not safe while carts are
live** — the same caveat WooCommerce's own price fields carry, for the same
reason.

## Presentational items

`heading`, `paragraph`, `divider`, `rich_text` — **not options.** No value, no
validation, no pricing, no cart data. They participate in exactly two systems:
ordering, and conditional visibility. ⚠️ **Only ordering is built** —
`RuleTargetType` is `option | group | value`, so nothing can target an item until
Phase 17's rule engine adds one. The pricing engine never sees one either way.

**A separate table, not a row in `options`** (M5.4c). Modelling them as options
with `value_kind: none` would force null-checks through the renderer, validator,
pricing engine, cart integration and order persistence — five subsystems paying
for one convenience.

| Kind | Renders as | Content | Authorable via API |
|---|---|---|---|
| `heading` | styled text | required | ✅ |
| `paragraph` | escaped text, newlines preserved | required | ✅ |
| `divider` | `<hr aria-hidden>` | **none** — empty is correct | ✅ |
| `rich_text` | *nothing* | — | ❌ **gated, see below** |

⚠️ **A divider is the one kind whose content may be empty.** Requiring one would
make a merchant type something meaningless to draw a line. Every other kind
refuses blank content, because a heading with no text renders as nothing — which
looks to the merchant like the item was never saved.

### 🔴 `rich_text` is gated, deliberately

Its content is merchant-authored **markup rendered on a public storefront** — an
XSS vector by construction. M5.4c requires a strict-allowlist sanitizer at
publish *and* at render before one can exist.

So the enum, the column and both serialization paths carry the value — storage is
ready — while **`AUTHORABLE_ITEM_KINDS` in the DTO is a deliberate subset** that
refuses it, and the plugin has no `rich_text.php`, so a document from a future
build renders nothing rather than raw markup.

**Both sides are pinned by tests.** Whoever adds the sanitizer must change
`presentational-items.spec.ts` and
`RendererTest::test_rich_text_renders_nothing_without_its_sanitizer` in the same
commit. Accepting the kind first and sanitising "later" is how the gap ships.

### Ordering

Items and options carry `sort_order` **on the same scale** and interleave: a
heading's only job is to sit above the right control. `Frontend\Renderer` merges
both lists and sorts them as one sequence, so drawing all options then all items
would silently discard the merchant's ordering.

The sort is **stable** — `usort` is not — so two entries sharing a `sort_order`
cannot swap between requests. A missing `sort_order` defaults to `PHP_INT_MAX`,
appending rather than hoisting entries from an older schema above deliberate ones.

⚠️ **A group holding only items still renders.** The renderer once dropped any
group with no options, so a group of pure explanatory copy drew nothing, with no
error anywhere.

---

## Adding a type

Measured while adding `dropdown`, so this is the real cost rather than an
estimate:

| Step | Where |
|---|---|
| 1. Registry entry | `optioniaWooCommerceBackend/src/option-sets/types/type-registry.ts` |
| 2. Axes row in the test table | `type-registry.spec.ts` — omitting it now **fails** |
| 3. Template | `optioniaWooCommercePlugin/templates/options/<type>.php` |
| 4. Template tests | `tests/unit/RendererTest.php` |
| 5. Authorable list | `optioniaWooCommerceFrontend/src/lib/schemas/option-sets.ts` |
| 6. This file | the row above, and one fewer below |

Steps 1–4 make it *supported*. Step 5 makes it **authorable**, and the bar there
is higher: the dashboard offers a type only when it can also re-open it. A type
whose editor does not exist would create option sets the UI cannot open again.

`bin/check-option-type-parity.sh` enforces these across the repositories:

- **The dashboard may lag the registry, never lead it.** Offering a type the API
  refuses is a merchant choosing something and being handed an error.
- **Every authorable type has a storefront template.** Without this a type can be
  registered *and* offered while the plugin has no template — and the plugin skips
  what it cannot render, so the storefront draws nothing and says nothing.

Both directions are asserted only where they matter: a template for a type that is
not yet authorable is simply work landing early, and passes.

The gate makes the **same** guarantee for presentational item kinds, in both
directions — a kind in `AUTHORABLE_ITEM_KINDS` with no template, and a template
with no matching kind. ⚠️ `rich_text` must appear in neither, and the gate reads
the DTO, so it stays correct whichever way that decision moves.

### Adding a presentational item kind

A different, shorter path — there is no registry entry, no Zod schema and no
pricing, because an item asks the customer nothing:

| Step | Where |
|---|---|
| 1. Enum member | `optioniaWooCommerceBackend/src/common/database/enums.ts` — `PresentationalKind` |
| 2. Allow it | `dto/presentational-item.dto.ts` — `AUTHORABLE_ITEM_KINDS` |
| 3. Template | `optioniaWooCommercePlugin/templates/presentational/<kind>.php` |
| 4. Template tests | `tests/unit/RendererTest.php` |
| 5. This file | the table above |

Step 1 makes it *storable*; step 2 makes it **creatable**. Keeping those separate
is what lets `rich_text` exist in the schema while no route can create one.

⚠️ **An unknown kind renders nothing and is logged**, exactly as an unknown option
type does — a plugin can legitimately be one release behind the cloud that
published the document. Rendering a fallback would be worse than rendering none.
