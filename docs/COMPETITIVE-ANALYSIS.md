# Competitive analysis

**M1.5's deliverable.** Deferred *"to before Phase 14"* by ADR-006; produced
2026-09-22, at Phase 21c, overdue nine phases (F6).

> ⚠️ **Read the method before the conclusions.** Four plugins were installed on
> the local Studio site and examined; two more were assessed from public
> documentation only, because they are not obtainable for free. Which is which is
> stated per plugin, because a weakness found by reading a marketing page is not
> the same fact as one found in the code.

---

## Method, and its limits

| Plugin | Installs | How it was assessed |
| --- | ---: | --- |
| YITH WooCommerce Product Add-Ons | 20,000 | **Installed.** Type registry read at `class-yith-wapo.php:207-320`; 220 files / 35.6k LOC measured |
| Extra Product Options (ThemeHigh) | 30,000 | **Installed.** Types grepped and cross-checked against the readme's own *"17 field types"*; 45 files / 9.5k LOC measured |
| Product Addons for Woocommerce (Acowebs) | 30,000 | **Installed.** Types grepped, not cross-checked; 29 files / 8.2k LOC measured |
| Flexible Product Fields (WP Desk) | 10,000 | **Installed, and least examined.** No type registry located; 538 files / 42.6k LOC measured |
| WooCommerce Product Add-Ons (Woo) | — | ⛔ **Not assessed in code.** Paid, woocommerce.com only |
| PPOM | — | ⛔ **Not assessed in code.** Not on the .org directory under any slug searched |

🔴 **The two unassessed plugins are the two M1.5 names first**, and that is the
honest gap in this document. WooCommerce Product Add-Ons is the incumbent a
merchant most likely compares against, because it is sold from within WooCommerce
itself. Buying a licence is the only way to close this, and it is a purchasing
decision rather than an engineering one.

🔴 **The plugin source was NOT retained, so most claims here are point-in-time**
(F43). The four were installed, read, and deleted to leave the site pristine — and
the backup taken beforehand holds the original twelve plugins, not the competitors.
`class-thwepof-admin-settings-pro.php`, cited below as proof that percentage pricing
is paywalled, **exists nowhere on this machine**.

📌 **One exception, and it is the one that mattered.** YITH's type registry is
captured verbatim in [`competitive-evidence/yith-types.md`](competitive-evidence/yith-types.md),
because its count was the document's central comparison and the first draft got it
wrong: the table said 15 and listed 14. Reinstalling to settle it showed the count
was right and the **list** was short — `label` is both a type *and* a key inside
every entry, so the filter that stripped the keys stripped the type with them.

⚠️ **What to do with an unverifiable claim.** Treat the WooCommerce-side facts as
checkable — `woocommerce_add_order_item_meta` is still confirmable in the installed
WooCommerce — and treat every competitor-side fact as a measurement someone took
once. Re-installing the plugin is the only way to re-check it.

⚠️ **Nothing here was activated.** The four were installed inactive and read as
source. Activating them on the site the canonical E2E depends on would have put a
green suite at risk for a comparison that static reading answers. **Admin UX
quality — one of M1.5's six documented items — is therefore NOT covered** and is
the second honest gap.

---

## Option types

| Plugin | Free types | Notable |
| --- | ---: | --- |
| YITH | **15** | `checkbox color colorpicker date file html_heading html_separator html_text label number product radio select text textarea` — read from `get_addon_types()`, [evidence captured](competitive-evidence/yith-types.md) |
| Extra Product Options | **17** | `checkbox colorpicker date email heading hidden label multiselect number paragraph password radio range select text textarea url` — plus 8 premium |
| Product Addons | **15** | `checkbox color date datetime email hidden image label number paragraph select text textarea time url` |
| Flexible Product Fields | ⛔ **not assessed** | Its type registry was never located. The only evidence gathered was a changelog line — *"Added new field types: checkbox, select and radio"* — which dates those three to a 2.x release but is **not a type list**. Presented as a count in the first draft; corrected 2026-09-22 (F45) |

📌 **Optionia ships 15**, so the *count* is at parity with the leaders — and the
verified YITH list makes the point sharper than the first draft did. **Four of
YITH's fifteen are not options at all**: `label`, `html_heading`, `html_text` and
`html_separator` ask the customer nothing and carry no value, no validation and no
price. Optionia models those as **presentational items** (M5.4c), deliberately
outside the type registry.

🔴 **So the honest comparison is 14 answerable types against 11.**

> **"Answerable" means the customer supplies the value.** A type that renders no
> control, or renders text the customer reads rather than fills, does not qualify.
> The test is stated here because it is this document's own metric, not an
> industry one — and it must be applied to **both** sides of a comparison in the
> same pass.
>
> ✏️ **This read "15 against 11" until 2026-09-22 (F47).** The test was invented
> for YITH, applied to YITH, and then *not applied to Optionia* — whose 15 includes
> **`hidden`**, of which the type registry says *"`SelectionResolver` ignores what
> is posted entirely… there is no customer input to validate."* By this document's
> own definition `hidden` is not answerable, so Optionia's figure is **14**.
>
> 🔴 **A number introduced while correcting a number.** The direction of the claim
> survives — Optionia leads by 3 rather than 4 — but the figure was wrong, and it
> had a tell: `hidden` is the one template excluded from M21c.2's style wiring,
> precisely because it renders no control.

Stating it as *"15 against 15"* still understates Optionia and flatters the
competition — which is what counting a separator as a feature does.

