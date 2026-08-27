# optionia-app → WooCommerce: Full Analysis & Port Plan

> **What this file is:** a complete, evidence-based analysis of the existing **Shopify** app
> (`optionia-app/`) — every feature, every subsystem, every line of its own documentation —
> followed by a **plan** for building the same product on WooCommerce: what ports, what must
> be rebuilt, what must be redesigned because WooCommerce is not Shopify, and in what order.
>
> **Created:** 2026-08-27 · **Revised:** 2026-08-27 (second pass — deeper code audit)
>
> **Analysis basis:** all 11 `.claude/*.md` docs read in full, both `docs/*.md`, the code
> itself (routes, modules, types, contexts, utils, extensions, assets), plus the three
> existing WooCommerce planning docs and the two WooCommerce repos already scaffolded here.
>
> **No code was written and nothing was changed.** This is analysis + plan only.

### Revision note — what the second pass changed

The first pass leaned on the app's own `.claude` docs. A second pass went to the **code**,
and found five material errors and four missed subsystems. Corrections are marked
**`[CORRECTED]`** and gaps **`[ADDED]`** throughout, and summarized in §11 so nothing is
buried.

| | First pass said | Actually |
|---|---|---|
| Upload 504 on 90–100 MB | listed as an open problem | **SOLVED** — a direct-upload route bypasses the proxy (§3.9) |
| Observability | "no error tracking" | **Sentry is wired**, client + server (§3.19) |
| GDPR | "redact nulls PII, non-PII retained" | **Materially non-compliant** — a verified erasure gap (§3.12) |
| Feature count | 15 option types, ~45 features | plus **4 subsystems I missed entirely** (§3.16–3.19) |
| Storefront bundles | one runtime | **two** — a separate cart-pricing bundle (§3.14) |

---

## ⚠️ 0. Read this first — the most important finding

**Two independent plans for this product already exist in this workspace, and they
contradict each other on the single most consequential question: whether the Shopify app is
the input to the WooCommerce build.**

| | What it says |
|---|---|
| **`developePlan.md` (5,976 lines), `optioniaWooCommerceBackend/docs/DECISIONS.md` ADR-001** | **"This project is standalone… starts from zero… Nothing in this project touches, reuses, imports from, extends, migrates, or depends on"** the other `parselabllc/` directories. *"There is no legacy to port, no existing schema to inherit, and no prior implementation to extract business logic from."* The design input is *"the competitive teardown, not a prior implementation."* |
| **Your request** | Analyze `optionia-app` fully and produce a plan to build it for WooCommerce. |

These cannot both be true — but the reason is narrower and more interesting than it first
appears. **[CORRECTED — third pass]** ADR-001 justifies itself by saying the sibling
directories are *"a marketing site and a blog CMS."* I initially called that factually wrong.
**It is factually right — about the repos it was actually looking at.** Verified on disk at
`/Users/omihasan/Desktop/parselabllc/`:

| Sibling repo | What it actually is | Shopify refs |
|---|---|---|
| `optionia-backends` | NestJS **marketing-site CMS** — blog, pages, categories, tags, testimonials, pricing, privacy-policy, terms, robots/sitemap, contact, partner | **none in `src/`** |
| `optionia-websites` | Next.js **public marketing site** — `/blog`, `/pricing`, `/features`, `/about`, `/contact`, `/partner` | only SEO copy + an icon |
| `optionia-dashboards` | Vite/React **admin panel** for that CMS (generic CRUD scaffolding) | **none** |

So ADR-001's *reasoning* is sound and its conclusion — "don't couple a CMS deploy to merchant
storefronts" — is correct. **The error is one of scope, not judgement: it surveyed three
marketing repos and concluded there was no prior implementation, while the actual product,
`optionia-app`, sits inside this very workspace and was never assessed.**

That distinction matters, because it means ADR-001 doesn't need reversing — it needs
**amending to name the fourth repo**. `optionia-app` is the same product: a mature
~68,700-line Shopify product-options app whose feature set maps almost one-to-one onto the
WooCommerce roadmap's phase list. The "standalone from the marketing stack" decision stays;
the "no prior implementation exists" premise does not survive contact with it.

**→ Decision required (§10, D-A).** ADR-001 needs amending, or an explicit "we know, and we
still want greenfield." Everything else follows from that answer. This plan is written for
**"port the domain, rebuild the platform"** — recommended, for a reason the second pass made
much stronger:

> The Shopify app is not a feature list. It is **years of solved edge cases**, and its docs
> record them with file:line precision — 8 numerically-verified pixel-parity fixes, a
> plan-downgrade model that silently destroyed merchant data before it was fixed, two URL
> validators that looked obviously correct and were exploitable, an auth bug misdiagnosed as
> "benign" for two weeks before being properly root-caused. **Rediscovering those on
> WooCommerce is the largest avoidable cost in this project.**

**Second finding:** the WooCommerce build is **not at zero** (§8). The backend has 162
source files, 32 entities, 5 migrations, 7 controllers and ~30 commits through Phase 7. The
plugin has a complete Phase 3 foundation. Any plan starting from "create the repos" is
already stale.

---

# PART I — WHAT `optionia-app` IS

## 1. The app in one paragraph

Optionia is a Shopify **product-options / customization** app. A merchant builds **Option
Sets** (groups of options — text fields, dropdowns, swatches, date pickers, file uploads),
assigns each to products, and Optionia renders them on the storefront product page via a
theme extension. Priced selections become **add-on charges** applied through a Shopify
**Draft Order**. Everything is plan-gated (Free / Advance / Pro) in the UI *and* on the
server. On top sits a **Design Lab** — a canvas editor where the merchant composes artwork
on the product photo, which the customer personalizes live and which is baked into a flat
image on the order.

## 2. Repository & folder inventory

```
optionia-app/                          Shopify embedded admin app — React Router v7 (Remix descendant)
├── .claude/            11 md files   ← the real documentation. 2,207 lines.
├── docs/                2 md files   ← security.md (PCD Level-2) + storefront-debug-tools.md
├── app/                297 files     ← 68,669 LOC of ts/tsx/js/css
│   ├── routes/          39 files     admin pages · webhooks · app-proxy · auth · support · events
│   ├── api/             28 files     resource-route handlers + merchantApi client (1,138 LOC)
│   ├── modules/         35 files     server-only domain logic (*.server.ts)
│   ├── components/      93 files     admin UI (editor, design lab, preferences, 19 skeletons)
│   ├── storefront/      14 files     ★ FRAMEWORK-AGNOSTIC RENDERING CORE — 4,438 LOC
│   ├── assets/          29 files     ★ storefront client runtime — 6,397 LOC (TWO bundles)
│   ├── config/i18n/      9 files     admin UI i18n (en/es/it/zh-CN)
│   ├── context/          5 files     plan gates · upgrade modal · admin lang · settings · SUPPORT MODE
│   ├── core/redis/       3 files     cache-aside client + key registry
│   ├── types/            8 files     ★ THE DOMAIN MODEL — platform-independent
│   ├── hooks/, utils/               incl. rate-limit, sentry, support-session, embed-context
│   └── db.server.ts / shopify.server.ts / routes.ts
├── extensions/
│   ├── optionia-storefront/         theme extension: 3 liquid blocks + THIN loader + locales
│   └── optionia-tools/              Shopify Sidekick (AI) ui_extension — 3 read-only tools
├── prisma/schema.prisma  1,060 lines  MASTER DB: 41 models, 10 enums
├── storefront-assets/               built bundles served from the app origin (JS-hosting Phase A)
└── scripts/build-storefront-manifest.mjs
```

**Two sibling repos referenced but NOT in this workspace:**
- `optionia-app-admin` — Next.js internal admin panel (plans, FAQs, tutorials, onboarding, media, the plan matrix), JWT + 2FA, **CSV export/import across 7 content modules**.
- `optionia-app-api` (`backend/`) — **Express** API owning the per-merchant MySQL DBs, Redis, DO Spaces, order pipeline. Reached over HMAC.

> **This matters:** the Shopify product is already a **3-service SaaS**, not a monolith. The
> WooCommerce target (NestJS backend + Next.js dashboard + PHP plugin) is *the same shape*
> with the embedded app replaced by a standalone dashboard and a plugin. Strong signal the
> architecture is right.

## 3. Complete feature inventory

### 3.1 Option Sets
- **Status:** `active` (rendered) / `draft`. No trash/archive — delete is a confirmed hard-delete.
- **Active cap:** the plan's option-set limit also caps how many may be *active*. A downgraded merchant over cap gets a **blocking reconciliation modal** (keep N, rest → draft, nothing deleted), and the storefront never renders more than the cap. *(Storefront cap ordering is currently "first N in list order" — flagged as arbitrary.)*
- **Product assignment — 3 modes:** `all` · `selected` (Shopify ResourcePicker; **only GIDs stored**, display metadata re-fetched live) · `automated` (tag / product_type / vendor / title / collection with AND/OR, evaluated at request time; Advance+).
- **Duplication** (single + bulk) — Advance+; UI-gated *and* server-enforced (403); respects the count limit.
- **Per-set custom CSS** — Advance+; scoped to the set's unique id.

### 3.2 Option types — 15 in the enum, 14 creatable
| Group | Types | Plan |
|---|---|---|
| **Input** | `text-input`, `text-area`, `number` | All |
| | `date-picker` (format + 4 min/max modes), `file-attachment` | Advance + Pro |
| **Choice** | `radio` (always single), `dropdown` (always single), `checkbox` (always multi) | All |
| | `color-swatch`, `image-swatch` — merchant picks single **or** multi | All (multi = Advance+) |
| **Static** | `heading`, `paragraph`, `divider` | All |
| | `html` | **Pro** |
| *legacy/inert* | `header-divider` (DB alias for heading); `button-select`, `dimension`, `toggle` in the enum but **not creatable** | — |

Codified in helpers: `isChoiceType()`, `isAmbiguousSelectionType()`, `getFixedSelectionMode()`.

### 3.3 Option configuration
- **Universal:** `name`, `required`, `placeholder`, `sortOrder`, `isHidden` (hidden on storefront, still editable in admin).
- **Gated:** `description`/`helpText` (+ position) · `minLength`/`maxLength` · `minValue`/`maxValue` · `minimumSelection`/`maximumSelection` · `minDate`/`maxDate` (modes: none/today/designated/fixed-days) + `dateFormat` · `pricePerCharacter` · `pricePerNumber` · `additionalPrice` · `filePrefix`/`fileMaxSizeMB`/`allowedFileTypes` · `isLivePreview` + `designedData` (Pro) · `selectionMode = multi`.
- **Per-choice:** `label` + `value` (both required, unique — duplicates auto-suffixed *and* save-blocked, because a duplicate value breaks storefront swatch/select and form submit) · `additionalPrice` · `isDefault` · `childOptions`.

**One detail worth copying verbatim:** the `fixed-days` date mode stores **`minDateAnchor` /
`maxDateAnchor`** — the ISO date the merchant *set* the value, frozen. "4 days" set on 25 Aug
means 25–28 Aug, **not** a window sliding forward every morning. Options saved before the
field existed keep counting from today, so no live storefront changed underneath a merchant.
Invisible until a merchant complains; already solved.

### 3.4 Multi-level options — Pro
In a **single**-mode choice option, each choice can carry **child options** revealed on
selection. Children are full `Option` rows with `parentChoiceId`. **The data model supports
unlimited nesting; the editor exposes one level.** Gated on create; **frozen** on edit so
grandfathered nesting is never destroyed.

### 3.5 Add-on pricing — the Shopify Draft Order path
1. Storefront JS assembles the cart payload.
2. `POST → apps.optionia.api.create-draft-order` (app-proxy, HMAC-verified).
3. Server **recomputes every add-on price** from stored config using the selected **values
   only** — never trusting client prices — and builds the draft with per-line
   `priceOverride = base + addon`. Base is **re-fetched from Shopify**.
4. Returns `invoiceUrl`; the customer pays there.
5. `webhooks/orders/create` fires on conversion → order rows recorded.

**Pricing modes:** flat · per-character · per-number · file-attachment price.
**Cart price display:** `NONE` | `MERGE` | `BADGE`.

> ⚠️ **This entire mechanism is a workaround for a Shopify limitation and does not port.** §5.1.

### 3.6 Design system & storefront styling
A per-shop **design system** that a CSS builder turns into scoped CSS; each option can
**override** shop defaults for itself only, and per-option styles are **frozen at save
time** (changing the design system later never re-styles an existing option).

Six style groups: `optionEffects` (hover) · `optionTextDesign` (colours + layout +
`selectColor` accent) · `optionStyles` (box geometry, swatch size/ratio) · `tooltipStyles` ·
`addToCartStyles` · `addonCardStyles` — the last three are theme-specific surfaces that
deliberately do **not** inherit the common option CSS. Plus `priceBadgeStyles`,
`cartPriceBadgeStyles`. **[ADDED]** There is also an `optionEffects.customCss` **global
raw-CSS escape hatch**, and a **multi-theme** model: merchants save named custom themes,
capped by a plan limit (`customThemeLimit`, free 1 / advance 5 / pro 10). Theme *count* is
gated but theme *selection* is not — only individual style **fields** are gated (a
deliberate owner decision).

**Two recorded decisions:** per-option CSS stays **`!important`-free** so merchant custom CSS
always wins. **Shadow-DOM isolation was evaluated and deferred** — it broke form submission.

### 3.7 Design Lab — the differentiator (8,449 LOC)
**Two labs, one shared render model.**

| Lab | Opens for | Payload | Stored on |
|---|---|---|---|
| **Image/Swatch lab** | color-swatch, image-swatch (per **choice**) | `DesignData { layers[], shapes? }` | `option_choices.designed_data` |
| **Text lab** | text, textarea (per **option**) | `TextDesign` | `options.designed_data` |

- **Coordinate model:** *fractions persist, pixels edit.* Every saved geometry is a fraction of the canvas. The editor works in canvas pixels with logical height fixed at `CANVAS_BASE_H = 460`; conversion happens **only** in `exportDesign()`/`importDesign()`.
- **Image lab:** a **state engine, not React state** (`store.ts` — layers, history, undo/redo over JSON snapshots). Frames/shapes (`rounded`/`circle`/`heart`/`star` vector clips, `square` free rect, `image` custom PNG mask), crop-inside-frame, opacity, fit modes (`free`/`cover`/`fit`/`fullw`/`fullh`), align, rotate, reorder, lock/hide/duplicate.
- **Text lab:** curved text (`curve: -100..100`, ±100 = full circle), 8 curated Google Fonts, letter-spacing, shrink-to-fit fixed-height box, live browser **glyph measurement** (`advanceRatio`) so full circles actually close.
- **`designScene.ts` — ONE geometry, four surfaces.** → `DesignScene` → SVG string, consumed by (1) the editor canvas, (2) `DesignSvg` admin previews, (3) the storefront overlay, (4) the order PNG (`sharp`, with a **glyph-outline** renderer so no webfont is needed server-side).

> **The two traps this model exists to avoid — both real regressions:** an absolute pixel
> constant anywhere breaks parity (the lab works in a 460-tall space, every other surface in
> the image's natural pixels — **only ratios survive the jump**); and the admin must resolve
> against the **product image's** aspect, because `wPct` is a fraction of WIDTH while
> `sizePct`/`hPct`/`letterSpacing` are fractions of HEIGHT — so every wrap point, shrink
> result and curve radius depends on the canvas **aspect**. **8 render-only pixel-parity
> fixes, all numerically verified.** The highest-value thing in the repo to port unchanged.

- **Storefront overlay targeting:** finds the real product image by **featured-image URL match**, then excludes non-product contexts **root-aware + structurally** (an ancestor containing `[data-optionia-root]` is our territory; a recommendation card is not) and drops images inside links to a *different* product — so the design never leaks onto a "you may also like" card.
- **[ADDED] Four known-open geometry defects**, found by audit, unfixed: `planMount` mixes screen space and pre-transform local space, so a CSS `scale(k)` on the anchor chain sizes the overlay by **k²**; the overlay is sized to the `<img>` **border** box while `object-fit` paints in the **content** box; the order PNG derives its baseline from `hhea` metrics while browsers use the platform's; and a residual ≤0.085 px from canvas rounding. Port these as **known issues**, not as clean code.

### 3.8 File attachments — Advance+
Uploads relay to the backend → **DigitalOcean Spaces** (CDN `cdn.optionia.com`). Per-option:
`allowedFileTypes` (6 categories + custom extensions), `fileMaxSizeMB` (capped at the plan
ceiling), `filePrefix` (cart property key), `additionalPrice`.

### 3.9 **[CORRECTED]** Large-file uploads — SOLVED, not open
My first pass listed the 504 as an open problem. It is **fixed** (ROADMAP §5, 2026-08-16),
and the fix is instructive:

Shopify's app-proxy relay has a hard **~30 s timeout**, so 90–100 MB files 504'd. The
solution is a **second, direct route** (`/direct-upload/customer-file`) that the storefront
calls on the app's **real domain**, bypassing the proxy entirely for the large byte transfer.
Bypassing the proxy loses Shopify's automatic HMAC, so it is replaced by a **short-lived
signed token** minted server-side into the *small, fast* app-proxy option-sets response and
carried by the storefront JS. Because it is now genuinely cross-origin, it does real CORS —
answering `OPTIONS` unauthenticated, then attaching CORS headers, with `Origin` checked
against the token-verified shop's own domains as **defense-in-depth** (the code is explicit
that the token is the actual authorization boundary and CORS only governs what a *browser*
will let a page read).

