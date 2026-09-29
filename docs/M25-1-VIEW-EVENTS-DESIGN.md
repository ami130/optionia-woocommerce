# M25.1 — view events: the design, before any code

**Status: a proposal for review. Nothing here is built.**

Written 2026-09-29, as Phase 25's last open stage (25-4). Every claim below was
checked against the code rather than recalled; where something was measured, the
measurement is given.

---

## 1. What the milestone asks for, and what it is worth

> **M25.1** event ingestion (option views, selections, add-to-cart, order) —
> batched from the plugin, never blocking a page render.

**What it unlocks is one sentence on one screen.** M25.3 asks for *"conversion
with vs. without options"*, and that is unanswerable today (F157): a conversion
rate needs a denominator of **views**, and nothing records one. The analytics
page ships average order value instead and deliberately never uses the word
*conversion*, because calling an order-value comparison a conversion rate would
claim a measurement nobody took.

**Everything else M25.1 names is already recorded.** `order_events` and
`order_selections` carry orders and selections; attach rate is computed from them
today. So the honest scope of this milestone is **views**, plus **add-to-cart** if
it is free — and it is not free, which §7 explains.

---

## 2. The constraint that decides the whole design

> **Exit:** … *ingestion never affects storefront performance.*

Phase 25's own exit criterion. It is currently met **structurally**, not by
care: `OrderReporter::queue()` appends an id to an option and returns, and all
HTTP happens on cron where nothing is waiting.

🔴 **That mechanism cannot be reused for views, and the reason is arithmetic.**
An order is rare — a shop with a 2% conversion rate writes one order per fifty
page views. A view is *every product page load*. Reusing the queue means:

| | Orders (today) | Views (naive reuse) |
|---|---|---|
| Writes per 1,000 product views | ~20 | **1,000** |
| Written to | `wp_options` | `wp_options` |
| Who waits | nobody (cron) | **the customer** |

⚠️ **And `wp_options` is the worst possible destination.** The order queue is
stored with `autoload = false` precisely so WordPress does not read it on every
request. A view queue in the same table grows a thousand times faster, and every
append is a write to a table that is locked by every other plugin on the site.

**So the naive design fails the exit criterion, and it fails it on the merchant's
own server rather than ours.**

---

## 3. What is already true, verified

| Fact | Evidence |
|---|---|
| Nothing exists yet | `grep -rln "sendBeacon\|beacon\|pageview\|impression"` matches **nothing** in any repository |
| PHP render path **may not** touch the network | `check-architecture.sh` AC3 matches transports (`wp_remote_`, `Api\Client`, `curl_`, …), not filenames, so a new way to reach the network is caught without anyone remembering |
| The storefront JS already makes network calls | `frontend.js` uses `XMLHttpRequest` — but to **WordPress**, for a customer-initiated file upload, not to the cloud and not on every load |
| The store credential **never reaches the browser** | `grep` for `store_token\|api_key` in `src/Frontend/` matches nothing; `StoreTokenGuard` authenticates plugin → cloud only |

🔴 **That last row is the security constraint.** A beacon posted straight to the
cloud would need either the store secret in page source — readable by anyone —
or an unauthenticated endpoint that accepts view counts for any store, which is
a free vandalism tool against every merchant's analytics.

---

## 4. The proposal

**A browser beacon to the merchant's own WordPress, aggregated in the plugin,
shipped to the cloud on the existing cron drain.**

```
   customer's browser                 merchant's WordPress            cloud
┌────────────────────┐          ┌──────────────────────────┐    ┌───────────┐
│ option becomes     │ sendBeacon│ admin-ajax / REST route  │    │           │
│ visible → count 1  ├──────────►│ increments an in-memory  │    │           │
│                    │  (async,  │ counter, returns 204     │    │           │
│ page unload →      │  unblocked│                          │    │           │
│ one beacon, all    │           │ flushed to a COUNTS row  │    │           │
│ options on page    │           │ every N seconds          │    │           │
└────────────────────┘          └────────────┬─────────────┘    │           │
                                             │ cron drain        │           │
                                             └──────────────────►│ /v1/views │
                                                  (existing      │           │
                                                   store token)  └───────────┘
```

**Four properties, each answering a constraint above:**

