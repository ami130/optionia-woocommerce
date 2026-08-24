# Phase 4 Probe — throwaway diagnostic

⚠️ **Not production code.** A hardcoded, heavily instrumented prototype whose only
job was to learn the WooCommerce data path before a network, a cache or a config
schema existed to confuse the diagnosis.

Kept here so it survives a Studio site rebuild. It is **not** part of the plugin
and must never be referenced by it.

## Why it still exists

[Phase 10](../../developePlan.md#phase-10--storefront-renderer) builds the real
storefront renderer. Being able to re-run this probe alongside it is useful —
comparing a known-good hook trace against new code is faster than reasoning about
why options fail to appear.

**Delete this directory at the end of Phase 10.**

## What it found

Four assumptions were proven wrong by running it. Full detail in
[docs/woocommerce-notes/prototype-findings.md](../../docs/woocommerce-notes/prototype-findings.md).

1. The session-restore hook is defensive, not load-bearing —
   `before_calculate_totals` is what actually preserves the price.
2. A leading underscore does not hide order meta from the admin screen; that
   needs `woocommerce_hidden_order_itemmeta`, and the payload renders as an
   **editable field**.
3. Checkout does not re-validate selections against config — a deleted option
   completed a $100 order.
4. Type-checking the reorder path is not enough: reorder carries the selection in
   order item meta, not `$_POST`, so a `$_POST`-only validator blocks it entirely.

## Running it

```bash
cp -r tools/phase4-probe \
  ~/Studio/optionia-woocommerce/wp-content/plugins/optionia-phase4-probe
cd ~/Studio/optionia-woocommerce
studio wp plugin activate optionia-phase4-probe
```

Hook traces are written to `wp-content/optionia-probe.log`, one line per fire,
with a per-request counter. That counter is how the "`before_calculate_totals`
fires 5 times per request" finding was measured.

### Environment requirements

Both of these silently prevent testing and produce symptoms that look like plugin
bugs:

| Setting | Required | Symptom if wrong |
|---|---|---|
| `woocommerce_coming_soon` | `no` | Product pages render a placeholder; **no product hooks fire at all** |
| A shipping method in zone 0 | present | Checkout returns HTTP 400, *"this order requires a shipping option"* |

It attaches to product **20** (simple) and **23** (variable). Those ids are
hardcoded in `optionia_probe_product_ids()`; change them if the test store is
rebuilt.

## The one dependency

It uses `Optionia\Support\Money` from the real plugin, which must therefore be
active. That was deliberate: computing prices with floats teaches the wrong
reflex even in throwaway code, and produces numbers that cannot be compared
against the fixtures in
[M11.4](../../developePlan.md#m114--cross-language-fixture-suite).

Nothing else from the plugin is touched — no `Api\Client`, no
`Config\Repository`, no `Engine\`, no templates.