> **Directly relevant to WooCommerce:** the plugin will face the same problem in a harder
> form — shared hosts commonly cap PHP `upload_max_filesize` / `post_max_size` / execution
> time far below 100 MB. **Uploading direct from the browser to cloud storage, authorized by
> a short-lived signed token, is the right pattern and is already proven here.**

### 3.10 Translations / language — Pro
Per-shop, per-locale customer-facing text. English is mandatory, auto-seeded, non-deletable.
Translated: add-to-cart label, add-on total text, and **per-option-type validation message
bundles** (8 bundles).

**Per-customer-locale serving:** the storefront injects `data-locale` from Liquid
(`localization.language.iso_code`, with `window.Shopify.locale` as fallback) and sends
`&locale=`; the resolver does an **exact** `code` match, else English — deliberately **no
`fr-CA → fr` language-only step**. `resolveMessages` merges **per-slot: active → en →
bundled default**.

**The plan-gate asymmetry is deliberate and worth copying:** the **serve path fails CLOSED**
(a transient plan-lookup error serves English — never leak a Pro feature, never break the
page), while the **admin save fails OPEN** (never lose a Pro merchant's edits). Two different
answers to the same error, each correct for its side.

### 3.11 Preferences — 6 tabs
General (add-on widget visibility, PDP price display, active locale, quick-view) · Design ·
Language · Cart Pricing (display mode + selectors for third-party cart drawers) · Billing ·
Admin language (en/es/it/zh-CN).

### 3.12 **[CORRECTED]** Orders, GDPR — and a verified compliance gap
- **Draft-order record** — one per draft (id, invoiceUrl, currency, add-on total, cart/order snapshots), backfilled with the real `orderId` on `orders/create`.
- **Order / OrderLineItem** — relational rows from the webhook; each line's `customizationsJson` **freezes selections at order time**, correct even if the option set is later edited or deleted.
- **`moneyFormat` snapshot** per order, so historical orders keep their original currency formatting.

**My first pass said redact "nulls the PII snapshots, non-PII retained." That describes the
intent, not the behaviour.** `.claude/GDPR-REDACT-ROADMAP.md` is a **verified** audit
(2026-08-16, with file:line citations) concluding: **"real, material GDPR gap. Not currently
compliant for full erasure."**

| Webhook | Actually erases | Left behind |
|---|---|---|
| `shop/redact` | master sessions; token/scope nulled | **everything customer-facing** — the whole per-merchant DB and **all DO Spaces objects**. A customer-PII **no-op**. |
| `customers/redact` | `order_records` snapshots only | `orders` PII (name/email/shipping — the table even has an **unused `redacted_at` column**) · `order_line_items.customizations_json` (option values **and uploaded-file URLs**) · `media_files` rows **and the actual file bytes** |
| `customers/data_request` | nothing | only `console.log`s a marker for manual forwarding; no export produced |

The doc names the distinction precisely: **"webhook exists = the checkbox ✅. Data actually
erased = the legal duty ❌."** The automated App Store check verifies only that the webhook
responds. Two enabling gaps are also recorded: DO Spaces has **no prefix-delete helper**
(needs `ListObjectsV2` + batched `DeleteObjects`), and `media_files.uploader_ref` is
**written but never queried**.

> **Do not port this state.** WooCommerce/WordPress has its own privacy obligations and its
> own tooling (`wp_privacy_personal_data_exporters` / `_erasers`, which integrate with the
> WP admin's export/erase workflow). **Build erasure correctly the first time**, and make the
> "can I actually delete every byte for one customer?" question a Stage-B design input rather
> than a post-launch audit finding. The four PII locations here map almost directly onto
> Woo's equivalents (order meta, line-item meta, cloud file storage, snapshots).

### 3.13 Billing & plans
Tiers `free` / `advance` (monthly+yearly) / `pro` (monthly+yearly). Shopify Billing API,
**14-day trial, one-time** — `trialUsedAt` set-once stops re-redeeming on
reinstall/resubscribe (a real exploited loophole, "Bug A").

**The plan matrix is data, not code.** Every `PlanFeature` → a `featureKey` → a `rangeId` in
DB `PlanComparisonRow`; a plan resolves to a `maxRange` (free 2000 / advance 3000 / pro
4000); `canUseFeature(gates, f) = rangeId ≤ maxRange`. **"Never hardcode tiers."** ~45 named
features. **[ADDED]** Four numeric limits, each with a **maxRange-derived fallback** for
gates cached before that limit existed (Redis caches gates indefinitely) — always read via
the accessor, never the field: `optionSetCount` · `fileSizeLimitMB` · `customThemeLimit`
(1/5/10) · `orderViewLimit` (10/200/∞).

**Enforcement — 3 layers, "FREEZE + REJECT":**
1. **UI (`PlanGate`)** — the child is natively `disabled` + `inert` with an info-badge tooltip. The upgrade modal appears **only on tamper** (capture-phase handlers, if someone strips `disabled`) — deliberately Built-for-Shopify-safe: no modal is pushed at a normal merchant.
2. **Client runtime** — the inert control can't be interacted with.
3. **Server — the real boundary** (`enforce.server.ts`): **CREATE** → any locked type or gated field **rejects the whole save**, nothing stripped. **EDIT** → grandfathered content is **FROZEN** (gated fields restored from the stored value); only **new** gated content is rejected.

> **Why:** the previous model *stripped* gated content on save, which **silently flipped
> multi-select swatches to single** on a downgraded merchant's live store. Freeze+reject is
> the fix. Port the model, not the bug.

**Plan sync:** the `app_subscriptions/update` webhook reconciles in real time; **the old
daily reconcile cron was removed.**

### 3.14 **[CORRECTED]** Storefront rendering — TWO bundles, not one
1. The theme extension reads the product GID → fetches from `apps.optionia.api.option-sets` (app-proxy, HMAC).
2. The server returns **HTML + scoped CSS per matching set** from the framework-agnostic `app/storefront/` core.
3. The extension injects it; the runtime wires interaction.

**The same core powers the admin live preview, so preview == storefront by construction.**

**Bundle 1 — `optionia-core.js`** (product page): `constants` · `helpers` · `dom` · `index`
(hydrate + delegation) · `children` (child panels + **addon total calc**) · `pricing` (live
display) · `form-sync` · `validation` · `selector-engine` · `capture` · `designed-image` ·
`date-picker` + `calendar/` · `cart-intercept` · `cart-customization` · `checkout` · `buy-now`.

**Bundle 2 — `optionia-storefront.js`** (site-wide, 1,099 LOC): **cart pricing on the cart
page and drawer.** My first pass missed this. Its design note is one of the strongest ideas
in the codebase:

> **"THEME-AGNOSTIC BY DATA, NOT BY CLASS LISTS."** `/cart.js` is the single source of truth
> and every DOM target is identified **against the data**: rows by `item.key`; unit price by
> finding the money leaf equal to `item.final_price`; line total equal to `item.final_line_price`;
> compare-at (struck-through) **never touched**; image by matching `item.image`; subtotal and
> grand total by matching `cart.items_subtotal_price` / `cart.total_price`. A merchant
> selector, when genuinely set, overrides exactly — **nothing else decides by selector**. And:
> **"We only ever WRITE to the DOM — never scrape a price to compute with."**

Trigger chain: MutationObserver on section containers/drawer → fetch interceptor on
`/cart/{add,change,update,clear}` → quantity listeners → init retries + native cart events.
It also composes the customer's flattened design image onto the line (replace/left/right/
top/bottom) and does **selective flash-prevention** (hiding only add-on rows' prices until
patched).

> **This is a masterclass in surviving arbitrary themes, and WooCommerce needs it more, not
> less.** It is the single best-transferable piece of storefront engineering in the app.

**[ADDED] JS hosting — the extension is now a thin loader.** Storefront JS/CSS used to live
in the extension, so every change needed `shopify app deploy`. Phase A (complete, verified
live 2026-08-27) moved the real bundles to the app origin, served through the app proxy
(same-origin ⇒ **CSP-safe**), with a **two-tier cache strategy**: a tiny `manifest.json`
(`no-cache` + ETag) pointing at **content-hashed** bundles (`immutable`, 1-year). A new build
= a new hash = a new URL, so updates propagate on the customer's next page load with no
stale JS and no extension redeploy. **Phase B (CDN) is not done, and is required** — Phase A
alone can make *first* load slower than Shopify's CDN.

### 3.15 Admin pages & webhooks
14 admin routes: dashboard · option-set list · create/edit · orders list/detail ·
preferences (6 tabs) · pricing plans · welcome/onboarding · help-support · **privacy-policy**
· recommended-apps. **19 skeleton loaders** — one per page, a stated convention.

9 webhooks: `orders/create` · `app_subscriptions/update` · `app/uninstalled` ·
`app/scopes_update` · `shop/update` · `locales/create` · plus the mandatory GDPR trio.

### 3.16 **[ADDED]** Support impersonation mode — a subsystem I missed entirely
Undocumented in any `.claude` file; found only in the code. It lets a support admin **open a
merchant's dashboard from the internal admin panel** — and its security design is careful:

- The admin API mints a **one-time token**; `routes/support.ts` exchanges it for a signed session cookie.
- `authenticatedShop()` checks that cookie **first**, and if valid authenticates via `unauthenticated.admin(shop)` instead of the normal Shopify path — because inside our own admin's iframe there is **no genuine Shopify session token or App Bridge parent frame**.
- The cookie is httpOnly/secure/**SameSite=None** (required — read in a cross-site iframe) and carries **only non-secret identifiers**. **The Shopify access token never touches the cookie or the client**; it is fetched fresh from the master DB.
- **Session lifetime is governed by REVOCATION, not a time cutoff.** A short fixed TTL was throwing errors mid-support-session for admins still working. `/support-heartbeat` polls every few minutes and clears the cookie the moment the session is revoked; `maxAge` is only a generous outer bound.
- `SupportModeContext` + `useSafeAppBridge()` exist because **App Bridge is never loaded in support mode**, so any component calling it would crash.

> **Port this.** A WooCommerce SaaS needs the same capability (support opening a merchant's
> dashboard), the backend already has `impersonation-session.entity.ts` and
> `platform-staff.entity.ts` — and it will be **easier**, because there is no embedded-iframe
> constraint. The revocation-not-TTL lesson and the never-put-the-token-in-the-cookie rule
> both transfer directly.

### 3.17 **[ADDED]** Shopify Sidekick (AI) extension
`extensions/optionia-tools` — a `ui_extension` targeting `admin.app.tools.data` exposing
**three read-only tools** to Shopify's AI assistant (`search_option_sets`,
`get_plan_usage`, `get_shop_settings`), each with a full JSON input/output schema, plus an
`instructions.md` guide teaching Sidekick to answer "how do I…" questions and point merchants
to the right page. Backed by `app/api/sidekick/*` with its own CORS handling.

> **Shopify-only surface — drop from WooCommerce scope.** Worth noting only because the
> *pattern* (a documented, read-only, schema'd tool surface over your own data) is exactly
> what an MCP server would be if you ever want AI assistants to answer questions about a
> merchant's Optionia config. Not now.

### 3.18 **[ADDED]** Storefront debug / theme-compatibility tooling
`docs/storefront-debug-tools.md` (written in Bengali) documents a **support toolkit** that
runs in the customer's browser console: `localStorage.optionia_debug = "1"` enables verbose
logging (production default is silent except real errors and a one-time warning when a
merchant's selector fails to match), and `window.__optionia.selectorHealth()` reports the
**live status of every merchant-configured selector** — configured value, `ok`/`empty`
status, match count, which element was picked, timestamp.

> **The doc states the intent plainly: this is the seed of an admin-panel "Theme
> compatibility" health check.** On WooCommerce — where theme and plugin variance is far
> worse than Shopify's — a self-diagnosing compatibility report is arguably more valuable
> than any single feature. **Strong candidate to promote from debug tool to product feature.**

### 3.19 **[CORRECTED]** Observability — Sentry is wired
I wrote "no error tracking." Wrong: `@sentry/node` **and** `@sentry/react` are dependencies,
`app/utils/sentry.server.ts` initializes at process start with `tracesSampleRate: 0.1`, and
it no-ops cleanly when `SENTRY_DSN` is unset so local dev is unaffected.

What is genuinely absent is the rest: **no structured logging, no metrics, no health
endpoint** — which is what the ARCHITECTURE doc's "observability gap" actually refers to.

**[ADDED] Rate limiting** is real but explicitly interim: a **per-shop in-memory token
bucket** with per-action configs (`option-set:duplicate` strictest at 10 burst / 0.1 rps;
`option-set:delete` tighter than writes because destructive), pruned every minute. Its own
docblock names the limits: **state is lost on restart and is not shared across processes —
"move to Redis when scaling beyond a single Node process."** For a multi-instance NestJS
deployment, Redis-backed rate limiting is required from day one, not later.

### 3.20 Data-driven onboarding
A wizard whose *behaviour* is data, not code:

> **"The database stores WHICH capability and its parameters. It never stores HOW."**

A step's primary button is a **discriminated union**, not a string column: `ADVANCE` |
`FINISH` | `INTERNAL_LINK` | `EXTERNAL_LINK` | `APP_CAPABILITY` — a real DB enum, with only
*parameters* in JSON. Plus `OnboardingSkipMode` (NONE/STEP/FLOW) and
`OnboardingSatisfiedMode` (SHOW_DONE/AUTO_SKIP), and a **code-side registry** of capabilities
and completion signals so an admin can never invent a behaviour the app doesn't implement or
inject a URL into a server-side redirect.

**Two security lessons recorded, both from versions that looked obviously correct:**
`startsWith("/") && !startsWith("//")` does **not** mean internal — the URL parser treats `\`
as `/` for special schemes and **strips tab/CR/LF before parsing**, so `/\evil.com` and
`/<TAB>/evil.com` both passed and then resolved off-site.

**[ADDED] Two implementation corrections recorded honestly:** the design specified `zod`, but
zod is a dependency used **nowhere** in the backend, so the checks were hand-written to match
surrounding code; and the registry had to be **split across two repos** (the backend owns the
catalogue because *it* must reject unknown capabilities on write; the app owns what each name
*does*), with the failure mode deliberately made safe — a capability the backend offers but
the app hasn't implemented **degrades to a plain "Next"** rather than breaking.

### 3.21 Two-database architecture
| | **Master DB** | **Per-merchant DB** |
|---|---|---|
| Name | `optionia_master` | `optionia_spf_<shop>` — **one per shop** |
| ORM | **Prisma** (41 models) | **raw `mysql2`** — no Prisma |
| Accessed by | app + backend | **backend only**; the app goes via `merchantApi` (HMAC) |
| Holds | sessions, plans + matrix, admin content, defaults, admin users | option sets/options/choices, orders, preferences, cart settings, design system, translations |

**JSON-blob settings pattern:** `general_setting_json` and `cart_settings_json` are extensible
blobs — a new setting is a new JSON key, **no migration**. The API flattens to snake_case on
read and **merges** partial PATCHes on write, so every consumer sees a stable flat shape.

### 3.22 Security posture
Admin → `authenticate.admin()` + per-shop scoping. Storefront → `authenticate.public.appProxy`
(Shopify HMAC every request). App→backend → **HMAC-SHA256**, `X-Optionia-Signature` +
`X-Shop-Domain`, **GET/DELETE sign the empty string `""`, not `"{}"`**. Draft-order prices
recomputed server-side. Redis cache-aside with **`cacheDel` after every per-merchant write**;
Redis failures non-fatal.

**[ADDED] `docs/security.md` is a formal Protected Customer Data (Level 2) policy** — DLP,
staff access, password policy, environment separation, backups/encryption, and a **severity-
scaled incident-response process** with GDPR Article 33's 72-hour notification. Note two
things: it describes **log redaction at write time** (the draft-order route logs line items
with values replaced by `[redacted]` so customer text never reaches hosting logs) — a good
practice to carry over. But it also references an `OrderRecordAccessLog` table and a
`logOrderRecordAccess` function as active controls, and **grep finds neither anywhere in the
app or the Prisma schema.** Either they live in the un-inspected Express backend, or the
document describes a control that was never built. **Worth confirming before reusing this
document as a compliance artifact.**

### 3.23 Known open problems (inherited by any port)
Honestly recorded in the app's own docs:
1. **Observability** — Sentry yes; structured logging / metrics / health endpoint no.
2. **No queue / background jobs** — everything inline; webhooks rely on Shopify retries.
3. **Order-pipeline reliability** — draft→order depends on `orders/create`. **[CORRECTED — fourth pass]** The ARCHITECTURE doc flags "verify idempotency," implying it's absent. Reading the webhook: **idempotency IS handled** — `POST /api/v1/orders` is an **upsert keyed on `shopifyOrderId`**, and a second enrichment pass deliberately re-calls it (a duplicate delivery re-upserts rather than duplicating). Enrichment failure is caught and logged as *"order already saved."* The residual risk is the *cross-store transaction* (master + per-merchant DB + media promotion are separate calls), not duplicate orders.
4. **Per-merchant DB at scale** — great isolation, but an operational surface at thousands of merchants (provisioning, migrating across *all* DBs, pool ceilings).
5. **JSON-as-string columns** — `TEXT` where native `JSON` would allow indexed path queries.
6. **The draft-order checkout is not at parity** — §5.1.
7. **GDPR erasure is materially incomplete** — §3.12.
8. **Four Design-Lab geometry defects**, measured and unfixed — §3.7.
9. **Rate limiting is in-memory** and won't survive multi-instance — §3.19.
10. **[ADDED] A large "pre-production musts" backlog** — a pending production migration with a documented silent-failure mode (the backfill matches by `sort_order`, so a reordered set attaches the wrong behaviour), a CDN/Redis content re-seed where **the app reads Redis first and only the admin panel invalidates it**, so a seed script leaves stale strings served **indefinitely (no TTL)**, and an old-option design-snapshot backfill that must run across **every** per-merchant DB.

> **Item 10 is the clearest argument in the whole analysis for the shape of the WooCommerce
> build.** Each of those is a direct consequence of one-DB-per-merchant plus a
> multi-tier cache with manual invalidation. The Woo backend's single multi-tenant DB with
> `tenant_id` scoping (AC5) does not have this class of problem at all.

---

# PART II — SHOPIFY → WOOCOMMERCE

## 4. Where the two platforms differ structurally

Before the port table, the differences that actually drive design:

| Dimension | Shopify | WooCommerce | Consequence |
|---|---|---|---|
| **Line-item pricing** | cannot set an arbitrary price → Draft Order workaround | `woocommerce_before_calculate_totals` sets it directly | §5.1 — the biggest win |
| **Where code runs** | all in the cloud; the storefront is a thin client | **the plugin runs on the merchant's server** | new failure modes: PHP versions, memory limits, plugin conflicts, no control over the host |
| **Config delivery** | live app-proxy call per page load | **cached in `wp_options`, no live call** (AC3) | staleness becomes a real design problem Shopify never had |
| **Theme surface** | Liquid + a reviewed theme ecosystem | arbitrary PHP themes, page builders, caching plugins | §3.14's data-not-selectors approach matters far more |
| **Cart rendering** | one cart | **classic PHP templates AND React blocks** | AC7 — two first-class paths |
| **Order storage** | Shopify's | WP posts **or** HPOS tables | must support both |
| **Identity** | `gid://shopify/Product/123` | `int` post ID | ID model change throughout |
| **Uninstall** | webhook, cloud keeps data | plugin deactivated; **cloud may never be told** | lapse policy is critical (M24.3) |
| **Updates** | app updates silently | **merchant chooses to update the plugin** | version skew between plugin and cloud config is permanent, not transient |

That last row deserves emphasis: **on WooCommerce, old plugin versions live forever.** The
config document must be versioned with explicit forward/backward compatibility rules — an
old plugin receiving a newer config must degrade safely rather than fatal. Shopify never had
to solve this. `CONFIG-CONTRACT.md` exists; **confirm it covers version skew.**

## 5. What does NOT port

### 5.1 ★ The Draft Order pricing mechanism — delete it entirely
**The single most important finding.**

Shopify's cart API **cannot charge an arbitrary add-on on a line item**. The app's entire
checkout path is a workaround: the cart shows the *variant listed price*, the add-on rides as
a cart **property**, and at checkout the whole cart is diverted into a **Draft Order** with
per-line `priceOverride`, redirecting the customer to an invoice URL.

That workaround carries a documented, still-open list of failures — and **because the whole
cart routes through the draft, plain non-Optionia items lose their discounts too**:

| Gap | Effect |
|---|---|
| Cart discounts never applied | customer sees a discounted cart, **pays full** → silent **overcharge** |
| No discount-code box / no automatic discounts | codes unusable at the invoice |
| No `shippingLine` | free-shipping and shipping charges broken |
| Wrong currency on multi-currency | draft in shop currency, not presentment |
| Customer not attached; no attribution | no email/`purchasingEntity`, no `sourceName` |

Recorded severity: **HIGH (money + trust + App-Store risk)**. The true fix (Cart Transform
Function) is **Shopify Plus-only**.

**On WooCommerce none of this exists.** The customer stays in the merchant's own cart and
checkout with the merchant's own gateway, and **discounts, shipping, tax, currency and
customer all work because WooCommerce computes them — you never reimplement any of it.**

> This is `AC6` in `developePlan.md`, and it is not a compromise. **The WooCommerce version
> is architecturally cleaner than the Shopify one at its single most business-critical
> point.** ~2,500 LOC is **deleted, not ported**, and the entire checkout-parity backlog
> evaporates.
>
> **Do not port the draft-order concept, `priceOverride`, the `_addon_price` display
> property, or the checkout hijack.** Anyone porting file-by-file will carry this across by
> reflex — say so explicitly in the plugin's contributing docs.

### 5.2 Platform-layer replacements
| Shopify | WooCommerce | Note |
|---|---|---|
| `authenticate.admin()` | dashboard JWT/session auth | already built (backend `auth/`) |
| `authenticate.public.appProxy` | **no equivalent** | replaced by AC3: **no live call at all** |
| Shopify Billing + `app_subscriptions/update` | Stripe / Paddle / Lemon Squeezy + webhooks | **D1 unresolved** |
| Admin GraphQL (9 files) | WooCommerce REST API + product sync | pull-based, not live query |
| ResourcePicker | dashboard picker over the synced catalogue | requires catalogue sync first |
| Theme app extension + 3 liquid blocks | plugin + `woocommerce_before_add_to_cart_button` **and** Store API | **AC7 — both paths** |
| Polaris `<s-*>` + App Bridge | Next.js + Tailwind + shadcn/ui | **full admin UI rewrite** |
| Shopify GID | WP post ID (int) | ID model change |
| 9 webhooks incl. GDPR trio | Woo webhooks + WP hooks; WP privacy tools | Shopify's mandatory-webhook burden disappears |
| Sidekick `optionia-tools` | **no equivalent — drop** | §3.17 |
| Built-for-Shopify constraints | WP.org plugin guidelines | different rules, both real |
| Embedded-iframe auth gymnastics | **gone** | §5.4 |

### 5.3 WooCommerce-specific problems Shopify never had
**Already researched** in `docs/woocommerce-notes/` — genuinely good work that must not be lost:

1. **Block cart/checkout is the DEFAULT** — verified on WC 11.0.1 *under a classic theme*. Theme choice and cart implementation are **independent axes**.
2. **★ Item data must be SCALAR on the block path.** `CartItemSchema.php:172-179` does `continue 2` on any non-scalar — **silently dropping the entire element**. An array value renders fine in classic cart and **vanishes in block cart with no error**. → *Every value through `woocommerce_get_item_data` must be a pre-formatted scalar string.*
3. **★ Cart item keys already hash `cart_item_data`** (`WC_Cart::generate_cart_id()`). Good: different selections → different lines, identical → merge, for free. Bad: **arrays serialize via `http_build_query`, which is order-sensitive**, so the same selections in a different key order produce a spurious second line. → *Canonically sort; include nothing volatile (timestamp, nonce, random id) or merging breaks entirely.*
4. `woocommerce_add_to_cart_validation` has **two call sites with different signatures** (`:981` `$product_id`, `:1013` `$item` array) — **type-check, don't assume**.
5. The block `hidden` flag needs `__experimental_woocommerce_blocks_hidden` — wrap it in one helper.
6. `wp_kses_post` is applied to every item-data value on the block path — **plan for plain text**.
7. **HPOS** is on by default → the *disabled* case now needs deliberate test setup.
8. Product types simple / **variable** / grouped / external — the render hook fires in **different places per type**.
9. WordPress ecosystem: thousands of plugin/theme combinations, page builders, caching plugins, third-party cart drawers.

### 5.4 What gets *easier* — worth counting
The port isn't only cost. These disappear or shrink:

- **The entire embedded-iframe auth problem.** The ROADMAP spends two long sections on it: an "intermittent embedded-login" bug misdiagnosed as benign on 2026-08-09 and correctly root-caused on 2026-08-24 (a plain `href` breadcrumb causes a document navigation, dropping the query string and Bearer header), plus a second symptom (blank pages) with the same cause, fixed with a `Partitioned` cookie carrying `shop|host` — which comes with an **accepted caveat that CHIPS partitions by top-level site, so two stores open at once share the cookie**. A standalone dashboard has none of this.
- **Shopify's mandatory compliance-webhook + BFS review regime.** Real obligations, but replaced by different (generally lighter) WP.org rules.
- **`shopify app deploy` coupling** — the reason the JS-hosting plan exists at all (§3.14). A WP plugin ships its own assets.
- **Draft-order checkout parity** — §5.1.
- **Shopify CLI bugs** — a live one (`[events]: Required`, Shopify/cli#8386) forced a fake Events subscription plus an inert `/events` route purely to stop 404s from auto-disabling it. Pure platform tax.
- **Per-merchant DB provisioning and fan-out migrations** — if Woo stays single-DB multi-tenant (it does), §3.23 item 10 largely vanishes.

### 5.5 The genuinely hard port: Design Lab on WooCommerce
The authoring UI is React and moves to the dashboard fine. But **the render surfaces cross a
language boundary**:

| Surface | Shopify | WooCommerce |
|---|---|---|
| Editor canvas | React, in-app | React, in dashboard ✅ |
| Admin preview | `DesignSvg.tsx` | React, in dashboard ✅ |
| **Storefront overlay** | `optionia-designlab.js` | ✅ same JS, but must find the product image in an **arbitrary WP theme** |
| **Order image PNG** | Node `sharp` + glyph outlines | ⚠️ **must stay in the cloud** — the plugin cannot require `sharp`/GD/Imagick |

`developePlan.md` AC2 already anticipates exactly this for pricing — *"ports of cloud logic
with identical semantics, covered by a shared cross-language fixture suite."* **Design
geometry needs the same treatment, and the plan doesn't currently say so.**

**Recommendation: keep all rendering in JS/Node.** The overlay is JS on the storefront; the
order PNG is generated **cloud-side** and the plugin stores only a URL. Then `designScene.ts`
stays the single source of geometry and **PHP never computes design geometry at all.**

## 6. What ports — the reuse assessment

Assessed by checking imports, not guessing. **Verified: `app/storefront/`,
`app/components/design-lab/` and `app/types/` contain zero `@shopify` imports.** The
`@shopify/*` surface is only **28 of 297 files**.

| Asset | LOC | Ports? | Why |
|---|---|---|---|
| **`app/types/`** — `Option`, `OptionChoice`, `OptionSet`, `OptionStyles`, `ProductRule`, helpers | ~1,200 | **★ AS-IS** | Pure domain model, zero platform deps. **Highest-value artifact in the repo.** Becomes the shared contract for NestJS + dashboard + the plugin's JSON schema. |
| **`designScene.ts`** + `measureText`/`textMeasure`/`helpers` | ~1,500 | **★ AS-IS** | Framework-free geometry carrying 8 verified parity fixes. Hand-porting this is the most expensive mistake available. |
| **`design-lab/`** rest (editor, store, canvas, panels) | ~7,000 | **HIGH** — Polaris→shadcn reskin | Logic and state engine unchanged. |
| **`app/storefront/`** core | 4,438 | **★ HIGH** | Deliberately framework-agnostic pure functions. Two consumers today; three tomorrow. |
| **`app/assets/optionia/`** (bundle 1) | ~4,500 of 5,300 | **HIGH** | Rewire `cart-intercept`; **delete `checkout`/`buy-now`/`cart-customization`**. |
| **`app/assets/optionia-storefront/`** (bundle 2, cart pricing) | 1,099 | **★ HIGH** | §3.14 — the data-not-selectors approach is *more* valuable on Woo. |
| **`addon-pricing.server.ts`** | ~400 | **HIGH (semantics only)** | The trusted-recompute logic + the whole tamper model (§6b.3) is the spec for the PHP evaluator. **Port the semantics, NOT the float arithmetic** (§6b.4) and **add a `q` clamp** the original didn't need. |
| **`option-core/keys.ts`** | 60 | **★ AS-IS (structure)** | §6b.1 — the one-file-of-keys discipline. Values change for Woo; the discipline is the asset. Port before anything that touches a cart. |
| **`option-core/addon.ts`** | 93 | **★ HIGH** | §6b.2 — the shared client formula. Becomes the TS half of the cross-language fixture suite; add the server's choice cap to it. |
| **`plan-features.ts`** + matrix model | ~500 | **★ HIGH** | Platform-independent and better than anything designed fresh. |
| **`enforce.server.ts`** — freeze+reject | ~300 | **★ HIGH (semantics)** | A bug already paid for once. |
| **`settings/defaults.ts`** design-system defaults | 453 | **HIGH** | Data. |
| Support-mode session model | ~200 | **HIGH (semantics)** | §3.16; easier without the iframe. |
| Onboarding capability/signal registry | ~400 | **★ HIGH** | Discriminated-union insight + both URL lessons. |
| Direct-upload token pattern | ~250 | **★ HIGH** | §3.9 — Woo needs it more. |
| **`app/config/i18n/`** 4 locales + merge/fallback | ~4,000 | **MEDIUM** | Keys change with the UI; the deep-merge-over-`en` pattern ports. |
| **`prisma/schema.prisma`** | 1,060 | **MEDIUM (design input)** | Plans/matrix/content/onboarding → TypeORM. **32 already exist as entities.** |
| `app/routes/` admin pages | ~10,000 | **LOW — rewrite** | Screen *inventory* and flows port; code doesn't. |
| `merchantApi.server.ts` | 1,138 | **NONE** | HMAC client for an Express backend not in the target architecture. |
| `create-draft-order`, webhooks, `shopify.server.ts`, `extensions/`, embed-context/support-heartbeat plumbing | ~2,800 | **NONE — delete** | §5.1 / §5.2. |

**Rough totals:** of ~68,700 LOC, roughly **13,000–15,000 port at high fidelity**, ~10,000 is
admin UI rewritten against the same screen inventory, ~4,000 is deleted outright, and the
remainder is the platform layer WooCommerce replaces.

The 13–15k that ports is not the easy part — it is the **correctness-critical** part, the
part with the verified fixes in it. That is why "greenfield" is the expensive choice.

## 6b. **[ADDED — fourth pass]** The implementation contracts that decide whether the port works

Everything above was read from docs and file inventories. This section is read from the
**implementation**, and it is where a port actually succeeds or fails. Five contracts, each
with a defect or divergence found by inspection.

### 6b.1 ★ The cart-property key contract — port this file first
`app/storefront/option-core/keys.ts` is the **single source of truth** for every line-item
property key, shared by the storefront bundle (esbuild), the admin (Vite), and the server
routes — deliberately import-free so it is safe to bundle into customer-facing JS. Twelve
files consume it.

| Key | Purpose |
|---|---|
| `_Ordered with Optionia Product Options` | merchant-facing **marker** — how the webhook and Shopify admin identify our items |
| `_optionia_sel` | hidden machine-readable selection: **option ids + chosen values, NO prices** |
| `_optionia_designed_image` | flattened design PNG/WebP CDN URL |
| `_optionia_file_cdn_url_<option name>` | file-attachment URL, keyed by option **name** |

Three hard-won details:

- **Keys are deliberately colon-free** so they *survive cart → draft → order*. A legacy `_optionia_file_url:<name>` shape exists and is still read. **On WooCommerce the equivalent constraint is different but just as real** — meta keys with a leading `_` are hidden from the order screen, and `wp_kses_post` runs on block-cart display (§5.3.6). The *principle* — one file of keys, no key ever typed twice — ports; the specific rules do not.
- `addonKeyFor(label, visible)` strips leading whitespace **and** underscores *together* before trimming, because `"  _Extra "` must clean to `"Extra"` — stripping underscores before trimming leaves a `_` prefix that Shopify treats as hidden **even when the merchant marked the key visible**. This function replaced three duplicated copies.
- File keys use the option **name**, not id, to stay human-readable and to let the order side pair visible and hidden properties. Same-name clashes are de-duped with a numeric suffix client-side, with **filename matching as a server-side fallback**.

### 6b.2 ⚠️ The add-on formula exists TWICE — and the two copies disagree
This is the most important finding of this pass.

There is a shared, pure, well-documented formula in `app/storefront/option-core/addon.ts`
(`optionContribution`), explicitly created to kill a duplication. **It is imported by exactly
two consumers** — `app/assets/optionia/children.js` (storefront display) and
`app/storefront/addons.ts` (admin preview). Both client surfaces therefore agree.

**The server does not use it.** `addon-pricing.server.ts` — the *charging authority* — carries
its **own** `optionContribution`, whose docblock claims it "mirrors children.js exactly." It
does not:

| Case | Shared client core | Server (charging authority) |
|---|---|---|
| `file-attachment` | `present && additionalPrice > 0 → additionalPrice` | `q > 0 → additionalPrice` |
| choice cap | uncapped — sums every selected choice passed in | **capped** at `maxSelectableChoices()` |

The file-attachment branch differs only when `additionalPrice <= 0`, where both yield 0 — so
it is **currently latent, not a live mispricing**. But the two copies have already drifted
once while a comment asserted they hadn't, which is precisely how a real mispricing ships.

**The choice cap is the opposite case and is a genuine security control the shared core
lacks:** the server caps counted choices at what the widget can legitimately hold (`radio`
and `dropdown` → 1; `checkbox` → ∞; swatches → 1 unless multi), so *"a forged multi-value list
can't inflate a single-select."* The client core has no cap because it reads the real DOM.

> **Consequence for WooCommerce — this is exactly AC2's cross-language fixture suite, and it
> must be built as a real gate, not a checkbox.** The Shopify app proves that two copies of a
> formula in the *same language*, with a comment claiming parity, still drift. Across
> TypeScript and PHP, drift is the default outcome. **The fixture suite must assert the client
> display total and the PHP charged total are identical for every fixture — including the
> adversarial ones (forged multi-select on a radio, negative price, absurd `q`).**

### 6b.3 The tamper model — read this before designing the plugin's payload
`addon-pricing.server.ts` is the clearest security thinking in the codebase, and its shape
should be copied wholesale:

- The storefront stamps a **selection**, never a price. *"A tampered selection can only change WHAT is selected, never the price of it."*
- Selection entries are `{ q?, v?, t? }` — `q` = measure (text length / numeric value / 1 for present), `v` = chosen choice values, `t` = typed text **carried for server-side re-render only and explicitly "NEVER priced."**
- **Defensive caps** drop oversized entries: 200 options, 200 choice values, 600-char values, 20 KB raw. The reasoning is stated — oversized entries *"could only ever inflate, never deflate, a total."*
- Deliberately **no upper clamp on `q`**, to stay in parity with the client formula (which charges `rate × n` with no ceiling). An absurd forged value produces an out-of-range price **Shopify rejects → the draft fails closed, never under-charges.** ⚠️ **This reasoning does NOT survive the port.** WooCommerce will not reject an absurd line price the way Shopify's draft-order API does, so the plugin **must clamp `q`** — or a forged `q` becomes a real, accepted, absurd charge. *A rule that was safe only because of a platform behaviour that no longer exists.*
- Unknown option ids, unknown choice values, and **`isHidden` options** all contribute nothing — *"a forged selection can select only what the merchant actually configured."*
- Rounding happens **once**, at the end: `Math.max(0, Math.round(total * 100))`.
- A missing or malformed selection charges **no add-on** rather than trusting a claim.
- There is even a fallback for a stripped marker: since the forgeable marker can be removed from the request body, the server can still recognise an Optionia item by **matching visible property keys against known option names** (`optionNamesFromIndex`).

### 6b.4 ⚠️ Float money vs the plugin's integer-minor-units mandate — a direct conflict
The Shopify app computes add-ons in **floating-point currency units** (dollars) and rounds to
cents once at the end. `formatMoney` renders via Shopify's `{{amount}}` token templates
(5 variants, processed longest-first to avoid partial matches).

**The WooCommerce plugin has already decided the opposite, and correctly.**
`optioniaWooCommercePlugin/src/Support/Money.php` mandates integer minor units:

> *"this is the ONLY representation of money in the plugin. Floats cannot represent 0.1
> exactly, so accumulating them produces cent-level drift that shows up as a customer being
> charged the wrong total."* — enforced by **a CI check asserting no float cast appears in
> `src/Engine/`**, and correctly handling 0-decimal (JPY) and 3-decimal (KWD) currencies.

> **The plugin's position is right and the Shopify app's is a latent bug** (a single
> end-rounding hides it today; per-line accumulation across a multi-item cart would not).
> **Do not port the float formula.** Port the *semantics* — the branch-per-type logic — and
> re-express it in minor units. This is a concrete instance of §6b.2's fixture suite doing
> real work: the fixtures must be authored in minor units, and the TS side should move to
> minor units too so both sides are comparable at all.

### 6b.5 ⚠️ Option-field validation has no server boundary
Verified by reading the action, not the docs. `_app.option-sets.new.tsx`'s **server action**
enforces: HTTP method · title present · rate limit · plan **count** limit
(`PLAN_LIMIT_REACHED`) · plan **gating** (`collectCreateViolations` → `PLAN_GATED_CONTENT`) ·
the empty-custom-file-type check (`hasEmptyCustomFileType`).

It does **not** call `findFirstInvalidOption`. That runs only in the **client component**
(confirmed by the surrounding `shopify.toast.show` / `setOptionsError` / `jumpToPath` calls) —
so min/max coherence, required labels, and **duplicate choice values** are client-enforced
only.

That last one matters, because the app's own docs say a duplicate choice value *"breaks
storefront swatch/select and form submit."* A crafted POST can therefore persist an option set
that renders broken on the storefront. **Not a privilege or pricing escalation** — a merchant
can only corrupt their own data — which is presumably why it was acceptable. But the codebase
states elsewhere that *"server-side is the real boundary,"* and here it isn't.

> **For WooCommerce: the plugin cannot afford this.** It consumes a config document from the
> cloud and renders it on a live storefront, so a malformed set is a broken merchant
> storefront with no admin to fix it in. Validation must be enforced **in the authoring API
> (Stage B/C)**, and the plugin must additionally **fail safe on a config it cannot validate**
> — skip the offending option, render the rest, log. The backend's `ResponseValidator` and
> `option-sets/serialization/` are the right homes; confirm they cover option-field coherence,
> not just envelope shape.

### 6b.6 What the Woo plugin already got right — don't rebuild it
Two Phase-3 primitives are better than their Shopify counterparts and should be treated as
settled:

- **`Api/CircuitBreaker.php`** — opens after N consecutive failures with a cooling-off period, because *"an API outage means every merchant store retries on every cron tick… At scale that turns a partial outage into a self-inflicted denial of service against our own API."* **The Shopify app has no equivalent** — it doesn't need one (Shopify hosts the app), and this is a genuinely new WooCommerce-only risk that has already been correctly anticipated. It also explicitly preserves AC3: cached config keeps serving while the circuit is open.
- **`Support/Money.php`** — §6b.4.

Both point the same way: **the plugin's foundation is sound and the porting effort should
respect it.** Where the Shopify app and the plugin disagree, check which one is reasoning from
its own platform's constraints before assuming the mature codebase wins.

## 6c. **[ADDED — fifth pass]** Reading the 6,900 port-critical lines

§6b read the pricing path. This pass read the files I had *described but never opened* —
`designScene.ts` (881), `runtime.ts` (1,173), `build-html.ts` (1,100), `build-styles.ts`
(324), `enforce.server.ts` (380), `option-sets.server.ts` (626), the app-proxy render route
(364), `file-attachment.ts` (711), and `cart-intercept.js` / `validation.js` /
`form-sync.js` (1,105). Six findings, one of them a **live bug**.

### 6c.1 ✅ The platform-agnostic claim HOLDS — verified, with one caveat
I asserted `app/storefront/`, `design-lab/` and `app/types/` are Shopify-free. Verified by
reading every import in the four biggest files: `designScene.ts` imports only `./types` and
`./helpers`; `build-html.ts`, `build-styles.ts` and `runtime.ts` import only `@/types`, each
other, and the Design Lab. **No `@shopify`, no React, no server SDK, no DOM globals in the
builders.** The reuse assessment in §6 stands.

**The caveat:** `formatMoney` is a dependency of *both* `build-html.ts` and `runtime.ts`, and
it is Shopify-shaped — it renders Shopify's five `{{amount…}}` token templates (processed
longest-first to avoid partial matches) from a **float**. So the "framework-agnostic core"
has one platform-specific leaf, and it is the money leaf (§6b.4). **Porting these files means
swapping `formatMoney` for a WooCommerce/`Money`-based formatter at that single seam** — a
small, well-isolated change, but it must be done deliberately rather than discovered.

Also worth noting: `build-html.ts` imports `anchorPlusISO` from `app/assets/optionia/date-picker`,
so the "server" builder depends on a file living in the *client bundle* directory. Harmless,
but it means `app/storefront/` is not self-contained — plan the extraction boundary around it.

### 6c.2 ⚠️ LIVE BUG — text add-on pricing counts whitespace, the character limit doesn't
Two different definitions of "how many characters did the customer type," both live:

| Purpose | Function | Counts |
|---|---|---|
| **Price** (`q` → charged) | `form-sync.js` `textSelection` → `raw.trim().length` | **includes inner whitespace** |
| **Price** (display) | `children.js` → `input.value.trim().length` | includes inner whitespace |
| **Char counter + min/max limits** | `validation.js` `countChars` → `(v.match(/\S/g) \|\| []).length` | **excludes ALL whitespace** |

`validation.js` states the intent explicitly: *"spaces / tabs / newlines are NOT counted (a
gap between words is not a character)."*

**So for `"AB CD"` with per-character pricing, the customer is charged for 5 characters while
the counter shows 4.** Display and server agree with each other (both trim-length), so this is
**not** a tamper or over/under-charge-vs-preview issue — it is a **merchant/customer-facing
inconsistency**: engraving priced per character charges for spaces that the app's own counter
says don't count. For a 20-character engraving with 3 spaces at $2/char, that is $6 the
customer didn't expect.

> **This is exactly the class of bug the cross-language fixture suite must catch, and it
> proves the suite needs to cover more than the formula.** Add a fixture asserting that the
> character measure used for **pricing** and the one used for **limits** are the same
> function. Decide which definition is correct (I'd say `countChars` — the merchant said
> "per character", and the counter is what the customer sees) and use it in **one** place.

### 6c.3 ⚠️ The Design Lab's `1.25` line-height is duplicated across 5 surfaces as a bare literal
`fitTextToBox` declares `const LINE_H = 1.25; // must match serializeTextNode / the editor
line height`. The literal `1.25` then appears independently in:

| File | Use |
|---|---|
| `designScene.ts:538` | `LINE_H` in `fitTextToBox` (the named one) |
| `designScene.ts:778` | `serializeTextNode` — `flat.fontSize * 1.25` |
| `DesignSvg.tsx:157` | admin preview |
| `text-to-path.server.ts:115` | **order PNG** |
| `TextDesignLabModal.tsx:178, 1078` | editor measure + editor CSS `lineHeight` |

**Six occurrences, one comment, no shared constant.** This is structurally identical to the
add-on formula problem (§6b.2) — and this is the file I called *"the highest-value thing in
the repo to port unchanged."* It is still worth porting; it is **not** free of the defect
class its own docs warn about.

> **Fix on the way in, don't port as-is:** export `LINE_H` from `designScene.ts` and have all
> five surfaces import it. One line of work now; a wrong-by-one-line-height order PNG is
> otherwise a silent, per-customer artwork defect. **Add it to the §6b.6 "collapse to one
> definition" item.**

*Credit where due:* the surrounding discipline is genuinely excellent — `fitTextToBox`'s
shrink floor is `minFontRatio = 1/25` (a **fraction** of the font size, explicitly commented
as *"scale-free"*), and `radiusForBox` solves the curve radius *"from the CURVE and the BOX
alone — never from the text."* The ratio-not-pixels contract from `DESIGN_LAB.md` is really
enforced in the code, not just asserted in a doc.

### 6c.4 ★ Freeze+reject is better than I described — and it depends on stable IDs
`reconcileOptionsForPlanUpdate` indexes the previous tree by id at **both** levels (options
*and* choices) so a pre-existing item is matched and frozen while a brand-new id is treated
as CREATE. `freezeGatedFields` restores ~18 gated fields individually per feature flag;
`freezeGatedChoiceFields` does the same per choice. Two details my summary missed:

- **"Fix A"** — freeze deliberately does **not** cover the option's `type`. A pre-existing option whose type was *changed* to a locked type is treated as new gated content and **rejected**, because *"the editor has no 'change type' control"* — so it can only be tamper. A grandfathered locked-type option (type unchanged) is left alone. That is a genuinely subtle distinction: freeze-everything would have let a tamperer convert a free option into a Pro one.
- **`multiLevelOption` is diffed, not flag-checked:** newly-*added* nesting on a locked plan is a violation; nesting that already existed is kept **and recursed into**.

> **The dependency my plan understated: freeze correctness rests entirely on IDs being stable
> across an edit round-trip.** If the WooCommerce authoring API ever regenerates option/choice
> ids on save (a normal thing for a "replace the tree" endpoint to do), **every** edit by a
> downgraded merchant becomes a CREATE, and their grandfathered content is rejected instead of
> frozen — the exact data-destruction failure freeze+reject exists to prevent. **A2 must
> confirm the Woo `option-sets` endpoints preserve ids on update**, and B6's fixtures should
> include a downgrade-then-edit round-trip.

**Schema smell to fix on the way in:** for `number` options, `minValue`/`maxValue` are stored
in the **`minLength`/`maxLength`** columns (visible in `freezeGatedFields`, where the
`isNumber` branch freezes `o.minLength = prev.minLength` under the `minValue` flag). Field
reuse across types — cheap in a JSON blob, confusing forever. The Woo schema should use
distinct columns.

### 6c.5 ★ `cart-intercept.js` — the most important file to understand before Stage B
I listed this as "rewire to WooCommerce." Having read it, the *strategy* is the asset and it
transfers almost perfectly:

> *"Modern themes add to the cart every which way — a native `<form>` POST, a button-click
> AJAX call, `fetch('/cart/add.js')`, the Section Rendering API, quick-add on collection
> pages. A hidden `<input>` inside a `<form>` only works when the theme actually submits that
> form's FormData; many themes build their own request body (id + quantity only) and drop our
> inputs. **The ONE thing every add has in common is the network request to `/cart/add`. So we
> intercept THAT** — wrap fetch + XHR and merge properties into the request body whatever its
> format (FormData, JSON, or url-encoded)."*

It is explicitly **soft**: the item still goes in via the theme's own request; only the
properties ride along. *"We never touch a request that isn't ours."*

Two mechanisms worth porting verbatim:
- **Duplicate-add dedupe** — themes that fire two `/cart/add` calls for one user action (a form submit *and* a sticky-bar click) would create two lines. An identical add within **1500 ms** shares the *first* request's promise, so the theme still gets a valid cart response but no second line item. Keyed on variant + `_optionia_sel`, deliberately excluding the design/file URLs because those resolve at different times between near-simultaneous adds.
- **Cart-mutation tracking** — `/cart/{change,update,clear}` are also intercepted, so removing a customized line re-checks the checkout gate *"on any theme without a page-wide DOM observer."*

> **For WooCommerce this maps to `wc-ajax=add_to_cart`, the Store API `POST /wc/store/v1/cart/add-item`,
> and classic form POSTs — three paths instead of one, plus block-cart mutations.** The
> insight (intercept the network layer, not the form) is *more* necessary on Woo, where theme
> and page-builder variance is worse. **The 1500 ms dedupe is a real gift** — Woo has the same
> double-fire problem *and* `generate_cart_id()`'s order-sensitivity on top (§6c.6).

### 6c.6 ⚠️ `_optionia_sel` is NOT canonically sorted — and Woo needs it to be
`form-sync.js` emits `JSON.stringify({ ver: 1, o: collectSelection(root) })` — object keys in
**DOM traversal order**, with no sort.

On Shopify that is harmless: the property is an opaque string the server parses back into a
Map. **On WooCommerce it feeds `cart_item_data`, which `WC_Cart::generate_cart_id()`
serializes with the order-sensitive `http_build_query`** — the exact spurious-duplicate-line
bug already documented as Finding 3 in your own `integration-points.md`.

My plan said "canonically sort" as an instruction. **I had not verified the source doesn't —
it doesn't.** So this is a real porting task, not a carried-over property. Note also that DOM
order is *usually* stable for a given rendered page, which is precisely what makes this the
kind of bug that passes every manual test and then fires when an option set is reordered or a
child panel reveals options in a different sequence.

**Also newly noted: the payload carries `ver: 1`.** The parser reads `.o` and ignores unknown
fields — *"so this stays backward compatible."* That is a real versioning hook and it is
directly relevant to **A6** (config/plugin version skew): the Woo selection payload should
carry the same, and the plugin must tolerate a `ver` it doesn't recognise.

### 6c.7 ⚠️ The render route is 6 parallel fetches with `no-store` — the AC3 collision
`apps.optionia.api.option-sets.tsx` does `Promise.all` over **six** loads per request
(option sets · design system · translations · plan gates · preferences · cart settings),
then builds HTML + CSS + live-preview SVG, and returns `Cache-Control: no-store`.

On Shopify that is correct: the response is per-product *and* per-locale *and* per-plan, and
Shopify's infrastructure absorbs the app-proxy round trip.

**On WooCommerce this is precisely what AC3 forbids** — *"a customer page load must never make
a synchronous call to the backend."* The plan already says config is cached in `wp_options`,
but the *shape* of that cache is now a concrete design problem this route defines:

| Varies by | Consequence for the plugin's cache key |
|---|---|
| product | the config document must cover all assigned products, or cache per product |
| locale | per-locale variants, or resolve messages client-side |
| **merchant plan** | a plan change must invalidate the cached config |
| design system / preferences / cart settings | any merchant setting change must invalidate |

> **This is a Stage-B1 specification, not a detail.** The Shopify route proves the render input
> is a 6-way join over merchant state; the plugin has to receive that pre-joined, versioned,
> and invalidated on any of six triggers — while **never** blocking a page load. Confirm
> `CONFIG-CONTRACT.md` addresses plan-change invalidation specifically; it is the one trigger
> that comes from *billing*, not from an authoring action, and is therefore easy to miss.

## 6d. **[ADDED — sixth pass]** The four important features read as *behaviour*, not description

§6c read the files I'd never opened. This pass targets the gap I named myself: features whose
**behaviour** I described without reading — the renderer's per-type contract, the file-upload
subsystem (fast-follow #1), the date-picker (which I argued belongs in MVP), and
conditional reveal (central to **D-C**). Four findings, **two of them security-relevant**, and
one is the most serious defect found in six passes.

### 6d.1 🔴 Conditional reveal has NO server-side enforcement — a real price-tamper vector
**The most serious defect in the Shopify app.** Traced end to end.

> ⚠️ **[CORRECTED — seventh pass]** I originally called this "the most serious finding in this
> analysis" and proposed the fix as new work. **`developePlan.md` M17.4 already specifies it
> exactly** — *"Hidden options must be rejected, not merely invisible… a submitted value for it
> is a validation error,"* plus the conditionally-required half. So this is a real **Shopify
> defect** and a real **delivery risk** (M17.4 sits in Phase 17, is easy to skip under
> pressure, and nothing else in the plan fails without it) — but it is **not a gap in the
> WooCommerce plan.** See §7b.1. The analysis below stands; the recommendation is *"do not let
> M17.4 slip,"* not *"add a milestone."*

- **Client:** child panels are revealed with `panel.style.display = "block"` and hidden with `"none"`. They **stay in the DOM**. `isInsideHiddenPanel(el)` walks up looking for a `.optionia-child-options` ancestor with `style.display === "none"`, and is consulted in **six** client files — `form-sync.js` (3 call sites), `validation.js`, `buy-now.js`, `designed-image.js` — to exclude un-revealed options from the selection payload, from validation, and from the design image.
- **Server:** `buildOptionIndex()` walks `option.choices[].childOptions` **and** `option.childOptions`, flattening **every** child into one flat `Map<id, Option>`. `recomputeAddonPerUnitCents` then skips only `!option` (unknown id) and `option.isHidden`.

`isHidden` is the **merchant's** "hide this option from the storefront" flag. It is **not**
conditional-reveal state. **The server never checks whether a child option's `parentChoiceId`
corresponds to a choice the customer actually selected.**

**The exploit:** a customer submits `_optionia_sel` naming a child option nested under a
choice they did not select. The server finds it in the flat index, sees `isHidden` false, and
**prices it**. The tamper model's own guarantee — *"a forged selection can select only what
the merchant actually configured"* — holds literally, but the customer can select things the
merchant configured to be **unreachable**.

**Which direction does it move money?** Both, and that is why it matters:
- A child option with a **positive** add-on is an *over*charge the customer inflicted on themselves — harmless in practice.
- But the real case is a **required** child option, or one whose parent choice carries the price: the client excludes hidden-panel options from the *payload*, so a hand-crafted payload can **omit** the revealed child while **keeping** the cheap parent — and since the server prices only what the payload names, the customer pays for a configuration the merchant never offered. **Required-ness is enforced only in `validation.js`, client-side** (§6b.5 already established option-field validation has no server boundary; this is the customer-input analogue).

> **This is the single most important thing to fix in the WooCommerce port, and it is
> cheap to fix there.** The plugin already receives the full config tree, so `parentChoiceId`
> is available: **reject any selection entry whose option has a `parentChoiceId` not present in
> the same submission's selected choice values** — and evaluate it *transitively*, since a
> child can nest further. Do the same for required-ness: recompute which options are required
> **given the resolved visibility**, in PHP, and reject the add-to-cart if any is missing.
>
> This is exactly what `developePlan.md` AC2 already specifies as *engine logic piece #1 — the
> **rule evaluator**: "which options are visible/required given current selections."* **The
> Shopify app never implemented it server-side; the WooCommerce plan already calls for it.**
> Two consequences: (a) B6's fixture suite must include *"child priced without its parent
> selected"* and *"required-but-revealed option omitted"*; (b) it strengthens **D-C** — a rule
> engine forces visibility to be an explicit, evaluable predicate, whereas the tree model let
> it live implicitly in `style.display`, which is exactly how it ended up unenforceable.

### 6d.2 ⚠️ `html` and `paragraph` render raw — sanitization is client-only
Verified in `optionInputHTML`:

```
case "html":       return `<div …>${option.textContent || ""}</div>`;          // raw
case "paragraph":  return `<div …>${option.textContent ? option.textContent : escapeHtml(fallback)}</div>`;
```

The `paragraph` comment states the intent: *"textContent holds sanitized HTML from the
RichTextEditor, so render it raw."* And the sanitizer is real and thoughtful —
`sanitizeHTML()` in `HTMLEditor.tsx` with an allowlist, `<script>/<style>/<meta>/<link>/<base>`
stripped on paste, `styleWithCSS` handling.

**But every one of its call sites is in `app/components/`** — `HTMLEditor.tsx` (2),
`OptionEditorModal.tsx` (1), `OptioniaHTMLEditor.tsx` (2), `RichTextEditor.tsx` (paste
cleaner). **All client.** Grep finds **no** server-side sanitization of `textContent` on the
save path, and none in the render path either.

So a crafted save (the API accepts the options tree as JSON) can store `<script>` in a
`paragraph` or `html` option, and the storefront renderer emits it **unescaped into every
customer's product page**. *(A render-route comment does say "XSS-safe", but reading it in
context that refers to injecting **CSS** via `textContent` — unrelated to these two types.)*

**Severity in context:** the attacker must be able to save an option set, i.e. an
authenticated merchant on their own store — so this is **self-XSS for a legitimate merchant**,
and the `html` type is deliberately a Pro "raw HTML" feature where markup is the *point*. That
is presumably why it was acceptable. The genuine risks are (a) a compromised or careless
merchant account XSS-ing their own customers, and (b) **any future path where a
non-merchant can influence `textContent`**.

> **For WooCommerce, WordPress hands you the answer for free and you must use it:**
> `wp_kses_post()` on render (already applied automatically on the block-cart path, §5.3.6 —
> so the two paths would otherwise *differ*), plus server-side sanitization in the authoring
> API. Sanitize **on save AND on render**, on the server, in both languages. Note the plugin
> also has no equivalent of "trusted merchant markup" — a WP plugin emitting unescaped stored
> HTML is a WP.org review finding, not a design choice.

### 6d.3 ★ The upload subsystem is better than I described — and names a constraint that ports
Reading `upload-guard.server.ts` corrected two things and surfaced a third path.

**There are THREE upload paths, not two** (§3.9 documented two):
1. the multipart **app-proxy** relay,
2. the **direct** cross-origin route (the 504 fix), and
3. a **presigned direct browser→DigitalOcean-Spaces PUT** — the app registers the file, gets back `presignedUrl` + the permanent CDN URL, and the browser PUTs straight to Spaces.

The guard's reason for existing is stated in one line and is the transferable lesson:

> *"Kept in ONE place so the two paths can never drift — a difference in the denylist or size
> cap between them would let an attacker pick the weaker path."*

And the threat model is named precisely:

> *"the storefront `accept` attribute + client-side validation are **BYPASSABLE** — any visitor
> can POST/presign an arbitrary file (**the app-proxy HMAC signs only query params, not the
> body/metadata**). So enforce a server-side floor on every upload path."*

Design choices worth copying:
- **A denylist, not an allowlist** — and the reasoning is correct: merchants configure their own allowed types *including arbitrary custom extensions*, so an allowlist would reject legitimate merchant-permitted files. It blocks ~50 extensions across executables, shell/scripting, **browser-executable markup** (`html`, `htm`, `xhtml`, `shtml`, `xml`, `xht`, `svgz`), and server-side scripts (`php`, `phtml`, `asp`, `jsp`…).
- **The presigned cap is enforced by Spaces itself** — the URL is signed with `ContentLength` = the claimed size, *"so a client can't PUT more bytes than it declared."* Genuinely elegant: the size limit is enforced by the storage provider, not by trusting the uploader.
- ⚠️ **`svg` is deliberately NOT blocked** while `svgz` is — because SVG is a first-class supported image type. The comment offloads the risk: *"serving user uploads with a download disposition is the backend/CDN's job."* **That is a real, live dependency on CDN configuration, and SVG is a stored-XSS vector when served inline.** Verify the disposition header is actually set; if it isn't, this is an open hole.

> **For WooCommerce, every line of this transfers, and the stakes are higher.** The `php`/
> `phtml` entries are not theoretical on WordPress — an uploaded PHP file inside a
> web-accessible `wp-content/uploads` is remote code execution on the merchant's server. **This
> is the strongest technical argument for the "uploads never touch the merchant's disk"
> differentiator (D5 #4):** cloud storage removes the RCE class entirely. Port the
> **one-guard-for-all-paths** discipline, the denylist reasoning, the presigned-`ContentLength`
> trick, and resolve the SVG disposition question explicitly.

### 6d.4 The renderer's per-type contract — where the PHP port will actually cost time
`optionInputHTML` is a 15-branch switch, and the static types carry far more logic than
"render a heading":

- **`heading`** — the level sets only the semantic tag; **`font-size` is always emitted inline** so *"the browser's default h1–h6 size never leaks through"*, and **`margin-block` is constant regardless of level** so changing the level can't change spacing. Colour is **re-validated against a hex regex at render time**, and font-size is parsed and clamped to 1–200 *"to prevent any CSS injection"* — i.e. the renderer treats its own stored styles as untrusted. Good instinct; port it.
- **`divider`** — 10 styles, three of which are **synthesized** because CSS can't express them: `wave` is an inline SVG sine wave, `encodeURIComponent`-ed into a `repeat-x` data URI; `triple` is a `repeating-linear-gradient` (CSS has no 3-line border-style); and `double`/`groove`/`ridge`/`inset`/`outset` are **force-clamped to ≥3px** because they are invisible below that. Plus `height:0` to confine the visual to the border, and alignment via auto margins.

> **Two consequences for the port.** (1) The "static/presentational" types are **not** cheap —
> `divider` alone is a small rendering engine, and it is the kind of thing an estimate treats
> as trivial. The Woo backend already has `presentational-item.entity.ts`, so the data side
> exists; the *rendering* side is the work. (2) **Re-validating stored style values at render
> time is a pattern the plugin needs even more**: the plugin renders a config document fetched
> from the cloud, so treating every value as untrusted at the point of emission is the
> difference between a bad config being ugly and a bad config being a CSS-injection on a
> merchant's storefront. Combine with §6b.5's "fail safe on a config it cannot validate."

**Also confirmed (no defect):** the date-picker's `resolveBound()` implements exactly the
anchor semantics §3.3 describes — `fixed-days` is 1-based and inclusive, resolved against the
frozen `anchorISO`, and falls back to counting from today when the anchor is absent *"so
nothing on a live storefront shifts under it."* It is ~90 lines total, which reinforces **D-D**:
moving date-picker into MVP is genuinely cheap, and it unlocks a named segment.

## 7. Feature-parity matrix — Shopify vs the WooCommerce MVP line

Cross-referencing `developePlan.md` S4 against the actual Shopify feature set surfaces gaps
the current plan does not name:

| Shopify feature | In Woo MVP (S4)? | Note |
|---|---|---|
| text, textarea, number, radio, checkbox, select, color, image-swatch | ✅ Tier-1 (8) | parity |
| **date-picker** (+4 modes, `dateFormat`, anchors) | ❌ deferred Tier-2 | **Shopify gates it at Advance — a *paid* feature.** Food/cakes/florists is a named segment that **cannot buy without it.** |
| **file-attachment** | ❌ deferred (fast-follow #1) | correctly identified as largest subsystem |
| heading / paragraph / divider | ⚠️ unnamed | backend already has `presentational-item.entity.ts` — covered, just unnamed |
| `html` block (Pro) | ❌ | low priority |
| **multi-level / child options** | ⚠️ modelled as single-condition rules | Shopify = **tree nesting**, Woo = **rule engine**. Overlapping outcomes, different shapes → **§10 D-C** |
| fixed + percentage pricing | ✅ | Woo adds percentage, which Shopify lacks |
| price-per-character / per-number | ❌ deferred | Shopify gates at Advance; **jewelry/engraving is a named segment** |
| product assignment (all/selected/automated) | ✅ | parity |
| **Design Lab (both labs)** | ❌ **absent from the entire plan** | ⚠️ 8,449 LOC, strongest differentiator, **no phase** → **§10 D-B** |
| Live preview | ❌ deferred (Phase 21) | on Woo it's nearly free — see C5 |
| Design system / styling + multi-theme | ⚠️ unclear | six style groups + per-option freeze + theme limits — a substantial subsystem with no Woo phase |
| **Cart-page price display (bundle 2)** | ⚠️ unnamed | §3.14 — real work, and Woo carts vary more |
| Translations | ❌ | Shopify Pro; WP has WPML/Polylang → **different answer**, §10 D-E |
| Cart display of selections | ✅ | `woocommerce_get_item_data`, **scalar-only** |
| Order metadata + admin order display | ✅ | parity, simpler |
| Order export with options | ❌ | Shopify Pro |
| Plan limits + matrix | ✅ | port the matrix model + the 4 limits |
| Onboarding wizard | ✅ Phase 20b | port the data-driven model |
| **Support impersonation** | ⚠️ entities exist, no phase | §3.16 |
| **Theme-compatibility diagnostics** | ❌ absent | §3.18 — arguably *more* valuable on Woo |
| Multi-store management | ❌ deferred | differentiator D5 #1 |
| Analytics | ❌ fast-follow #2 | differentiator D5 #2 |

**The headline gap remains: the Design Lab appears nowhere in the WooCommerce plan** — the
largest subsystem and, with multi-store and analytics, the strongest answer to *"why pay
monthly when EPO is $59 once?"* (D3/D5). Either it is in scope and needs phases, or it is out
and the positioning must survive without it.

---

## 7b. **[ADDED — seventh pass]** Every finding checked against `developePlan.md`

The previous six passes analysed the Shopify app. This pass does the comparison that matters
operationally: **for each finding, is it already in `developePlan.md`?** Checked by grepping
and reading the plan, finding by finding.

**Headline: the plan is better than my earlier sections implied, and I owe it two corrections.**
Of ~25 checkable findings, **18 are already covered — several more rigorously than I proposed.**
Three are genuine gaps. Four are partial.

### 7b.1 ✅ Already covered — and in five cases the plan is AHEAD of my recommendation

| My finding | Plan coverage | Verdict |
|---|---|---|
| §6d.1 Conditional-reveal unenforced server-side | **M17.4 — Server-side authority:** *"Hidden options must be **rejected**, not merely invisible: if a rule hides an option, a submitted value for it is a validation error. Conversely, conditionally-required options are enforced only when their condition holds."* Acceptance: *"submitting a value for a rule-hidden option fails validation."* | ⚠️ **CORRECTION TO ME.** I flagged this as "the most serious finding" and proposed B5c as new work. **The plan already specifies exactly this fix, including the required-ness half.** It remains a real Shopify *defect* and a real *risk* (it's the kind of milestone that gets skipped under pressure), but it is **not a plan gap.** B5c is a re-emphasis of M17.4, not an addition. |
| §6b.2 Formula drift TS↔PHP | **M11.4 — Cross-language fixture suite:** shared JSON fixtures run by **both** suites in CI, *"a divergence fails the build."* Covers rounding boundaries (`0.005`, `0.015`), JPY/KWD, negative deltas, percentage-of-percentage | ✅ **Ahead of me** — I said "make it a hard gate"; the plan already says CI-enforced with named boundary cases |
| §6b.3 Tamper model | **M11.5** (accept only selection keys; reject unknown option/value keys; reject options not applicable to this product; recompute price *"ignoring anything price-like in the request"*) + **M11.7 adversarial suite** — and Phase 4 already **ran a subset against a prototype and repelled all of them** (injected `price=1`, array-instead-of-scalar, unknown value, negative/absurd quantity) | ✅ **Ahead of me** — includes cross-**tenant** option keys, which I never thought to test |
| §6b.4 Float money | Phase 11 exit: *"Money handled as **integer minor units** end-to-end"* + `Support/Money.php` + a CI check | ✅ Covered |
| §6c.6 Unsorted selection payload | Line 3697: *"**Selection data must be canonically sorted before attaching.** `http_build_query` is order-sensitive… Sort keys deterministically — **this is the single**…"* | ✅ Covered, and flagged as a top-severity item |
| §5.3.4 Two `add_to_cart_validation` signatures | **M11.5** quotes both call sites verbatim and adds what I missed: *"the second… is the one used by **order-again/reorder** flows"* | ✅ **Ahead of me** |
| §6d.3 Upload guard / presigned | **M15**: *"presigned direct-to-storage so files never transit the API"*, magic-byte checks, EXIF stripping, dimension/count limits, malware scanning | ✅ Covered |
| §6d.3 SVG risk | Plan: **"SVG rejected by default (it is an XSS vector)"** / *"SVG blocked"* | ✅ **Ahead of me** — Shopify allows SVG and offloads the risk to a CDN header; the plan just refuses it |
| §6d.2 Raw HTML rendering | **M5.4c — Presentational items are not options**, listed in the risk register: *"Merchant-authored HTML is an **XSS boundary** → Allowlist sanitizer at **publish and render**; plan-gated"* + line 1864: *"rendered on a public storefront, so it is an XSS vector by construction"* | ✅ **Ahead of me** — sanitizing at *both* publish and render is exactly right, and is what Shopify fails to do |
| §3.14 `before_calculate_totals` idempotency | Line 1529: *"before_calculate_totals fire count **measured: 5 per request**; idempotent form required"* — measured, not assumed | ✅ **Ahead of me** |
| §5.3.2 Block-cart scalar constraint | Line 3771 + M2.8 notes | ✅ Covered |
| §5.3.3 `generate_cart_id` hashing | Lines 3679–3709, quoted verbatim from WC source | ✅ Covered |
| §4 Version skew | **M9.5 — Schema version negotiation:** keep last good config, admin notice, report on heartbeat, *"**Never** render a config it cannot fully parse"* | ✅ Covered — this answers my A6 |
| §6b.5 / §6d.4 Fail-safe on bad config | **M9.6 Degradation matrix** — 6 explicit rows incl. *"Config malformed → keep previous good version; alert"* and *"No cache at all → render nothing; **no error to the customer**"*. Acceptance: *"with the backend fully stopped, storefront and checkout work normally"* | ✅ **Ahead of me** |
| §3.23 Observability | Phase 31 + **M9.7 Cache observability** (config version, last fetch, last error, cache size, next sync) | ✅ Covered |
| §3.12 GDPR | **Phase 26b — Data Protection & Compliance** | ✅ Covered (my D-G is about *sequencing* it early, which stands) |
| §3.16 Support impersonation | `impersonation_sessions` table + *"consented, time-boxed, audit-logged"*, merchant consent required, banner shown | ✅ **Ahead of me** — Shopify's has no consent step |
| §6d.4 Presentational render cost | **M5.4c** exists as its own milestone; `partials/` principle writes label/required-marker/help-text/**character counter**/price badge **once**, composed by all 12 templates | ✅ Covered — and the shared-partials discipline directly answers §6c.3's duplication class |

### 7b.2 🔴 GENUINE GAPS — three things in no phase of `developePlan.md`

**Gap 1 — The Design Lab is completely absent.**
Grepping `design lab`, `designlab`, `canvas`, `overlay`, `artwork` across all 5,976 lines
returns **five incidental hits**: "uploaded artwork" as a segment need (line 184), a mock
order line (3880), file-retention prose (4284), and *"never a blank canvas"* about onboarding
templates (4637–38). **There is no Design Lab milestone, phase, entity, or exit criterion.**

This is 8,449 LOC and the single strongest cloud-only differentiator. §7's matrix already
flagged it; the seventh-pass confirmation is that it is absent from the *plan*, not merely
deferred in it — so it has no phase number, no dependency edge, and no estimate. **D-B is
therefore not a scoping question but a "this work is invisible to the schedule" question.**

**Gap 2 — Option/choice ID stability across an edit is unspecified.**
`id stab`, `preserve.*id`, `regenerat` → **zero hits.** The plan has `option_sets.version`,
optimistic locking, and publish/rollback — but never states that an update **preserves option
and value ids**. §6c.4 showed why it matters: plan-gate freezing matches the previous tree *by
id*, so a replace-the-tree endpoint that regenerates ids turns every downgraded merchant's
edit into a CREATE and **rejects their grandfathered content** — the exact outcome M24.4
forbids (*"Never silently delete merchant work"*). The requirement is implied by M24.4 but
never made explicit where it would be implemented. **Keep as A2(a).**

**Gap 3 — Cart-page and drawer price display has no milestone.**
`cart drawer`, `mini.cart`, `drawer` → **zero hits.** The plan covers `woocommerce_get_item_data`
(display selections in the cart) but not the *price* problem the Shopify app's second bundle
(1,099 LOC) solves: patching line unit price, line total, subtotal **and** grand total across
the cart page and any AJAX drawer, identified **by matching `/cart.js` data rather than
CSS classes**. On WooCommerce prices come from `WC_Cart` so much of this is native — **but
mini-cart/drawer fragments, block-cart totals, and third-party drawers are exactly where Woo
themes diverge most.** Needs at least an explicit "verify add-on pricing displays correctly in
classic cart, block cart, and AJAX mini-cart" acceptance criterion.

### 7b.3 ⚠️ PARTIAL — four things covered in principle, under-specified where it counts

| Item | What the plan has | What's missing |
|---|---|---|
| **Plan-change cache invalidation** (§6c.7) | **M9.4** push invalidation fires *"on publish"*, driven by `option_sets.version`; **M24.5** says the config carries plan state | **A plan change is not a publish.** Nothing states that a subscription/plan transition bumps `config_version` and pings the store. A merchant upgrading would keep a stale cached config — features paid for and not visible — until the ≤15-min cron. Easy fix, easy to miss: **make the billing webhook a config-invalidation trigger.** |
| **Per-character measure** (§6c.2) | Line 3573 specifies `per_char → amount × strlen(text)`; M14 gives text options `trim_whitespace` and a character counter | `strlen` **counts whitespace**, so the plan inherits the *pricing* half of the Shopify bug. And the counter is a separate `partials/` component — so the same "charged 5, shown 4" divergence is reachable. **Specify ONE measure function, shared by pricing and the counter, and fixture-assert they agree.** |
| **Design-system / styling subsystem** (§3.6) | `design system`, `swatch styl` → **zero hits.** Templates are theme-overridable and there is a `partials/` discipline | Shopify has six style groups, per-option override with save-time freeze, and multi-theme with a plan-limited count. The plan's answer appears to be *"themes override templates"* — a legitimate, more WordPress-native choice, **but it is an unstated product decision, not an oversight to fix.** Worth recording explicitly: are merchants styling via the dashboard, or via theme templates? |
| **Theme-compatibility diagnostics** (§3.18) | `selector health`, `theme compat` → zero hits; Phase 29 has a compatibility *matrix* (internal QA) | No **merchant-facing** self-diagnostic. Shopify's `window.__optionia.selectorHealth()` was explicitly intended to become an admin panel. On Woo, where theme variance is worse and you can't test every combination, this is a support-cost lever. Keep as **E7**. |

### 7b.4 What this comparison changes

1. **Two corrections to my own document.** M17.4 already specifies the conditional-reveal fix (my "most serious finding" is a Shopify defect and a delivery risk, **not** a plan gap), and M9.5/M9.6 already answer my A6 version-skew concern in more detail than I asked for.
2. **The plan's strongest sections are pricing and degradation.** M11.4–M11.7 and M9.5–M9.7 are more rigorous than my recommendations — including things I missed (cross-tenant option keys, the reorder-flow signature path, a *measured* 5-fires-per-request idempotency requirement, outright SVG rejection, sanitizing at publish *and* render).
3. **The plan's weakest area is everything visual** — Design Lab absent, design system absent, cart-display absent, diagnostics absent. That is a coherent pattern: **`developePlan.md` was written from a competitive teardown and a WooCommerce-hooks study, so it models the *transaction* superbly and the *presentation layer* thinly.** Which is exactly the half `optionia-app` has already solved (§6c.1 verified those files are platform-agnostic). **The two documents are complementary in a way that argues directly for amending ADR-001 (D-A).**
4. **Three additions to Stage A:** A7 (plan change ⇒ config invalidation), A8 (one character-measure function), A9 (record the styling decision — dashboard vs theme templates).

# PART III — THE PLAN

## 8. Current state → what to build

**Verified 2026-08-27:**

| Repo | State |
|---|---|
| `optioniaWooCommerceBackend` | **NestJS, substantial.** 162 src files · **32 TypeORM entities** · 5 migrations · 7 controllers · ~30 commits. Modules: auth, tenants, stores, option-sets (+publishing/serialization/types), products, orders, plans, subscriptions, usage, billing, webhooks, admin, audit, mail, health, common (tenancy/crypto/money/pagination/openapi). Docs: API-CONTRACT (859), DATABASE (808), DECISIONS (1,815), CONFIG-CONTRACT (291), ENVIRONMENTS. **Through Phase 7** — authoring API, publish/versioning/rollback, optimistic locking, audit trail, generated OpenAPI checked against the contract. |
| `optioniaWooCommercePlugin` | **PHP foundation, Phase 3 complete.** 28 src files: Plugin/Container/Autoloader · Activation · Admin · **Api (Client/CircuitBreaker/Response/ResponseValidator)** · Config · Engine (`Result` + **empty** Contracts/Types) · Frontend · Support (Assert/Cron/Environment/Keys/Logger/Money/Settings) · Upload (**empty**). PHPCS + PHPUnit + CI. **No option engine, no renderer, no cart integration.** |
| `optioniaWooCommerceFrontend` | **Does not exist.** |
| Local WP env | WP 7.1 · WC 11.0.1 · PHP 8.4 · Storefront 4.6.2 · HPOS on · block cart/checkout · all 4 product types + test order seeded |

**The real position:** cloud authoring is well ahead; **the plugin's entire evaluation half is
unbuilt**; the dashboard is unstarted. That is exactly where the Shopify app has most to give
— `app/storefront/` + both asset bundles + `designScene.ts` *are* the missing layer.

## 9. Recommended plan

### Guiding principles
1. **Port the domain, rebuild the platform.** The Shopify app is the *specification* and, for §6's ★ items, the *source*.
2. **The draft-order path is deleted, not translated** (§5.1).
3. **Keep all render geometry in JS/Node.** PHP evaluates *rules, prices, validation* — never design geometry (§5.5).
4. **Respect AC1–AC8.** They are sound and the backend is already built to them.
5. **Every ported subsystem arrives with its recorded bug history** — freeze+reject, `trialUsedAt` set-once, canonical selection ordering, the fail-closed/fail-open asymmetry, date anchors, `!important`-free CSS, data-not-selectors. **This is the whole reason porting beats greenfield.**
6. **[ADDED] Do not inherit the known-bad.** GDPR erasure, in-memory rate limiting, missing structured logging, and the four Design-Lab geometry defects are known *before* writing a line — fix them on the way in, not in a Stage-F audit.

### Stage A — Reconcile the plans *(first; nothing else is safe until done)*
- **A1** Amend or explicitly reaffirm **ADR-001** (§0). **Blocks everything.**
- **A2** Extract `app/types/` into a **shared contract package** (`@optionia/domain`) consumed by backend + dashboard, mirrored as a JSON Schema the plugin validates against. Reconcile against the 32 existing entities — expect naming drift (Shopify `OptionChoice` vs Woo `OptionValue`; Shopify's 3-level `OptionSet→Option→Choice` vs Woo's 4-level `OptionSet→OptionGroup→Option→OptionValue`). **Highest-risk item in the plan**; cheap now, expensive after the dashboard exists.
  **[ADDED — §6c.4] Two specific checks while doing it:** (a) confirm the Woo `option-sets`
  update endpoints **preserve option and choice ids across an edit** — freeze+reject matches
  the previous tree *by id*, so regenerating ids on save turns every edit by a downgraded
  merchant into a CREATE and rejects their grandfathered content, which is the exact
  data-destruction freeze exists to prevent; (b) give `number` options **their own
  `minValue`/`maxValue` columns** — Shopify reuses `minLength`/`maxLength` for them.
- **A3** Decide Design Lab scope (D-B) and multi-level-vs-rules (D-C). Add phases if in scope.
- **A4** Resolve **D1 billing provider** — open, still blocking Phase 22.
- **A5** Write `PORTING-RULES.md` in the plugin repo: explicit do-not-port (draft order, `priceOverride`, checkout hijack, `_addon_price` display property, app-proxy HMAC on the render path) and do-port-verbatim lists.
- **A6 [ADDED]** Confirm `CONFIG-CONTRACT.md` handles **plugin/config version skew** (§4). **[RESOLVED — seventh pass]** `developePlan.md` **M9.5** already specifies this (keep last good config, admin notice, report on heartbeat, *"never render a config it cannot fully parse"*) and **M9.6** gives a 6-row degradation matrix. **Reduced to: verify `CONFIG-CONTRACT.md` matches M9.5/M9.6.**
- **A7 [ADDED — §7b.3]** Make a **plan/subscription change a config-invalidation trigger.** M9.4 fires invalidation *"on publish"*, driven by `option_sets.version` — but a plan change is not a publish, so an upgrading merchant keeps a stale config (paid-for features invisible) until the ≤15-min cron. One-line fix in the billing webhook; easy to miss because it crosses the billing/authoring boundary.
- **A8 [ADDED — §7b.3]** Specify **ONE character-measure function**, shared by per-character pricing and the character counter, and fixture-assert they agree. The plan's `per_char → strlen(text)` counts whitespace; Shopify's counter doesn't — the same "charged 5, shown 4" divergence (§6c.2) is otherwise reachable in the new codebase.
- **A9 [ADDED — §7b.3]** Record the **styling decision** explicitly: Shopify has a dashboard-authored design system (six style groups, per-option freeze, plan-limited multi-theme); `developePlan.md` has *no* design-system milestone and instead relies on theme-overridable templates. That is a defensible, more WordPress-native choice — **but it is currently an unstated product decision, not a documented one.**

### Stage B — Close the plugin's evaluation half *(the critical path)*
`Engine/` is empty. Fill it, porting semantics from the Shopify core.
- **B1 Config projection + cache.** Versioned config → `wp_options`, signed, refreshed out-of-band. **AC3: zero synchronous cloud calls on a customer page load.** **[EXPANDED — §6c.7]** The Shopify render route proves the input is a **6-way join** (option sets · design system · translations · plan gates · preferences · cart settings) served `no-store` per product/locale/plan. The plugin must receive that **pre-joined and versioned**, with invalidation on **all six** triggers — including **plan change**, the one that originates in *billing* rather than an authoring action and is therefore easiest to miss. Carry `ver` in the payload and tolerate an unrecognised one (§6c.6, A6).
- **B2 Renderer — classic path.** Port `build-html.ts` + `build-styles.ts` semantics behind `woocommerce_before_add_to_cart_button`; handle the **per-product-type hook position**. **[EXPANDED — §6d.4]** Budget real time for the "presentational" types: `divider` synthesizes 3 of its 10 styles (SVG-data-URI wave, gradient triple, ≥3px clamp for bevels) and `heading` always emits inline font-size and constant margin so browser defaults can't leak. **Port the render-time re-validation habit** (hex regex on colours, clamped integers on sizes) — the plugin renders a *fetched* config, so treating every stored value as untrusted at emission is what keeps a bad config ugly instead of injectable. **And sanitize `html`/`paragraph` server-side on save AND `wp_kses_post()` on render** (§6d.2) — Shopify sanitizes client-side only, and the Woo block path would otherwise kses one path and not the other.
- **B3 Renderer — block path.** Store API `ExtendSchema`. **AC7 from the start, not discovered in Phase 29.**
- **B4 Client runtime (bundle 1).** Port validation, pricing display, children, form-sync, date-picker, calendar, selector-engine. Rewire `cart-intercept`. Delete the checkout-hijack modules.
- **B5 Pricing evaluator (PHP).** Port `addon-pricing.server.ts` **semantics, not its arithmetic** (§6b.4 — re-express in `Money` minor units). **AC4: recompute from cached config at `add_to_cart`, re-validate at checkout; the browser sends selection identifiers only.** Apply at `woocommerce_before_calculate_totals`. Carry over the whole tamper model (§6b.3): selection-not-prices, defensive caps, the choice cap, unknown/hidden options contribute nothing, malformed → charge zero, round once. **And add the one thing that does not port: clamp `q`** — Shopify's draft-order API rejected absurd prices for free; WooCommerce will accept them.
- **B5c [§6d.1 — do not let M17.4 slip] Make visibility a server-side gate.** **This is already `developePlan.md` M17.4**, restated here because Stage B's pricing work depends on it and the Shopify app proves what happens without it. In PHP, before pricing: resolve which options are actually **visible** given the submitted selections (a child option's `parentChoiceId` must appear among the same submission's selected choice values, evaluated **transitively**), then (a) **reject any selection entry for a non-visible option** — the Shopify server prices every child in a flat index regardless of whether its parent was chosen — and (b) recompute **required-ness against the resolved visibility** and reject the add-to-cart if a visible-and-required option is missing. Highest-priority correctness item in Stage B.
- **B5b [ADDED] Port the key contract first** (§6b.1). One PHP file mirroring `option-core/keys.ts`, generated from or checked against it, before any renderer or cart work — every later stage depends on those keys agreeing.
- **B6 Cross-language fixture suite — a real gate, not a checkbox** (§6b.2). One JSON fixture set, authored in **minor units**, asserting the client display total and the PHP charged total are **identical** — including adversarial fixtures (forged multi-select on a radio, negative price, absurd `q`, unknown option id, hidden option, malformed selection). **Extended to design geometry** if the Design Lab is in scope. *Justification: the Shopify app proves two copies of a formula in the SAME language drift while a comment claims parity.*
- **B6b [ADDED] Collapse every duplicated constant and formula to one definition per language.** Three known instances: the add-on formula (server should import `option-core/addon.ts`, with the choice cap moved into it — §6b.2); the Design Lab's `1.25` line-height (export `LINE_H`, import it in all five surfaces — §6c.3); and the character measure (**one** function for pricing *and* limits — §6c.2). Each is currently held together only by a comment, and one has already drifted.
- **B4b [ADDED] Canonically sort the selection payload** before it becomes `cart_item_data` (§6c.6). The Shopify source emits DOM order; Woo's `generate_cart_id()` uses order-sensitive `http_build_query`, so unsorted keys mean spurious duplicate cart lines. Port `cart-intercept.js`'s **1500 ms duplicate-add dedupe** too — Woo has the same double-fire problem across three add paths (`wc-ajax=add_to_cart`, Store API `add-item`, classic form POST).
- **B7 Cart / checkout / order.** `woocommerce_add_cart_item_data` (**canonically sorted, deterministic**) · `woocommerce_get_item_data` (**scalar strings only**; wrap the `__experimental_` key) · `woocommerce_checkout_create_order_line_item` · `woocommerce_after_order_itemmeta`. **Freeze selections at order time.** Test HPOS **on and off**.
- **B8 Validation — close the gap, don't port it** (§6b.5). Shopify enforces option-field validation **client-side only**; the authoring API must enforce it server-side (backend `ResponseValidator` + `option-sets/serialization/` are the right homes — confirm they cover field *coherence*, not just envelope shape). Separately, the plugin must **fail safe on a config it cannot validate**: skip the offending option, render the rest, log — never fatal on a merchant storefront. Customer-input validation stays: PHP is the boundary, JS is UX.
- **B9 [ADDED] Cart-page price display (bundle 2).** Port §3.14's data-not-selectors engine to Woo carts (classic + block + drawers).
- **B10 [ADDED] Observability + Redis rate limiting from the start**, not Stage F (§3.19).

### Stage C — Dashboard *(parallel to B once A2 lands)*
- **C1** Scaffold `optioniaWooCommerceFrontend` (Next.js App Router · TS · Tailwind · shadcn/ui · TanStack Query · RHF · Zod).
- **C2** Auth, tenant/store shell, navigation. Port the **screen inventory** (§3.15), not the code. Include the 19-skeleton convention.
- **C3 Option-set builder** — the biggest UI surface (`OptionBuilder` 1,149 + `OptionEditorModal` 1,641 + `OptionInputFields` 1,508 + `ChoiceEditor` 674 LOC). Port structure and behaviour; rewrite presentation.
- **C4** Product sync + assignment UI over the synced catalogue.
- **C5 Live preview** — the payoff for keeping `app/storefront/` framework-agnostic: one core renders preview and storefront ⇒ *preview == storefront by construction*. Shopify defers this to Pro; on Woo it's nearly free → **pull it earlier than Phase 21**.
- **C6** Design system tabs (six groups, per-option override with save-time freeze, multi-theme + limits).
- **C7** Preferences, orders list/detail, plan/billing pages.
- **C8 [ADDED]** Support impersonation (§3.16) — entities exist; carry over revocation-not-TTL and never-put-the-token-in-the-cookie.

### Stage D — Commercial layer
- **D1** Port the **plan matrix** (`featureKey`→`rangeId`→`maxRange`) + all four limits with accessor-based fallbacks. Never hardcode tiers.
- **D2** Port **freeze + reject**, three layers, server as the real boundary. **Grandfathered content is frozen, never stripped.**
- **D3** Billing behind the `BillingProvider` interface (M22.2) + webhooks reconciling in real time. Port `trialUsedAt` **set-once**.
- **D4** Port the data-driven **onboarding** model (discriminated-union actions, code-side registry, both URL lessons, the degrade-to-Next failure mode).
- **D5** Usage/limits enforcement incl. the active cap + **reconciliation modal**.

### Stage E — Fast-follows (in order)
- **E1 File upload** — fast-follow #1. **Use the §3.9 direct-upload + signed-token pattern from day one**; cloud storage, not the merchant's disk (differentiator D5 #4). PHP upload limits make this *more* necessary than on Shopify. **[EXPANDED — §6d.3]** Port the whole guard design: **one guard shared by every upload path** (*"a difference in the denylist or size cap between them would let an attacker pick the weaker path"*), the **denylist-not-allowlist** reasoning, and the **presigned-`ContentLength`** trick that makes the storage provider enforce the size cap. The blocked `php`/`phtml`/`asp` extensions are not theoretical on WordPress — an uploaded PHP file under `wp-content/uploads` is **RCE on the merchant's server**, which is the strongest technical case for keeping uploads off their disk. **Resolve the SVG question explicitly:** `svg` is deliberately allowed and the risk is offloaded to a CDN download-disposition header — confirm that header is actually set, or block it.
- **E2 Design Lab** — if in scope (D-B). Port `designScene.ts` **verbatim**, fix the four known geometry defects, order PNG cloud-side, overlay targeting for arbitrary WP themes.
- **E3 Analytics** — differentiator D5 #2.
- **E4 Advanced pricing** — per-character / per-number / tiered.
- **E5 Tier-2/3 option types** — but see D-D: **date-picker probably belongs in MVP**.
- **E6 Multi-store management** — differentiator D5 #1, structurally impossible for self-hosted competitors.
- **E7 [ADDED] Theme-compatibility diagnostics** (§3.18) — promote the debug toolkit to a product feature. Cheap; disproportionate support value on WooCommerce.

### Stage F — Hardening & launch
Fix the **inherited** problems (§3.23) rather than re-inheriting them, then the existing
plan's Phases 27–35 (security audit, performance, compatibility matrix, tests, monitoring,
docs, closed beta, production deploy, WP.org distribution).