1. **The beacon never blocks.** `navigator.sendBeacon` hands the payload to the
   browser and returns immediately; the page unloads without waiting. No
   `fetch`, no `await`, nothing on the critical path.
2. **The PHP render path is untouched.** The receiving route is a *separate
   request*, so AC3 holds by construction — the renderer still names no
   transport.
3. **The credential stays server-side.** The browser talks only to the site it
   is already on; the plugin holds the store token as it does today.
4. **The cloud sees counts, not events.** One row per store per option per day,
   not one per view — which is the difference between thousands of writes and
   one.

---

## 5. What is counted, and when

🔴 **A "view" is an option becoming visible, not a page load.** They differ, and
the difference is the whole point: a product page with no Optionia options is not
a view of anything, and counting it would deflate every merchant's conversion
rate by however many products they have not configured.

⚠️ **One beacon per page, sent on unload — not one per option.** A product with
twelve options must not produce twelve requests. The payload is one array:

```json
{ "store": "<site-scoped nonce>", "day": "2026-09-29",
  "views": [ { "set": "<uuid>", "options": ["engraving", "finish"] } ] }
```

📌 **`visibilitychange` rather than `unload`.** Safari has never fired `unload`
reliably and mobile browsers freeze pages instead of unloading them;
`visibilitychange → hidden` is the event that actually fires. This is the one
detail most beacon implementations get wrong.

---

## 6. What is deliberately NOT counted

🔒 **No customer, no session, no identifier of any kind.** M25.6's rule is that a
rollup may carry `valueKey` and never `valueLabel`, and views must introduce no
new personal data. A view row is `(store, option_set, option_key, day, count)` —
there is nothing in it about a person, which is why it needs no consent banner
and no retention policy beyond the one analytics already has.

⚠️ **No per-value views.** Counting which *value* was displayed would multiply
the row count by the option's cardinality for no question anyone asked. Views
answer *"how many people saw this option"*, and selections — already recorded —
answer *"which value did they choose"*.

---

## 7. Add-to-cart: recommended OUT of this milestone

M25.1 names four event types. Three are settled — views here, selections and
orders already recorded. **Add-to-cart is the fourth and does not belong in it.**

🔴 **It is a different mechanism with a different failure mode.** WooCommerce's
add-to-cart is a server-side action with its own hook, so it needs no beacon at
all — but it fires mid-request, on a path the customer *is* waiting on, and the
queue-on-cron pattern that makes orders safe would put a write into that path.
Doing it properly means the same aggregation this document proposes, against a
different trigger, and bundling the two would mean shipping neither until both
are right.

📌 **And the value is asymmetric.** Views unlock conversion, which is a named
M25.3 deliverable. Add-to-cart unlocks cart-abandonment analysis, which no
milestone asks for.

---

## 8. Cost, stated honestly

| | |
|---|---|
| **Plugin** | a beacon in `frontend.js`, a receiving route, an aggregation table, a cron flush — and **no PHP on this machine**, so every line is CI-verified only |
| **Backend** | one endpoint, one table, one migration, and the analytics query that reads it |
| **Dashboard** | the conversion figure M25.3 asked for, replacing the average-order-value substitute |
| **Risk** | the receiving route is the first thing in this product a *customer's browser* calls on an ordinary page load; it must be rate-limited per site and must never write synchronously |

⚠️ **The single biggest risk is not correctness, it is the write path.** If the
receiving route writes to the database on every beacon, this design has moved the
problem from the render request to a sibling request on the same server and
solved nothing. The flush must be time-based and batched, and that is the part to
review hardest.

---

## 9. What I need from you before building

1. **Is the conversion figure worth a beacon on every product page?** It is the
   only thing M25.1 unlocks that is not already recorded. If the honest answer is
   *"average order value is enough"*, then M25.1 should be **closed as declined**
   rather than left open — which is a legitimate outcome and cheaper than this.
2. **Add-to-cart out of scope, as §7 argues?**
3. **Is a beacon to the merchant's own site acceptable**, given the storefront
   currently makes no automatic network call at all?

📌 **Recommendation: build views, decline add-to-cart.** But question 1 is real
— if conversion is not worth it, declining M25.1 with its cost recorded closes
Phase 25 as honestly as building it does.
