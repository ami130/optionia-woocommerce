# What ships — for reconciling against the pricing page

> **Gate 2 criterion:** *"Every pricing-page promise either delivered or
> corrected."*
>
> ⚠️ **This document is only half of that.** The pricing page lives in
> `optionia-websites`, a repository this project does not contain, so nothing
> here can say whether a promise is *kept* — only what the code actually does.
> Put the two side by side and the comparison is mechanical.

Every figure below was read from source on 2026-10-12, not from memory. Where a
gate proves a claim, the gate is named: a claim with no mechanism behind it is
the kind that rots.

---

## Plans and prices

Read from `src/seeds/plans.seed.ts`.

| | Free | Pro | Business |
| ---------------- | ---- | ------------- | -------------- |
| Monthly | £0 | **£29** | **£79** |
| Yearly | £0 | **£290** | **£790** |

📌 **Yearly is the only sellable interval.** `check-billing-interval.sh` asserts
it in three places: *"the sellable set is declared once, and it is yearly"*, and
*"all 3 purchase path(s) refuse an unsellable interval"*. **A pricing page
offering monthly billing would be selling something checkout refuses.** The
monthly figures above exist in the seed as a per-month display price for a
yearly plan — if the page presents them as a billing choice, that is a
correction, not a delivery.

---

## Limits, per plan

| Limit | Free | Pro | Business |
| ------------------ | ---- | --------- | --------- |
| Option sets | 10 | 50 | unlimited |
| Products assigned | 20 | unlimited | unlimited |
| File storage | 100 MB | 5 GB | 25 GB |
| Stores | 1 | 3 | 10 |
| Team seats | 1 | 3 | 10 |

✅ **All five are enforced, not merely declared.**
`check-billing-provider.sh` asserts *"every enforceable plan limit is guarded on
its creation path"*.

🔴 **File storage is enforced differently and the distinction matters for
wording.** The cloud cannot refuse an upload — the bytes are written to the
merchant's own WordPress and never reach us — so `uploads_allowed` travels down
on the heartbeat and the **plugin** refuses. A page promising *"we block
uploads over your limit"* is accurate in effect; one implying the service
stores or inspects files is not.

---

## Features, per plan

| Feature | Free | Pro | Business |
| ------------------ | ---- | --- | --- |
| Conditional rules | ✅ | ✅ | ✅ |
| Analytics | ❌ | ✅ | ✅ |
| Rich text / HTML | ❌ | ❌ | ✅ |

⚠️ **Conditional rules are on every tier including Free.** A pricing page using
them to differentiate tiers would be describing a product that does not exist.

---

## Option types

**15 types ship**, and that number is gated three ways by
`check-option-type-parity.sh`: every authorable type is registered in the API,
has a storefront template, and agrees across five sources. A page claiming more
than 15 is wrong; one claiming fewer is leaving something unsold.

---

## Claims to check especially carefully

These are where a marketing page most easily overstates, and what the code
actually supports:

- **"Works with any theme."** Measured on five: Storefront, Twenty
  Twenty-Four, Twenty Twenty-Five, Astra, Kadence. ⚠️ **Flatsome and Woodmart
  are commercial and untested** — see the M26e.3 theme matrix. And F207 was a
  total runtime failure on both block themes until 2026-10-12, so "any theme"
  is a claim this product earned very recently and on five examples.
- **"No code required."** Gate 2's own open criterion is *"builder usable
  without documentation, validated on 3 non-team testers"* — **not yet
  validated**. The claim may be true; it is currently untested.
- **Multi-currency.** `M16.7` in `developePlan.md` governs whether option
  prices convert or are fixed per currency. Check what the page implies.
- **Stock / inventory.** `M16.9` in `developePlan.md` states
  deliberately that *"Optionia does not manage stock"*. A page implying
  inventory control contradicts a recorded decision.
- **Anything about a printed packing slip.** The breakdown reaches order item
  meta and WooCommerce renders it, but the fulfilment document is produced by a
  third-party plugin — see `docs/PACKING-SLIP-CHECK.md` for what is and is not
  guaranteed.

---

## How to use this

For each promise on the live page, mark it **delivered** (a row above supports
it), **corrected** (the page needs changing), or **open** (neither — it needs a
decision). The criterion closes when none are open.

📌 **A promise this document cannot answer is not automatically broken.** It
means the claim is about something outside the code — support response times,
roadmap, uptime — and belongs to whoever writes it.