## 9b. Top risks

Ranked by expected cost, with the fourth-pass findings folded in.

| Risk | Why it's real | Mitigation |
|---|---|---|
| **The two plans stay unreconciled** and work proceeds on both premises | Two large, high-quality, contradictory documents already exist; silent divergence is the default | **A1 before any code.** One amended ADR naming all four repos (§0) |
| **🔴 Conditional-reveal visibility is unenforced server-side** | **§6d.1 — traced end to end.** `buildOptionIndex` flattens every child option into one priceable map; the server checks only `isHidden` (the merchant's flag), never whether a child's `parentChoiceId` was actually selected. Visibility lives in `style.display` and is enforced in **6 client files only**. Required-ness likewise. A hand-crafted payload can price unreachable options, or omit a revealed required one | **B5c** — build AC2's rule evaluator: resolve visibility transitively in PHP, reject non-visible entries, recompute required-ness against resolved visibility. **B6 fixtures:** "child priced without parent selected", "revealed required option omitted". Also strengthens **D-C** |
| **★ Pricing drift between the PHP evaluator and the JS display** | **Already happened inside one language, with a comment asserting parity** (§6b.2). Across TS/PHP it is the default, and the symptom is *"the customer was charged a different number than they saw"* | **B6 as a hard gate** — fixtures in minor units, client total ≡ PHP total, adversarial cases included. **B6b** collapses to one definition per language |
| **★ A forged `q` becomes a real charge** | The unclamped-`q` rule was safe only because Shopify's API rejected the result (§6b.3). WooCommerce accepts it | **Clamp `q` in B5.** Add an absurd-`q` fixture to B6 |
| **Float money drift** | Shopify accumulates dollars as floats; one end-rounding hides it today, per-line accumulation would not (§6b.4) | Plugin `Money` (integer minor units) is authoritative; fixtures authored in minor units |
| **Domain-model drift** between the 32 TypeORM entities and Shopify's `app/types/` | Shapes already differ (`OptionChoice`/`OptionValue`; 3-level vs 4-level hierarchy). Cheap now, very expensive after the dashboard exists | **A2 first**, one shared contract package, reconcile before C3 |
| **Someone ports the draft-order path** because the code is right there | ~2,500 lines of plausible, well-written code that must be **deleted** | `PORTING-RULES.md` (A5) with an explicit do-not-port list |
| **A malformed option set reaches a live storefront** | Option-field validation is client-only (§6b.5); duplicate choice values are documented as storefront-breaking; the plugin has no admin to fix it in | Enforce in the authoring API (**B8**) + plugin **fails safe**: skip the option, render the rest, log |
| **Design-Lab pixel parity breaks across the PHP/JS boundary** | It broke **8 times inside one language** and needed numerically verified fixes; 4 defects remain open (§3.7) | Keep geometry in JS/Node only (§5.5); extend B6 to geometry |
| **Block-cart silent data loss** | `continue 2` on a non-scalar **discards the element with no error** — fine in classic cart, vanishes in block cart | Scalar-only enforced at one boundary helper + a block-path test in the compatibility matrix |
| **★ Spurious duplicate cart lines** | `http_build_query` is order-sensitive inside `generate_cart_id()` — and the Shopify source emits the selection in **DOM order, unsorted** (§6c.6, verified). DOM order is *usually* stable, so this passes manual testing and fires on a reorder | **B4b** — canonical sort + deterministic payload; a merge/no-merge test pair; port the 1500 ms double-fire dedupe |
| **Freeze+reject silently becomes reject-everything** | Freeze matches the previous tree **by id** (§6c.4). If the Woo authoring API regenerates ids on save — normal for a replace-the-tree endpoint — every edit by a downgraded merchant destroys their grandfathered content | **A2(a)** — assert id stability on update; B6 fixture: downgrade → edit → nothing lost |
| **Merchant/customer-visible pricing inconsistency** | **Live bug** (§6c.2): per-character pricing counts whitespace, the character counter and limits don't. "AB CD" = charged 5, shown 4 | Pick one measure (`countChars`), use it in one place, fixture-assert the two agree |
| **GDPR erasure ships incomplete again** | Shopify's is materially non-compliant *because it was retrofitted* (§3.12) | **D-G** — design "delete every byte for one customer" into the Stage-B schema |
| **WordPress ecosystem compatibility** | Thousands of plugin/theme combinations; no Shopify equivalent | AC7 both paths from Stage B (not Phase 29); HPOS on **and** off; §3.18 diagnostics as E7 |
| **Config/plugin version skew** | On WooCommerce old plugin versions live forever (§4) | **A6** — confirm `CONFIG-CONTRACT.md` specifies forward/backward degradation |
| **Re-inheriting the known-bad** | In-memory rate limiting, missing structured logging, the 4 geometry defects — all documented and unfixed | §3.23 is a Stage-F checklist; observability + Redis rate limiting land in **B10** |

## 10. Decisions I need from you

| # | Decision | Why it blocks | Recommendation |
|---|---|---|---|
| **D-A** | **Is `optionia-app` the spec/source, or is this greenfield?** ADR-001 correctly rules out the three *marketing* repos but never assessed `optionia-app` itself (§0). | **Everything.** Whether §6's 13–15k LOC is reused or rewritten. | **Amend ADR-001 — don't reverse it.** Keep "standalone from the marketing stack"; add a clause naming `optionia-app` as the product spec and the source for §6's ★ items. Rewriting `designScene.ts` and `app/storefront/` discards verified fixes for no gain. |
| **D-B** | **Is the Design Lab in scope?** 8,449 LOC, strongest differentiator, **in no phase.** | Phase count, timeline, the D3/D5 pricing argument. | **In scope, post-MVP (E2), planned now.** A large part of the answer to "why monthly?" |
| **D-C** | **Multi-level child options (tree) vs conditional rules (Woo plan).** Backend already has `option-rule.entity.ts`. | The data model — so A2, C3, B5/B5c. | **Rules as the primitive, tree nesting as a UI affordance over it** — and **§6d.1 makes this materially stronger than when I first argued it.** In the tree model, visibility lived implicitly in `style.display` and was therefore never evaluable server-side, which is precisely how it ended up unenforced. A rule engine forces visibility to be an **explicit, evaluable predicate** — the same object the PHP evaluator needs anyway. Still confirm the Shopify merchant workflows all express as rules. |
| **D-D** | **Does `date-picker` move into MVP?** S4 defers it; Shopify treats it as *paid*; food/florists can't buy without it. | MVP scope, pricing page. | **Move it in.** Modest work; unlocks a named segment. |
| **D-E** | **Translations approach.** Shopify has a per-locale subsystem (Pro); WP has WPML/Polylang. | Port vs integrate. | **Integrate with WP i18n + `.pot`/`.po`** for plugin strings; keep merchant-authored labels as cloud data. Don't port the Shopify locale subsystem wholesale. |
| **D-F** | **D1 billing provider** — open since Phase 1. | Phase 22, entities, tax, pricing page. | **Paddle or Lemon Squeezy** unless the operating company has working Stripe access. |
| **D-G [ADDED]** | **GDPR/erasure design — build it right up front?** Shopify's is materially non-compliant (§3.12). | Stage B data model; WP privacy hooks; launch risk. | **Yes.** Design "delete every byte for one customer" into the schema in Stage B — with cloud file storage it is a *design* problem, and retrofitting is what produced the current gap. |
| **D-H [ADDED]** | **`docs/security.md` references an `OrderRecordAccessLog` control that grep cannot find** (§3.22). | Whether it can be reused as a compliance artifact. | **Verify against the Express backend before reusing.** If it was never built, the document overstates the controls in force. |

## 11. Summary of corrections

### Seventh pass — every finding checked against `developePlan.md`

The first six passes analysed the Shopify app. This one asked the operational question: **is
each finding already in the WooCommerce plan?** Full results in §7b. Two corrections to me,
three genuine gaps.

1. **⚠️ CORRECTION: my "most serious finding" is not a plan gap.** **M17.4** already specifies conditional-reveal enforcement verbatim — *"Hidden options must be rejected, not merely invisible"* — including the conditionally-required half and an acceptance criterion. It remains a real Shopify defect and a delivery risk, but B5c is a **re-emphasis**, not an addition (§6d.1 corrected in place).
2. **⚠️ CORRECTION: A6 was already answered.** **M9.5** (schema-version negotiation, *"never render a config it cannot fully parse"*) and **M9.6** (a 6-row degradation matrix, acceptance: *"with the backend fully stopped, storefront and checkout work normally"*) cover version skew more thoroughly than I asked. A6 reduced to a consistency check.
3. **The plan is AHEAD of my recommendations in five places** — and it's worth naming them, because they're things I missed: **cross-tenant** option keys in the adversarial suite; the second `add_to_cart_validation` signature being *the reorder-flow path*; `before_calculate_totals` idempotency with a **measured** 5-fires-per-request; **SVG rejected outright** (vs Shopify allowing it and trusting a CDN header); and merchant HTML sanitized at **publish *and* render** (vs Shopify's client-only).
4. **🔴 Three genuine gaps.** **(a) The Design Lab is entirely absent** — 5 incidental word-hits across 5,976 lines, no phase, no entity, no estimate, so it is invisible to the schedule rather than deliberately deferred. **(b) Option/choice ID stability across an edit is unspecified** (zero hits) — and §6c.4 shows a replace-the-tree endpoint that regenerates ids would destroy grandfathered content, violating M24.4's own *"never silently delete merchant work."* **(c) Cart-page/drawer price display has no milestone** — the plan covers displaying *selections* but not patching line/subtotal/grand totals across classic cart, block cart, and AJAX drawers.
5. **Four partials → new Stage-A items:** **A7** plan-change must trigger config invalidation (M9.4 fires only on *publish*, so an upgrading merchant sees stale config); **A8** one shared character-measure function (the plan's `strlen` inherits the whitespace half of §6c.2's bug); **A9** record the styling decision (Shopify: dashboard design system; plan: theme-overridable templates — defensible but undocumented); **E7** merchant-facing theme diagnostics (the plan's Phase 29 matrix is internal QA only).
6. **The pattern is the useful part.** `developePlan.md` was written from a competitive teardown plus a WooCommerce-hooks study, so it models the **transaction** superbly (pricing, tamper, degradation, cart mechanics) and the **presentation layer** thinly (no Design Lab, no design system, no cart display, no diagnostics). That is precisely the half `optionia-app` has already solved, in files §6c.1 verified are platform-agnostic. **The two documents are complementary — which is the strongest practical argument yet for amending ADR-001 (D-A).**

### Sixth pass — the four important features, read as behaviour

Targeted the gap I named myself: features I'd described without reading how they work — the
renderer's per-type contract, file upload (fast-follow #1), date-picker (D-D), and conditional
reveal (D-C). Now §6d. **Two security findings, one of them the most serious in six passes.**

1. **🔴 Conditional reveal has no server-side enforcement** (§6d.1). Traced end to end: visibility is `style.display`, enforced in **six client files**; the server's `buildOptionIndex` **flattens every child option** into one priceable map and checks only `isHidden` — the *merchant's* hide flag, not reveal state. **The server never verifies a child's `parentChoiceId` was actually selected.** So a crafted payload can price unreachable options, and — because required-ness is also client-only — can omit a revealed required option. **This is AC2's engine piece #1 ("which options are visible/required given current selections"), which the Shopify app never built server-side and the WooCommerce plan already calls for.** New Stage-B item **B5c**, top of the risk table, and it strengthens **D-C**.
2. **⚠️ `html` and `paragraph` render raw; sanitization is client-only** (§6d.2). `sanitizeHTML()` is real and careful, but **every call site is in `app/components/`** — no server-side sanitization on save or render. Mitigated in practice (requires an authenticated merchant on their own store, and `html` is a deliberate raw-markup Pro feature), but on WordPress this is a WP.org review finding, not a design choice: `wp_kses_post()` on render **plus** server sanitization on save, in both languages.
3. **★ Uploads: three paths, not two — and the guard design is exemplary** (§6d.3). I'd documented two; there is also a **presigned direct browser→Spaces PUT**. One shared guard exists specifically so *"a difference in the denylist or size cap between them would let an attacker pick the weaker path."* A **denylist** is correct here (merchants configure arbitrary custom extensions), the presigned URL is signed with `ContentLength` so **Spaces itself enforces the size cap**, and the threat model is named exactly: *"the app-proxy HMAC signs only query params, not the body."* One open question: **`svg` is deliberately allowed** with the risk offloaded to a CDN download-disposition header — verify that header exists. The blocked `php`/`phtml` entries make the cloud-storage differentiator a security argument on WordPress, not just a convenience one.
4. **The "presentational" types are not cheap** (§6d.4). `divider` synthesizes 3 of 10 styles (SVG-data-URI wave, gradient triple, forced ≥3px bevels); `heading` always emits inline font-size and constant margin so browser defaults can't leak. Both **re-validate their own stored styles at render time** (hex regex, clamped integers, *"to prevent any CSS injection"*) — a habit the plugin needs *more*, since it renders a config fetched from the cloud.
5. **Confirmed with no defect:** the date-picker's `resolveBound()` implements the frozen-anchor semantics exactly as §3.3 describes, in ~90 lines — reinforcing **D-D** (moving it into MVP is cheap and unlocks a named segment).

### Fifth pass — the 6,900 lines I had described but never opened

Read in full: `designScene.ts`, `runtime.ts`, `build-html.ts`, `build-styles.ts`,
`enforce.server.ts`, `option-sets.server.ts`, the app-proxy render route,
`file-attachment.ts`, `cart-intercept.js`, `validation.js`, `form-sync.js`. Now §6c.

1. **✅ My strongest claim survived.** The four biggest "platform-agnostic" files import nothing Shopify-specific — verified import by import. **One caveat:** `formatMoney` is a Shopify-token, float-based leaf that both `build-html` and `runtime` depend on, so the port has one deliberate seam at exactly the money boundary (§6c.1).
2. **⚠️ A live bug** (§6c.2): per-character pricing measures `trim().length` (whitespace **included**) while the character counter and min/max limits use `countChars` (whitespace **excluded**). `"AB CD"` → charged 5, displayed 4. Display and server agree with each other, so it isn't a tamper issue — it's a merchant/customer-facing inconsistency in the exact feature (engraving) that a named target segment buys.
3. **⚠️ The Design Lab has the same defect class its own docs warn about** (§6c.3): the `1.25` line-height appears as a **bare literal in six places across five surfaces** — including the order PNG — held together by one comment. This is the file I called "highest-value to port unchanged." Still worth porting; **fix it on the way in.** (The surrounding ratio-not-pixels discipline *is* genuinely enforced — `minFontRatio = 1/25`, radius from box-and-curve only.)
4. **★ Freeze+reject is better than I described, and has a hidden prerequisite** (§6c.4): it indexes the previous tree by id at both levels, restores ~18 fields individually, deliberately **excludes `type`** from freezing (so a tampered type-change is rejected rather than grandfathered), and **diffs** nesting rather than flag-checking it. But it all rests on **ids being stable across an edit round-trip** — now an explicit A2 check, because regenerating ids on save would turn freeze into destroy.
5. **★ `cart-intercept.js` is a strategy, not glue** (§6c.5): intercept the *network layer*, not the form, because *"the ONE thing every add has in common is the request to `/cart/add`."* Plus a 1500 ms duplicate-add dedupe keyed on variant + selection. Both transfer, and Woo needs them more (three add paths, worse theme variance).
6. **⚠️ `_optionia_sel` is emitted in DOM order, unsorted** (§6c.6) — I had written "canonically sort" as an instruction without verifying the source doesn't. It doesn't. Straight into Woo's order-sensitive `generate_cart_id()`. Also newly found: the payload carries **`ver: 1`** with unknown-field tolerance — a real versioning hook, directly useful for A6.
7. **⚠️ The render route is a 6-way parallel join served `no-store`** (§6c.7). Correct on Shopify, and precisely what AC3 forbids on Woo. This turns B1's cache from a line item into a specification with **six invalidation triggers** — one of which (**plan change**) originates in billing, not authoring, and is the easy one to miss.

### Fourth pass — the implementation, read (not just the docs)

Everything before this pass came from documentation and file inventories. This pass read the
**code that decides whether money is correct**, and found five things no doc mentions — now
§6b:

1. **The add-on formula exists twice and the copies disagree** (§6b.2). A shared pure core is imported by both *client* surfaces; the **server carries its own copy** whose comment claims parity but which differs on `file-attachment` (currently latent) and — more importantly — has a **choice cap the shared core lacks**, a real anti-tamper control. Two copies in one language drifted while a comment asserted they hadn't. Across TS/PHP that is the default outcome, which is why **B6 is now specified as a hard gate with adversarial fixtures**, not a checkbox.
2. **A safety rule that does not survive the port** (§6b.3). The server deliberately leaves `q` unclamped because *Shopify's draft-order API rejects an out-of-range price* → fails closed. **WooCommerce will accept it.** The plugin must clamp `q` — a rule that was only ever safe because of a platform behaviour that disappears.
3. **Float money vs the plugin's integer-minor-units mandate** (§6b.4). The Shopify app accumulates dollars as floats; `Support/Money.php` already forbids exactly that, with a CI check and correct JPY/KWD handling. **The plugin is right and the mature codebase is wrong** — port semantics, re-express arithmetic.
4. **Option-field validation has no server boundary** (§6b.5) — verified by reading the action. Duplicate choice values, which the app's own docs say break the storefront, are client-enforced only. Tolerable on Shopify (self-inflicted only); **not tolerable for a plugin rendering cloud config on a live storefront with no admin to fix it.**
5. **The cart-property key contract** (§6b.1) is a genuine asset with two non-obvious lessons baked in (colon-free keys to survive cart→draft→order; strip whitespace and underscores *together*). Port the discipline before any cart work.

Also **corrected a doc-derived claim of my own**: the order pipeline **does** have idempotency — an upsert keyed on `shopifyOrderId`, with a deliberate second enrichment pass. The ARCHITECTURE doc's "verify idempotency" reads as though it were missing; it isn't. The residual risk is the cross-store transaction, not duplicate orders (§3.23 item 3).

And **credit where due:** the Woo plugin's `CircuitBreaker` has no Shopify counterpart and correctly anticipates a WooCommerce-only failure mode (every store retrying on every cron tick = self-inflicted DoS against your own API). Where the two codebases disagree, **check which one is reasoning from its own platform's constraints before assuming the mature one wins.**

### Third pass — the sibling repos, inspected

**I was unfair to ADR-001, and correcting that changes the recommendation's shape.**

The three sibling repos are on this machine one directory up, and I had not looked at them.
Having now done so: `optionia-backends` (NestJS marketing CMS), `optionia-websites` (Next.js
marketing site) and `optionia-dashboards` (Vite admin panel for the CMS) are **exactly what
ADR-001 said they were** — a marketing stack with essentially no Shopify references and no
product logic. Its reasoning ("a CMS deploy must not be able to take down merchant
storefronts") is correct and should stand.

**The error is scope, not judgement:** it surveyed the three marketing repos, concluded no
prior implementation existed, and never assessed `optionia-app` — which sits *inside* the
WooCommerce workspace itself. Compounding it, the names collide almost perfectly:
`optionia-backends` ≠ `optionia-app-api`, and `optionia-dashboards` ≠ `optionia-app-admin`.

**Consequence for D-A: amend ADR-001, do not reverse it.** Keep the standalone-from-marketing
decision; add a clause naming `optionia-app` as the product spec, and name all four repos
explicitly so the collision cannot cause this again. That is a smaller, easier change to
accept than the reversal I originally implied — and it leaves the ADR's actual reasoning
intact.

### Second pass — code audit

For the record, since the first version of this file stated these wrongly:

1. **Large-file uploads are SOLVED**, not open — direct-upload route + signed token + CORS (§3.9). And the *pattern* is directly needed on WooCommerce.
2. **Sentry IS wired**, client and server (§3.19). The real gap is structured logging / metrics / health endpoint.
3. **GDPR is materially non-compliant**, not "handled" — a verified audit with three under-erasing webhooks and four PII locations left behind (§3.12). Upgraded to a top-tier risk and a new decision (D-G).
4. **There are two storefront bundles**, not one — the cart-pricing engine (1,099 LOC) was missed entirely, and it is one of the best-transferable pieces in the app (§3.14).
5. **Four subsystems were missed:** support impersonation mode (§3.16), the Sidekick AI extension (§3.17), theme-compatibility diagnostics (§3.18), and the thin-loader JS-hosting architecture (§3.14).
6. **Four Design-Lab geometry defects are known-open** (§3.7) — the port inherits known issues, not clean code.
7. **Rate limiting is in-memory** and explicitly won't survive multi-instance (§3.19) — a day-one requirement for NestJS, not a later optimization.
8. **§5.4 is new** — the first pass counted only the porting cost, never the substantial platform tax that *disappears*.

---

## Appendix — Source inventory

**Read in full:** `optionia-app/.claude/` — `APP_FEATURES.md` (265) · `ARCHITECTURE.md` (139)
· `DATABASE_AND_IMPLEMENTATION.md` (87) · `DESIGN_LAB.md` (375) · `DRAFT-ORDER-FUNCTION.md`
(139) · **`GDPR-REDACT-ROADMAP.md` (142)** · `HANDOFF.md` (68) · `JS-HOSTING-PLAN.md` (139) ·
`ONBOARDING-MODEL.md` (398) · `ROADMAP.md` (279 + 65KB detail, incl. the full REMAINING
section) · `TRANSLATION-LOCALE-ROADMAP.md` (176). Plus **`docs/security.md`** and
**`docs/storefront-debug-tools.md`**.

**Code inspected:** `package.json` · `shopify.app.toml` · `prisma/schema.prisma` (41 models,
10 enums) · `app/types/option.ts` + `option-set.ts` (full) · `plan-features.ts` ·
`rate-limit.server.ts` · `sentry.server.ts` · `support-session.server.ts` ·
`SupportModeContext.tsx` · `redis/keys.server.ts` · `routes/events.tsx` ·
`direct-upload.customer-file.tsx` · `_app.privacy-policy.tsx` ·
`assets/optionia-storefront/{index,cart-pricing}.js` · `settings/defaults.ts` ·
`translations.server.ts` · export surfaces of `build-html`/`build-styles`/`addons`/
`addon-pricing.server` · `extensions/optionia-tools/{tools.json,instructions.md}` ·
Shopify-dependency grep (28/297 files) · LOC census (68,669).

**WooCommerce side:** `developePlan.md` (5,976 — S0–S4, AC1–AC8 in full) ·
`OptioniaStartRoadmap.md` (1,990) · `OptioniaWooCommerceDeveloperMasterMilestone.md` (2,096) ·
`docs/woocommerce-notes/*` (all three, full) · `optioniaWooCommerceBackend` (162 files, 32
entities, 5 migrations, 7 controllers, git log, `docs/DECISIONS.md` ADR-001…005) ·
`optioniaWooCommercePlugin` (28 src files, git log, `optionia.php`).

**Sibling repos — inspected (third pass), and NOT the ones we need.** All three live at
`/Users/omihasan/Desktop/parselabllc/` and are the **marketing stack**, confirming ADR-001's
reasoning while exposing its scope error (§0):

| Repo | Stack | Contents | Relevance |
|---|---|---|---|
| `optionia-backends` | NestJS + TypeORM, 175 src files | blog · pages · categories · tags · testimonials · pricing · privacy-policy · terms · robots/sitemap · contact · partner · uploads · auth/roles/permissions | **None.** No Shopify references in `src/`. A CMS. |
| `optionia-websites` | Next.js App Router | public marketing site — `/blog`, `/pricing`, `/features`, `/about`, `/contact`, `/partner` | **Marketing copy only** — the Shopify hits are SEO metadata and an icon, no product logic. Useful only as an input to the D3 positioning answer. |
| `optionia-dashboards` | Vite + React + Ant Design | generic admin CRUD panel for the CMS above | **None.** |

**Still not inspected — genuinely absent from this machine:** `optionia-app-admin` (the
*product's* internal admin panel — distinct from `optionia-dashboards`) and `optionia-app-api`
/ `backend/` (the **Express** API owning the per-merchant DBs — distinct from
`optionia-backends`). Both are referenced throughout `optionia-app`'s docs.

> ⚠️ **The name collisions are a real trap.** `optionia-backends` (marketing CMS, NestJS, on
> disk) is *not* `optionia-app-api` (product API, Express, missing); `optionia-dashboards`
> (CMS admin, on disk) is *not* `optionia-app-admin` (product admin, missing). ADR-001 was
> almost certainly written after looking at the two that are present. **Name them explicitly
> in the amended ADR so this cannot recur.**

**The missing Express backend holds `base_schema_V001.sql` — the per-merchant schema and a
stated source of truth for the data model. Get it onto this machine before finalising A2.**
It is also where `OrderRecordAccessLog` would live if it exists at all (D-H).