🔴 **`product` is the one type nobody else's list maps onto Optionia's.** YITH
lets an add-on *be another product*, which carries that product's stock and price.
Optionia deliberately does not manage stock ([M16.9](../developePlan.md)), so this
is a capability gap and a scope decision, not an oversight — but a merchant
selling "add a gift box (SKU GB-01)" will notice.

---

## Pricing models

| Plugin | Fixed | Percentage | Per-character | Quantity-multiplied |
| --- | :-: | :-: | :-: | :-: |
| YITH | ✅ | ✅ | ✖ | ✅ (`multiplied`) |
| Extra Product Options | ✅ | ⚠️ **premium** | ✖ | ✖ |
| Product Addons | ✅ | ✖ found | ✖ | ✖ |
| Flexible Product Fields | ✅ | ✅ | ✖ | ✖ |
| **Optionia** | ✅ | ✅ | ✅ | ✅ |

🔴 **Percentage pricing is premium-gated in Extra Product Options.** Found in
`admin/class-thwepof-admin-settings-pro.php` — the filename is the evidence. A
merchant on the free tier gets fixed amounts only.

🔴 **No competitor examined implements per-character pricing.** Optionia's
`per_char` with [M11.1a](../developePlan.md)'s one normative measure function is,
on this sample, a genuine differentiator — and engraving is the canonical use case
for product options.

---

## Conditional logic

| Plugin | Files touching "conditional" |
| --- | ---: |
| YITH | 10 |
| Extra Product Options | 9 |
| Flexible Product Fields | 6 |
| Product Addons | **3** |

⚠️ **This is a proxy, not a capability measure.** File count says where the
concern lives, not whether the engine is cycle-safe, server-enforced, or able to
express group-level rules. Judging that needs the plugins activated and exercised,
which this pass deliberately did not do.

📌 **What it does suggest:** conditional logic is table stakes — every plugin has
some. Optionia's claim has to be *correctness* (cycle-safe, server-enforced), not
presence. That is [Phase 17](../developePlan.md)'s ground, and F4 — rejection of a
hidden option — is still open, so the claim is not yet fully earned.

---

## Cart and order integration

**Every one of the four uses `woocommerce_get_item_data`.**

🔴 **This independently confirms ADR-111.** Optionia's cart breakdown reaches the
classic cart, Cart block, mini-cart and Checkout block summary through that single
filter, and the competitive field agrees it is *the* integration point. A cart
drawer plugin that renders its own markup is not reading a private API — it is
reading the same filter everybody uses.

⚠️ **Two of four still write order meta through `woocommerce_add_order_item_meta`,
deprecated in WooCommerce 3.0.0** — verified in
`woocommerce/includes/class-wc-deprecated-action-hooks.php:68`:

| Plugin | Order-meta hook |
| --- | --- |
| Extra Product Options | ⚠️ `woocommerce_add_order_item_meta` (deprecated 3.0.0) |
| Flexible Product Fields | ⚠️ `woocommerce_add_order_item_meta` (deprecated 3.0.0) |
| Product Addons | ✅ `woocommerce_checkout_create_order_line_item` |
| YITH | — neither found; writes elsewhere |
| **Optionia** | ✅ `$item->add_meta_data()`, the CRUD path — HPOS-safe under both storage modes |

**This is the sharpest weakness found.** A deprecated hook is a latent HPOS
problem, and HPOS is where WooCommerce is going.

---

## Where each is weak

**YITH** — the most complete free offering here, and the only one with
quantity-multiplied pricing. 35.6k LOC of it. Weakness: size is the weakness. An
add-on that can *be a product* drags stock, pricing and fulfilment into a feature
merchants reach for casually.

**Extra Product Options** — the largest free type list (17). Weakness: **percentage
pricing is paywalled**, which is the second pricing model a merchant asks for, and
its order meta uses a hook deprecated in 2017.

**Product Addons for Woocommerce** — the cleanest order integration of the four
(`checkout_create_order_line_item`). Weakness: the thinnest conditional logic
(3 files), and no percentage pricing found at all.

**Flexible Product Fields** — 538 files and the heaviest premium gating (68
pro-named files). Weakness: basic types like `checkbox`, `select` and `radio`
arrived in a **2.x** release, which says the free tier was long a text-field
plugin; plus the deprecated order-meta hook.

---

## What this means for Optionia

✅ **Three defensible differentiators**, each evidenced above rather than asserted:

1. **Per-character pricing** — nobody in this sample has it, and engraving is the
   canonical options use case.
2. **HPOS-correct order writes** — half the sample is on a hook deprecated since
   WooCommerce 3.0.0.
3. **Cloud authoring with a projection storefront** — none of these is
   multi-store; all four author in wp-admin, per site.

⚠️ **Two things this analysis does NOT support claiming:**

- **"More option types."** Extra Product Options ships **17** free, against
  Optionia's 15. ⚠️ **Even on the answerable-types reading** — where YITH is 11,
  not 15 — EPO's list is its own mix of inputs and display fields (`heading`,
  `paragraph`, `label`), and this analysis never separated them the way it did
  YITH's. The claim is unsupported until someone does. The defensible sentence is
  about **modelling**, not count, and it is a harder one to sell.
- **"Better conditional logic."** Every plugin has some, and F4 means Optionia's
  server-side rejection is still open. The claim is not yet earned.

📌 **Two questions this leaves open**, both for [M1.6](../developePlan.md):
whether `product`-as-add-on is a gap worth closing given M16.9's no-stock
position, and whether the pricing page's promises match what the code delivers —
which is the Gate 2 criterion this milestone was blocking.
