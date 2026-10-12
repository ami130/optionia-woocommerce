# Printed packing slip — Gate 2

> **Gate 2 criterion:** *"Fulfilment output verified on a printed packing slip"*
>
> The plan's own note on it: *"verified **from WooCommerce's source**, not from a
> printed slip. **A code-path argument is not the physical check this names.**"*
>
> Scope, from the gate block: **one order, one print.**

This separates what the code already guarantees from what only paper settles.
Check the second list on the slip itself.

---

## What the code guarantees — do not re-test these

Each was verified in source, and a printed slip cannot disprove them:

- **Selections are order ITEM meta, written through the CRUD API.**
  `$item->add_meta_data()` rather than `wc_add_order_item_meta()`, which keeps
  it identical under HPOS and legacy. Order item meta lives in
  `woocommerce_order_itemmeta` under both — HPOS moves *order* meta, not item
  meta. Measured in Phase 4 on orders #29 and #31.
- **Internal keys are hidden.** `_optionia_selections`,
  `_optionia_option_set_id` and `_optionia_option_sets` all carry the leading
  underscore WooCommerce treats as private, so they do not render. The
  customer-facing label and price are written without one, which is what makes
  them visible.
- **The price is already in the value**, assembled before the slip ever
  renders: `with_price()` returns `value (+£x.xx)` for a positive delta and
  `value (-£x.xx)` for a negative one.
- **A free option carries no price artefact.** `with_price()` returns the bare
  value when the delta is null or zero, so `+£0.00` cannot reach a slip.

---

## 🔴 What a printed slip will NOT show, and should not be expected to

⚠️ **Read this before printing, or the check produces a false failure.**

The order screen's Optionia additions hang off
**`woocommerce_after_order_itemmeta`**, an **admin-screen** hook. Packing slips
are rendered by a separate plugin (PDF Invoices & Packing Slips, Print Invoice,
WooCommerce's own print view) and **that hook does not fire there**.

So these are absent from a slip **by design**:

| Absent from the slip | Where it lives instead |
|---|---|
| The print-file **Download** button | Order screen (`Admin\OrderFiles`) |
| *"Could not be generated…"* failure notice | Order screen (`Design\PrintFiles`) |
| The *Incomplete* row naming a missing layer | Order screen (F173) |
| Bulk download button | Order screen toolbar |

**A slip missing these is correct.** The criterion is about the *selections*
reaching fulfilment, not about the admin UI reaching paper.

📌 **If you want the print file on the slip**, that is a feature nobody has
specified — raise it as one rather than failing this check.

---

## What to check on the printed page

Place one order with at least: **one priced option, one free option, one text
input, and one uploaded file** if uploads are configured. Then print the slip.

```text
[ ] Every option the customer chose appears, by its own label
[ ] The labels are the merchant's wording, not internal ids or slugs
[ ] A priced option shows its price in the same cell as its value
[ ] Text input appears in full, not truncated mid-word
[ ] Long text wraps rather than running off the page edge
[ ] No underscore-prefixed key is visible anywhere
[ ] No raw JSON is visible anywhere
[ ] Quantity and line total read correctly beside the options
[ ] The options sit with their line item, not orphaned at the bottom
[ ] A second line item's options are not mixed into the first
[ ] It is legible at the size it actually prints — not only on screen
```

⚠️ **The last one is the reason this criterion exists.** Everything above can be
argued from source; whether a merchant can read it at the press cannot.

---

## If something is wrong

Record **which slip plugin** produced it. They render meta differently, and a
defect in one may be absent in another — so the plugin name is part of the
result, not context.

Keep the printed page. A photograph of the failure is the evidence this
criterion wanted, and the thing a code-path argument could never supply.

---

## Closing it

The gate block's rule: *"a tick with nothing after the dash is a tick nobody can
check."* So the evidence is the order number, the slip plugin and its version,
and the date printed.
