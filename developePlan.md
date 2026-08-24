# Optionia for WooCommerce — Development Plan

**Document type:** Executable engineering plan (companion to `OptioniaStartRoadmap.md`)
**Status:** Authoritative build sequence
**Owner:** Omi Hasan / ParseLab LLC
**Created:** 2026-08-21

---

## How This Document Differs From The Roadmap

`OptioniaStartRoadmap.md` is the **master specification** — it defines *what* Optionia is
and *what* must exist. It is correct and remains the source of truth for scope.

This document is the **build sequence** — it defines *what order* to build in, *what
"done" means* at each step, and *which decisions block which work*.

Two deliberate departures from the roadmap's ordering, both justified in
[Appendix A](#appendix-a--why-the-sequence-changed):

1. **The core domain is built once, in NestJS — not twice.** The roadmap builds the
   option/pricing/rule engines inside the WordPress plugin (Phases 5–9), then rebuilds
   them in NestJS (Phases 10–20). This plan builds authoring in the cloud and keeps only
   *evaluation* in PHP.
2. **The architecture is proven end-to-end before it is widened.** A single option type
   travels dashboard → API → plugin → cart → order before option type #2 exists.

Scope is unchanged. Every roadmap phase is mapped in
[Appendix B](#appendix-b--roadmap-phase-mapping).

---

## Table of Contents

- [Part I — Ground Truth](#part-i--ground-truth)
  - [S0. Current State Of The Codebase](#s0-project-scope-and-starting-point)
  - [S1. Blocking Decisions](#s1-blocking-decisions)
  - [S2. Architecture Contract](#s2-architecture-contract)
  - [S3. Engineering Standards](#s3-engineering-standards)
  - [S4. MVP Scope — What Ships First](#s4-mvp-scope--what-ships-first)
- [Part II — Stage 0: Foundations](#part-ii--stage-0-foundations)
  - [Phase 1 — Foundations & Decisions](#phase-1--foundations--decisions)
- [Part III — Stage 1: Learn The Platform](#part-iii--stage-1-learn-the-platform)
  - [Phase 2 — WooCommerce Competence](#phase-2--woocommerce-competence)
  - [Phase 3 — Plugin Skeleton](#phase-3--plugin-skeleton)
  - [Phase 4 — Throwaway Prototype](#phase-4--throwaway-prototype)
- [Part IV — Stage 2: The Vertical Slice](#part-iv--stage-2-the-vertical-slice)
  - [Phase 5 — Data Model & Migrations](#phase-5--data-model--migrations)
  - [Phase 6 — Tenancy & Auth](#phase-6--tenancy--auth)
  - [Phase 7 — Option Authoring API](#phase-7--option-authoring-api)
  - [Phase 8 — Store Connection](#phase-8--store-connection)
  - [Phase 9 — Config Sync & Cache](#phase-9--config-sync--cache)
  - [Phase 10 — Storefront Renderer](#phase-10--storefront-renderer)
  - [Phase 11 — Pricing Engine](#phase-11--pricing-engine)
  - [Phase 12 — Cart, Checkout, Order](#phase-12--cart-checkout-order)
  - [Phase 13 — Minimum Builder UI](#phase-13--minimum-builder-ui)
  - [🚩 GATE 1 — Architecture Proven](#-gate-1--architecture-proven)
- [Part V — Stage 3: Widen The Product](#part-v--stage-3-widen-the-product)
  - [Phase 14 — Option Type Library](#phase-14--option-type-library)
  - [Phase 15 — File Upload Subsystem](#phase-15--file-upload-subsystem)
  - [Phase 16 — Advanced Pricing](#phase-16--advanced-pricing)
  - [Phase 17 — Conditional Logic Engine](#phase-17--conditional-logic-engine)
  - [Phase 18 — Option Groups & Ordering](#phase-18--option-groups--ordering)
  - [Phase 19 — Product Sync & Assignment](#phase-19--product-sync--assignment)
  - [Phase 20 — Full Builder UI](#phase-20--full-builder-ui)
  - [Phase 20b — Onboarding & Activation](#phase-20b--onboarding--activation)
  - [Phase 21 — Live Preview](#phase-21--live-preview)
  - [🚩 GATE 2 — Feature Complete](#-gate-2--feature-complete)
- [Part VI — Stage 4: Become A Business](#part-vi--stage-4-become-a-business)
  - [Phase 22 — Billing Integration](#phase-22--billing-integration)
  - [Phase 23 — Billing Webhooks](#phase-23--billing-webhooks)
  - [Phase 24 — Plan Limits & Enforcement](#phase-24--plan-limits--enforcement)
  - [Phase 25 — Analytics](#phase-25--analytics)
  - [Phase 26 — Super Admin](#phase-26--super-admin)
  - [Phase 26b — Data Protection & Compliance](#phase-26b--data-protection--compliance)
- [Part VII — Stage 5: Production Hardening](#part-vii--stage-5-production-hardening)
  - [Phase 27 — Security Audit](#phase-27--security-audit)
  - [Phase 28 — Performance](#phase-28--performance)
  - [Phase 29 — Compatibility Matrix](#phase-29--compatibility-matrix)
  - [Phase 30 — Test Suite](#phase-30--test-suite)
  - [Phase 31 — Monitoring](#phase-31--monitoring)
  - [Phase 32 — Documentation](#phase-32--documentation)
  - [🚩 GATE 3 — Launch Ready](#-gate-3--launch-ready)
- [Part VIII — Stage 6: Launch](#part-viii--stage-6-launch)
  - [Phase 33 — Closed Beta](#phase-33--closed-beta)
  - [Phase 34 — Production Deploy](#phase-34--production-deploy)
  - [Phase 35 — Plugin Distribution](#phase-35--plugin-distribution)
- [Appendices](#appendix-a--why-the-sequence-changed)

---
---

# Part I — Ground Truth

## S0. Project Scope And Starting Point

### This is a standalone, greenfield project

> **Optionia WooCommerce is a separate project. It starts from zero.**
>
> Other directories under `parselabllc/` share the name "optionia" but are a **different
> product**. Nothing in this project touches, reuses, imports from, extends, migrates, or
> depends on them. They are out of scope entirely and are not referenced anywhere else in
> this plan.

New repositories, new database, new infrastructure, new codebase. There is no legacy to
port, no existing schema to inherit, and no prior implementation to extract business logic
from. Every design decision in this plan is made fresh on its merits.

### What exists today

```text
optionia woocommerce/
├── OptioniaStartRoadmap.md                          (spec — scope reference)
├── OptioniaWooCommerceDeveloperMasterMilestone.md   (spec — scope reference)
└── developePlan.md                                  (this file — build sequence)
```

Three documents. **No code yet.** The local WordPress + WooCommerce development
environment is set up and working (see [Phase 2](#phase-2--woocommerce-competence)), which
is the only completed work.

### The three repositories to be created

```text
optioniaWooCommerceBackend    NestJS · TypeScript · MySQL   — the SaaS core
optioniaWooCommerceFrontend   Next.js · TypeScript           — merchant + super admin UI
optioniaWooCommercePlugin     PHP · JavaScript               — the WordPress/WooCommerce plugin
```

Later, when the trigger conditions in [M34.1](#m341--infrastructure-topology) are met:

```text
optioniaWooCommerceWorker     queue consumer for webhooks, sync, analytics rollups
optioniaWooCommerceDocs       optional; docs can live in-repo until they don't
```

All three start empty. `optioniaWooCommerceBackend` is scaffolded in
[M5.1](#m51--bootstrap-optioniawoocommercebackend), the plugin in
[M3.1](#m31--repo-and-plugin-scaffold), the dashboard in
[M13.1](#m131--dashboard-bootstrap).

### What the product is

A multi-tenant SaaS that lets WooCommerce merchants build advanced product options —
option sets, conditional logic, priced add-ons — in a hosted dashboard, and renders them on
their live product pages through a WordPress plugin, carrying the customer's selections
through cart → checkout → order with a server-authoritative price.

```text
Custom T-Shirt — base $50
  Print: Front (+$10)
  Gift wrap: Yes (+$5)
  → Order total $65, and the merchant sees "Print=Front, Gift wrap=Yes" on the order
```

The merchant pays Optionia a recurring subscription. The merchant's **customer** pays the
merchant through the merchant's own WooCommerce checkout and payment gateway — Optionia
never touches that money ([AC6](#ac6--woocommerce-owns-the-transaction)).

### Why this product exists

**Variants are not options.** E-commerce platforms model product choice as pre-enumerated
SKU variants. That works for Size × Color. It collapses for customization:

- 4 options × 5 values = 625 combinations — unmanageable as variants
- A free-text engraving field has infinite variants — not representable at all
- A customer-uploaded image is not a variant in any sense
- Variants force inventory rows for combinations that aren't distinct inventory

That gap between "what the platform models" and "what merchants selling personalized goods
need to sell" is structural and permanent. It is a proven app-category on other platforms,
and on WooCommerce the incumbents are self-hosted one-time-purchase plugins — which is both
the opportunity and the central commercial risk
([D3](#d3--positioning-against-one-time-purchase-competitors)).

### Who the customer is

Merchants whose product *is* customization — high average order value, moderate volume,
which is favourable early-stage economics:

| Segment | What they need |
|---|---|
| Print-on-demand / apparel | Print placement, custom text, uploaded artwork |
| Jewelry / engraving | Free-text engraving, font choice, per-character pricing |
| Furniture / made-to-order | Material, dimensions, finish; percentage pricing |
| Gifts / hampers | Gift wrap, message cards, bundle builders |
| Signage / promotional | Dimensions, quantity tiers, file upload |
| Food / cakes / florists | Date and time pickers, messages, tiered structures |

## S1. Blocking Decisions

Three decisions gate real work. Each has a recommendation, the reasoning, and the phase
that cannot start until it is resolved.

Because this is a greenfield project ([S0](#s0-project-scope-and-starting-point)), the
stack decisions are settled rather than contested — there is no legacy codebase pulling in
another direction:

```text
optioniaWooCommerceBackend    NestJS 11 · TypeScript · TypeORM · MySQL
optioniaWooCommerceFrontend   Next.js (App Router) · TypeScript · Tailwind
                              shadcn/ui · TanStack Query · React Hook Form · Zod
optioniaWooCommercePlugin     PHP 7.4+ · WordPress Plugin API · vanilla ES6 · PHPUnit
optioniaWooCommerceWorker     NestJS standalone (added at M34.1 trigger)
```

The backend and frontend are **separate services**, and the backend owns the only
database. That is [AC1](#ac1--optionia-cloud-is-the-source-of-truth-the-plugin-is-a-projection),
not a decision to weigh.

### D1 — Billing provider

**Blocks:** [Phase 22](#phase-22--billing-integration). **Decide in
[Phase 1](#phase-1--foundations--decisions)**, not at Phase 22 — it affects entity
structure, tax obligations, company setup, and the pricing page.

| Provider | Merchant of record | Notes |
|---|---|---|
| **Stripe Billing** | You | Lowest fees, best API and webhooks. **Requires a supported country of incorporation.** You handle EU VAT and US sales tax yourself. |
| **Paddle** | Paddle | Handles global VAT/sales tax, invoicing, and refunds. Higher effective rate. |
| **Lemon Squeezy** | Lemon Squeezy | Simplest onboarding, tax handled. Now Stripe-owned. |

**Recommendation: Paddle or Lemon Squeezy**, unless the operating company is incorporated
somewhere with working Stripe access — then Stripe.

Reasoning: the buyers are global WooCommerce merchants. Merchant-of-record means no tax
logic to build, no VAT returns to file, and no tax integration blocking launch. The extra
percentage is cheap against that, especially for a small team.

**Action:** confirm the operating company's jurisdiction and Stripe eligibility. Whatever
is chosen, [M22.2](#m222--billingprovider-abstraction) puts it behind a `BillingProvider`
interface so the decision stays reversible.

### D2 — Free tier shape

**Blocks:** [Phase 22](#phase-22--billing-integration) pricing,
[Phase 33](#phase-33--closed-beta) recruiting.

Tied directly to [D3](#d3--positioning-against-one-time-purchase-competitors): WooCommerce
merchants must trust a cloud dependency on their storefront *before* they will pay monthly
for it. A crippled free tier fails to earn that trust; an over-generous one has no upgrade
path.

**Recommendation:** free tier limited by **scale, not capability** — the full option types
and conditional logic of the MVP, capped at a small number of option sets and assigned
products (see [S4](#s4-mvp-scope--what-ships-first)). A merchant should be able to run one
real product line on the free tier indefinitely and hit the wall only by succeeding.

Reasoning: capability-gating teaches merchants the product is limited. Scale-gating teaches
them it works and they've outgrown it. The second converts.

### D3 — Positioning against one-time-purchase competitors

**Blocks:** [Phase 22](#phase-22--billing-integration) pricing,
[Phase 33](#phase-33--closed-beta) recruiting. Not an engineering decision, but it
determines whether the product sells at all.

**The problem.** WooCommerce's established options plugins — Extra Product Options
(THEMECOMPLETE), WooCommerce Product Add-Ons, YITH Product Add-Ons, PPOM — are **one-time
or annual license, roughly $50–$100, fully self-hosted**. WooCommerce merchants often chose
WooCommerce precisely to avoid recurring platform fees and to own their data and stack.
This product asks that audience for a monthly subscription **and** a cloud dependency in
front of their storefront.

That is swimming upstream on both price model and trust. It is survivable, but only with a
deliberate answer.

Candidate differentiators that genuinely justify recurring pricing:

1. **Multi-store management** — one dashboard, many stores, config copied between them. A
   self-hosted plugin structurally cannot do this.
2. **Analytics** — option-level revenue attribution. Requires a cloud to compute; plugins
   have nowhere to do it.
3. **Builder quality** — a materially better authoring experience than a WordPress admin
   settings screen.
4. **Hosted file storage** — customer uploads off the merchant's server and disk.
5. **Thin plugin, no update roulette** — logic lives in the cloud, so a plugin update is
   low-risk. This is a real fear in the WordPress market.
6. **Support with an actual SLA.**

**Required before launch:** a written, tested answer to *"why pay you monthly when EPO is
$59 once?"* — validated against real merchants in
[M33.7](#phase-33--closed-beta), including at least one current competitor user.

**Mitigation built into the architecture:** [AC3](#ac3--the-product-page-never-blocks-on-optionia)
(storefront never depends on a live API call) and
[M24.3](#m243--the-lapse-policy--decide-before-production) (a lapsed subscription never
breaks a live storefront) exist substantially to defuse the trust half of this objection.
They are not incidental engineering choices — they are the commercial answer expressed in
code.

---

## S2. Architecture Contract

Non-negotiable invariants. Any PR violating one of these is rejected regardless of
whether it works.

### AC1 — Optionia Cloud is the source of truth; the plugin is a projection

```text
        ┌─────────────────── OPTIONIA CLOUD ────────────────────┐
        │                                                        │
        │   Next.js Merchant Dashboard      Super Admin          │
        │            │                          │               │
        │            └────────────┬─────────────┘               │
        │                         ▼                              │
        │           NestJS — optioniaWooCommerceBackend           │
        │              (authoring · tenancy · billing)           │
        │                         │                              │
        │                    ┌────┴────┐                         │
        │                  MySQL    Billing provider             │
        └─────────────────────────┬──────────────────────────────┘
                                  │  signed config pull (HTTPS)
                                  ▼
                    ┌── OPTIONIA WOOCOMMERCE PLUGIN ──┐
                    │   config cache (wp_options)      │
                    │   renderer (PHP + JS)            │
                    │   pricing evaluator (PHP)        │◄── trusted price
                    │   cart/order integration         │
                    └────────────────┬─────────────────┘
                                     ▼
                       WooCommerce cart → checkout → order
                                     ▼
                                 Customer
```

**Authoring** happens only in the cloud. **Evaluation** happens only in the plugin.
Config flows one way: cloud → plugin. Events flow the other: plugin → cloud (analytics,
order facts).

### AC2 — The plugin evaluates; it never authors

The plugin has **no** option-creation UI, no rule-authoring UI, no pricing-configuration
UI. It receives a versioned config document and executes it. This is the operational form
of roadmap Rule 12 and the guard against building the domain twice.

**PHP contains exactly three pieces of engine logic**, each a pure function of
`(config, selection)`:

1. Rule evaluator — which options are visible/required given current selections
2. Pricing evaluator — the trusted price delta
3. Validator — is this selection set legal

These are **ports of cloud logic with identical semantics**, covered by a shared
cross-language fixture suite ([Phase 11](#phase-11--pricing-engine), M11.4).

### AC3 — The product page never blocks on Optionia

A customer page load must **never** make a synchronous call to `optioniaWooCommerceBackend`. Config is
cached locally in WordPress and refreshed out-of-band.

**If Optionia Cloud is entirely offline, merchant storefronts keep working** on the last
known-good config. This is both a performance requirement and the answer to the
merchant's central objection in [D5](#d3--positioning-against-one-time-purchase-competitors).

### AC4 — Price is server-authoritative, always

The browser is an untrusted input device. It may send **selection identifiers only** —
never prices, never labels, never computed totals. The plugin recomputes every price in
PHP from cached config at `add_to_cart` and re-validates at checkout.

Threat: a client-trusted `+$10` becomes `curl … price=0.01` and every customer gets
arbitrary discounts on the merchant's store. This is the #1 vulnerability class in this
product category.

### AC5 — Tenant isolation is enforced at the data-access layer

Not in controllers. Not by convention. Every tenant-scoped query goes through a repository
helper that requires a tenant context, so a forgotten `WHERE tenant_id = ?` is a
compile/runtime error rather than a cross-merchant data breach.

Ownership chain:

```text
User ──< TenantMember >── Tenant ──< Store ──< OptionSet ──< OptionGroup ──< Option ──< OptionValue
```

### AC6 — WooCommerce owns the transaction

Optionia does not replace the cart, the checkout, the order system, or the payment
gateway. It *decorates* them.

Reasoning: intercepting checkout means inheriting every tax, shipping, currency,
subscription-plugin, and gateway edge case in the WordPress ecosystem — thousands of
plugin combinations, each a support ticket. Riding WooCommerce's rails means riding their
compatibility work.

### AC7 — Both theme worlds are first-class

WooCommerce is mid-migration from PHP templates to Cart & Checkout **Blocks** (React +
Store API). Supporting only the classic hook path (`woocommerce_before_add_to_cart_button`)
ships a plugin that works on legacy themes and silently breaks on modern ones.

**Verified 2026-08-21 (M2.8): block cart and checkout are the DEFAULT on a fresh WC 11.0.1
install, even under a classic theme.** This is not future-proofing for an edge case — the
block path is the primary path most merchants will be on. Theme choice and cart
implementation are independent axes.

Both integration paths are designed in [Phase 10](#phase-10--storefront-renderer) and
[Phase 12](#phase-12--cart-checkout-order) — **not discovered in Phase 29**.

### AC8 — No SaaS secret ever ships inside the plugin

The plugin runs on infrastructure you do not control and its source is readable by anyone
who installs it. It holds only a **per-store credential**, scoped to that store,
revocable, and useless for reading any other tenant's data.

Every plugin installation is treated as potentially hostile. Authorization is enforced at
the API boundary, never assumed from the caller.

---

## S3. Engineering Standards

### Definition of Done

A milestone is complete when **all** of the following hold. Per roadmap §39: *a milestone
is not complete just because Claude says it is complete.*

```text
[ ] Code implemented and follows existing repo conventions
[ ] Application builds and boots with no new warnings
[ ] Lint passes (ESLint for TS, PHPCS WordPress-Extra for PHP)
[ ] Type check passes with no new `any` or suppression comments
[ ] Feature manually exercised against the acceptance criteria
[ ] Automated tests written and passing
[ ] Security items for this milestone addressed (see phase checklist)
[ ] Tenant isolation verified where tenant data is touched
[ ] No regression in previously completed milestones
[ ] Migration written and reversible (if schema changed)
[ ] Docs updated (if architecture or API surface changed)
[ ] Conventional-commit created on a feature branch
```

### Coding conventions (match the existing codebase)

#### Shared engineering principles (all three codebases)

Applied identically in PHP, NestJS, and Next.js. The full plugin-side elaboration is
[M3.0](#m30--engineering-foundation-the-reusable-component-contract); the same seven
principles govern the other two.

| # | Principle | What it prevents |
|---|---|---|
| 1 | **Layered, one-way dependencies** — integration → domain → infrastructure | Business logic entangled with framework code; untestable cores |
| 2 | **One canonical owner per concern** | Three subtly different money formatters |
| 3 | **Registries over conditionals** — extend by registering, never by editing a switch | Adding type #12 touching thirty files |
| 4 | **Presentation takes a view-model** — no data fetching in the render layer | Templates and components that cannot be tested or reused |
| 5 | **Shared vocabulary, not magic strings** | A renamed meta key silently breaking three files |
| 6 | **Cross-language logic stays pure** | PHP and TS pricing drifting apart |
| 7 | **Loud in dev, safe in prod** | A white-screened merchant storefront |

**The reuse test, applied to every codebase:** if the same concept is expressed in two
places, one of them is wrong. Before writing a helper, find its existing owner.

**NestJS (`optioniaWooCommerceBackend`)**
- Module-per-domain: `<domain>/{entities,dto,<domain>.controller.ts,.service.ts,.module.ts}`
- Global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true` — every
  endpoint has an explicit DTO; unknown fields are rejected, not ignored
- Global `ApiResponseInterceptor` envelope — do not hand-roll response shapes
- `TypeOrmExceptionFilter` for DB errors
- `synchronize: false` **always**. Schema changes only via `npm run migration:generate`
- Guards compose: `JwtAuthGuard` → `TenantGuard` → `RolesGuard`/`PermissionGuard`
- Money as **`BIGINT` minor units** in MySQL, columns named `*_minor`. Never a JS float,
  and never `DECIMAL`.

  ⚠️ **Superseded guidance.** An earlier draft specified `DECIMAL(12,4)`. Step 2 rejected
  it: integer minor units are already the representation in the plugin's `Support\Money`,
  on the wire in the config document (`"amount": 1000`), and in the backend's money kernel.
  `DECIMAL` would make the database the only place a conversion happens, and conversions
  are where rounding bugs live — in a pricing engine that is a customer charged the wrong
  amount on a merchant's store. `DECIMAL(12,4)` also assumes a scale the product does not
  hold: four places suits USD, is wrong for JPY (zero) and merely tolerable for KWD
  (three). Full reasoning in ADR-013.

**WordPress plugin (`optioniaWooCommercePlugin`)**
- WordPress Coding Standards, enforced by PHPCS + `WordPress-Extra` + `WordPress-Docs`
- Prefix everything `optionia_` / `Optionia_`; namespace `Optionia\`
- Every input `sanitize_*`, every output `esc_*`, every admin write nonce-verified,
  every admin action capability-checked
- `$wpdb->prepare()` for all SQL — no exceptions
- Fail gracefully without WooCommerce; never a fatal error on a merchant's store

- **Shared kernel** in `common/`: `Money` (integer minor units, the only money type),
  `Result`, tenancy context, base DTOs, pagination, error codes. Domain modules import from
  it; it imports from nothing.
- **The type registry lives in `options/types/`** and mirrors the plugin's registry
  one-for-one — same keys, same three axes
  ([M5.4b](#m54b--type-model-kind-cardinality-and-presentation-as-separate-axes)). Two
  registries that can disagree is a bug generator; the shared fixture suite
  ([M11.4](#m114--cross-language-fixture-suite)) is what keeps them honest.
- **Evaluators are pure** — `pricing/`, `rules/`, and validation take plain objects and
  return plain objects. No repository access, no request context. This is what makes them
  runnable against the same fixtures as the PHP ports.
- Every endpoint: DTO in, DTO out. Entities never cross the controller boundary.

**Next.js merchant dashboard**
- App Router, Server Components by default
- TanStack Query for server state; React Hook Form + Zod for forms
- Zod schemas mirror API DTOs and are the single validation definition
- shadcn/ui primitives; no second component library

**Component organisation — the builder is the reuse test.** The option builder
([Phase 20](#phase-20--full-builder-ui)) renders an editor for every option type. Written as
a switch over twelve types it becomes unmaintainable; written as a registry it stays small.

```text
components/
├── ui/                      shadcn primitives — never edited directly
├── forms/                   Field wrappers: label · help · error · required
│                            ONE implementation, used by every editor
├── builder/
│   ├── OptionEditor.tsx     dispatches via the registry, contains no per-type logic
│   ├── editors/             one component per option type
│   ├── ValueListEditor.tsx  shared by every choice-type editor
│   ├── PricingEditor.tsx    shared by every priceable type
│   └── RuleBuilder.tsx
├── preview/                 renders from the SAME view-model shape as the storefront
└── layout/
```

`forms/` and the three shared builder editors are where the leverage is: `ValueListEditor`
and `PricingEditor` are written once and composed by every type that needs them. A type's
own editor should be a thin composition, not a re-implementation.

**Preview shares semantics with the storefront** ([Phase 21](#phase-21--live-preview)) — it
consumes the same evaluators and the same view-model shape, so it cannot drift from what
customers see.

### Git strategy

```text
main       ← production, tagged releases only
develop    ← integration
feature/*  ← one branch per milestone
fix/*
```

Commit format: `type(scope): subject` — e.g. `feat(api): add tenant module`,
`feat(plugin): persist option data in cart`, `fix(pricing): correct percentage rounding`.

One meaningful commit per milestone minimum. Every phase ends on a `develop` merge with
a green test suite.

### Working rules for AI-assisted development

Carried forward from roadmap §5 and §36:

1. Never build a whole phase in one prompt. One milestone at a time.
2. Inspect the repo before changing it.
3. Never modify unrelated files.
4. Explain architectural changes before implementing them.
5. Migrations always; `synchronize: true` never.
6. Never trust browser-supplied prices, IDs, or permissions.
7. Enforce tenant isolation on every resource.
8. Never put SaaS secrets in the plugin.
9. Test every milestone before moving on.
10. Prefer small reversible changes over rewrites.

---

## S4. MVP Scope — What Ships First

The phase list describes the **complete** product. It is not the launch scope. Without an
explicit line between them, every phase silently becomes launch-blocking and the product
never ships.

### The MVP line

**In scope for first paid launch:**

```text
✓ Merchant account, email verification, login
✓ Single tenant per merchant (teams built into the schema, UI later)
✓ WooCommerce plugin: install, connect, sync, render
✓ Store connection with the full state machine
✓ Product catalogue sync + assignment
✓ Option sets and groups
✓ Tier-1 option types only (8):
     text · textarea · radio · checkbox · select · number · color · image-swatch
✓ Fixed and percentage pricing
✓ Basic conditional logic (show/hide/require, single-condition rules)
✓ Storefront rendering, classic AND block themes
✓ Server-authoritative pricing
✓ Cart, checkout, order metadata, admin order display
✓ Minimum viable builder UI
✓ Subscription billing: Free + one paid tier
✓ Plan limits enforced
✓ Multi-tenant isolation
✓ Monitoring, backups, error tracking
```

**Deliberately deferred past launch:**

```text
→ File upload (Phase 15)           — high value, high complexity; fast-follow #1
→ Tier-2/3 option types (Phase 14) — date, time, range, quantity, multi-file
→ Advanced pricing (Phase 16)      — per-unit, per-char, tiered, formula
→ Cascading/multi-condition rules  — beyond single-condition show/hide
→ Analytics (Phase 25)             — fast-follow #2; the key D5 differentiator
→ Live preview (Phase 21)          — builder is usable without it
→ Team management UI (M6.5)        — schema ready, UI deferred
→ Multi-store management           — schema ready; the D5 story needs it soon
→ Templates/presets (M20.7)        — strong onboarding lever, not blocking
→ Import/export option sets        — fast-follow
→ Super admin polish (Phase 26)    — ops queue needed; metrics can wait
```

### Why this line and not another

The MVP must prove exactly one thing: **a merchant can sell a customized product through
their own WooCommerce checkout and fulfil it from the order screen.** Everything required
for that sentence is in scope. Everything else, however valuable, is not.

Note that **file upload is deferred but is fast-follow #1**, not "someday" — print-on-demand
and signage are two of the best-fit segments ([S0](#s0-project-scope-and-starting-point)) and
they cannot buy without it. It is deferred because it is the single largest subsystem
([Phase 15](#phase-15--file-upload-subsystem)), not because it is optional. Launch to the
segments that do not need it; ship it within weeks.

Analytics is fast-follow #2 because it is the answer to
[D5](#d3--positioning-against-one-time-purchase-competitors) — a self-hosted plugin
cannot compute it. The longer it is missing, the weaker the recurring-pricing argument.

### Consequence for the pricing page

The plan cannot sell what the MVP does not have. Reconcile
([M1.6](#m16--feature-scope-and-mvp-line)) against **this** list, not against the
full phase list: the Business tier currently advertises "All Option Types (30+)",
"Multi-File Upload", "Editor for Image Uploads", and "Edit Options in Cart" — none of
which are in MVP scope. Either the tier ships later, or the copy changes.

### Gate mapping

```text
Gate 1  →  proves the architecture              (not shippable)
Gate 2  →  MVP feature-complete + fast-follows  (see split above)
Gate 3  →  MVP launch-ready                     (shippable)
```

Gate 2's checklist applies to **MVP scope**. Deferred items are tracked, not gating.

---
---

# Part II — Stage 0: Foundations

**Goal:** settle the decisions and set up the ground rules before any code exists. Cheap
now, expensive later.

---

## Phase 1 — Foundations & Decisions

**Depends on:** nothing — this is the start
**Blocks:** Phases 5 onward
**Resolves:** [D1](#d1--billing-provider)–[D3](#d3--positioning-against-one-time-purchase-competitors)

> There is no Phase 0. This is a greenfield project
> ([S0](#s0-project-scope-and-starting-point)) — nothing exists to remediate, migrate, or
> extract. Phase numbering starts here and runs to 35.

### M1.1 — Repository and tooling setup

Create the three repositories, each empty but correctly configured from the first commit:

```text
optioniaWooCommerceBackend    .gitignore · .env.example (PLACEHOLDERS ONLY) · README
                              ESLint + Prettier · tsconfig · CI workflow
optioniaWooCommerceFrontend   .gitignore · .env.example · README
                              ESLint + Prettier · tsconfig · CI workflow
optioniaWooCommercePlugin     .gitignore · README · composer.json
                              phpcs.xml.dist (WordPress-Extra) · CI workflow
```

Branch protection on `main` from day one: no direct pushes, CI must pass, `develop` is the
integration branch.

**Secrets hygiene, established before there is anything to leak:**

- `.env` in `.gitignore` in every repo, verified by an actual test commit
- `.env.example` contains **placeholder values only** — never a real credential, not even
  a development one
- **No hardcoded credential fallbacks anywhere.** Configuration reads from env and
  **throws on missing** rather than defaulting. A silent default is how a local process
  ends up talking to production.
- `NODE_ENV`-driven configuration; no `const isProduction = true` shortcuts
- A secret-scanning hook or CI job (`gitleaks` or equivalent) blocking commits that
  contain credential-shaped strings

**Acceptance:** three repos exist with green CI on an empty commit; secret scanning is
active and demonstrated to block a test credential; no repository can boot against
production by accident because no production defaults exist.

### M1.2 — Environment topology

Three environments defined up front, with genuinely separate credentials:

| Environment | Purpose | Database | WooCommerce |
|---|---|---|---|
| **local** | Development | Local MySQL | WordPress Studio / local site |
| **staging** | Integration + E2E | Separate managed DB | A real staging WooCommerce store |
| **production** | Live merchants | Managed DB, private network only | Merchant stores |

Credentials never shared between environments. Local development must be **incapable** of
reaching staging or production data.

**Deliverable:** `docs/ENVIRONMENTS.md`

### M1.3 — Decide D1: billing provider

Confirm the operating company's incorporation jurisdiction and Stripe eligibility. Choose
per [D1](#d1--billing-provider). Record the reasoning.

**Acceptance:** provider chosen, account opened or eligibility confirmed, tax obligations
understood.

### M1.4 — Decide D2 and D3: free tier and positioning

Write the positioning statement and the free-tier shape. This is a product decision, not a
formality — it determines the plan-limit numbers in
[M22.1](#m221--plan-definition) and how [Phase 33](#phase-33--closed-beta) merchants are
recruited.

**Deliverable:** `docs/POSITIONING.md` containing the written answer to *"why pay monthly
when a competitor is a one-time $59?"*

### M1.5 — Competitive teardown

Install the real competitors on a local WooCommerce site and use them properly: Extra
Product Options (THEMECOMPLETE), WooCommerce Product Add-Ons, YITH Product Add-Ons, PPOM.

For each, document: option types supported, pricing models, conditional-logic capability,
how selections appear in cart and order, admin UX quality, licence model, **and
specifically where it is weak.**

This is the single highest-value research task in the project. The weaknesses found here
are the product's opportunities, and the strengths are the baseline a merchant will
compare against on day one.

**Deliverable:** `docs/COMPETITIVE-ANALYSIS.md`

### M1.6 — Feature scope and MVP line

Using the competitive analysis, confirm or adjust the MVP scope in
[S4](#s4-mvp-scope--what-ships-first). Every feature marked in-scope must be defensible as
*required to sell a customized product end-to-end*; everything else is deferred with a
stated fast-follow order.

**Deliverable:** `docs/MVP-SCOPE.md` (or S4 amended in place, with the change recorded in
`docs/DECISIONS.md`)

### M1.7 — Decision log

Start `docs/DECISIONS.md` in ADR format — append-only. Every architectural decision from
here on gets an entry: the decision, the alternatives considered, the reasoning, the date.

Seed it with D1–D3 and the stack choices from [S1](#s1-blocking-decisions).

### Phase 1 exit criteria

```text
[ ] Three repositories created with CI green and branch protection on
[ ] Secret scanning active; no real credential in any repo, ever
[ ] No hardcoded config fallbacks; missing env throws
[ ] Three environments defined with separate credentials
[ ] D1 decided — billing provider, jurisdiction confirmed
[ ] D2 decided — free tier shape
[ ] D3 decided — positioning statement written
[ ] Competitive analysis complete, with weaknesses identified
[ ] MVP line confirmed
[ ] docs/DECISIONS.md started
```

---

# Part III — Stage 1: Learn The Platform

**Goal:** genuine WooCommerce competence and a plugin skeleton, before any SaaS work.
Cheap to do, expensive to skip.

---

## Phase 2 — WooCommerce Competence

**Depends on:** nothing — can start immediately
**Blocks:** Phase 3
**Note:** runs in parallel with [Phase 1](#phase-1--foundations--decisions). Learning
WooCommerce and settling decisions are independent tracks; do both at once.

> Roadmap Phase 1 (environment) is **complete**: WordPress Studio, local site, WooCommerce
> installed, MailPoet/SQLite issue solved, test store built.

### M2.1 — WordPress fundamentals

**Structure and environment:** the WordPress directory layout (`wp-content/plugins`,
`themes`, `uploads`, `mu-plugins`); `wp-config.php` and the constants that matter to a
plugin (`WP_DEBUG`, `WP_DEBUG_LOG`, `DISALLOW_FILE_MODS`, `WP_CONTENT_DIR`,
`WP_MEMORY_LIMIT`); the database schema (`wp_posts`, `wp_postmeta`, `wp_options`,
`wp_users`, `wp_usermeta`, `wp_terms`) and why `wp_postmeta` queries get slow.

**Plugin lifecycle:** how WordPress discovers a plugin; `plugins_loaded` → `init` →
`wp_loaded` → template; activation vs. deactivation vs. uninstall hooks; must-use plugins;
plugin load order and why you cannot assume WooCommerce is loaded yet.

**The Plugin API:** actions vs. filters, priority and argument count; `remove_action` and
why other plugins may remove yours; the Settings API (`register_setting`,
`add_settings_field`, `settings_fields`) and when to use it instead of hand-rolled admin
forms; shortcodes; the Transients API and why a transient is not a cache guarantee (it can
vanish at any time, and on some hosts is backed by an object cache that flushes).

**Data and security primitives:** post types, meta, taxonomies; users, roles, and
capabilities (`current_user_can`, and why `manage_options` is the wrong check for a shop
manager); nonces and what they do and do not protect against; the sanitize/escape
distinction (`sanitize_text_field` on input, `esc_html`/`esc_attr` on output — never the
reverse); `$wpdb` and `$wpdb->prepare()`; `dbDelta()` for custom tables.

**Scheduling:** WP-Cron, why it is request-triggered and therefore unreliable on
low-traffic sites, and how a real cron (`DISABLE_WP_CRON` + system cron) changes that.

**Acceptance:** can explain the full request lifecycle, where a plugin can safely
intervene, and why a transient must never be the only copy of important state.

### M2.2 — WooCommerce fundamentals

Product types — **simple, variable, grouped, external/affiliate** — and variations vs.
attributes; the cart lifecycle (session, cart item keys, cart item data); checkout and
order creation; order and order-item meta; the CRUD/data-store abstraction
(`WC_Product`, `WC_Order`); customers and the guest-vs-account distinction; coupons and
how a fixed-cart discount interacts with a modified line price; taxes (inclusive vs.
exclusive, and tax classes per line item); shipping and how a price change affects
weight/class-based rates; **payment gateways** — what a gateway sees of a line item, and
why Optionia must never modify a price after the gateway has been handed a total; HPOS
(High-Performance Order Storage) and what it changes about order meta.

**Acceptance:** can explain what happens to option data when an order moves to HPOS
storage, and why an option price change must land before totals are calculated rather
than after.

### M2.3 — Hands-on product experiments

Build a simple product, a variable product with two attributes and generated variations,
a grouped product, and an external product. Note where each breaks assumptions an
options plugin might make.

**Deliverable:** `docs/woocommerce-notes/product-types.md`

### M2.4 — Full order lifecycle trace

Walk product → cart → checkout → order → admin order, logging the hook sequence.

**Deliverable:** an annotated hook-sequence diagram in
`docs/woocommerce-notes/order-lifecycle.md`

### M2.5 — Integration point catalogue

Identify and document the exact hooks Optionia will need:

| Purpose | Classic hook |
|---|---|
| Render options | `woocommerce_before_add_to_cart_button` |
| Validate selection | `woocommerce_add_to_cart_validation` |
| Attach data to cart item | `woocommerce_add_cart_item_data` |
| Recompute price | `woocommerce_before_calculate_totals` |
| Display in cart | `woocommerce_get_item_data` |
| Persist to order | `woocommerce_checkout_create_order_line_item` |
| Admin order display | `woocommerce_after_order_itemmeta` |

**Deliverable:** `docs/woocommerce-notes/integration-points.md`

### M2.6 — API surfaces

WC REST API (auth via consumer key/secret, product endpoints, webhooks); WP REST API
(custom namespaces, permission callbacks); **Store API** (the block-checkout data layer,
and the extension mechanism `ExtendSchema` / `extend_data`).

**Acceptance:** can state which API each direction of sync uses and why.

### M2.7 — Webhooks

WooCommerce webhook delivery, payload shape, signature (`X-WC-Webhook-Signature`,
HMAC-SHA256 base64), retry behaviour, and failure modes. Register a `product.updated`
webhook to a local tunnel and observe it.

**Deliverable:** `docs/woocommerce-notes/webhooks.md`

### M2.7b — Throwaway practice plugin

Before [Phase 3](#phase-3--plugin-skeleton) builds the real skeleton, build a deliberately
crude plugin in a single file to confirm the mechanics are understood. Six steps, each
proving one thing:

1. Detect WooCommerce and bail safely if absent
2. Print text on a product page via a hook
3. Read the current product ID and its price
4. Attach arbitrary data to a cart item
5. Display that data in the cart
6. Save it to order meta and read it back on the admin order screen

This is **not** the Phase 4 prototype — that one uses real options and real pricing. This
is a 30-minute exercise to prove the hook signatures behave as documented before any
structure is committed to. Delete it afterwards.

**Acceptance:** all six steps work; the file is deleted.

### M2.8 — Block themes and the block cart/checkout

Install a block theme (Twenty Twenty-Five) and enable Cart & Checkout Blocks. Document
what breaks when a plugin only implements classic hooks. **This is the evidence base for
[AC7](#ac7--both-theme-worlds-are-first-class).**

**Deliverable:** `docs/woocommerce-notes/block-vs-classic.md`

### Phase 2 exit criteria

```text
[ ] Can explain product → cart item → order and where to intervene safely
[ ] Integration point catalogue complete for classic AND block paths
[ ] Store API extension mechanism understood
[ ] Webhook signature verification understood
[ ] All notes committed under docs/woocommerce-notes/
```

---

## Phase 3 — Plugin Skeleton

**Depends on:** Phase 2
**Blocks:** Phase 4
**Repo:** new — `optioniaWooCommercePlugin`

### M3.0 — Engineering foundation: the reusable-component contract

**Read this before writing a single file.** Phase 3 sets the structural precedent that
Phases 4–35 inherit. Every shortcut taken here is paid for thirty times over. The goal is
that adding option type #12 in Phase 14 touches **three files**, not thirty.

#### Principle 1 — Layers, with a strict dependency direction

```text
   ┌──────────────────────────────────────────────────────┐
   │  INTEGRATION   WooCommerce/WordPress hooks only.     │
   │                Thin. Translates WC → domain calls.   │
   │                Contains NO business logic.           │
   └───────────────────────────┬──────────────────────────┘
                               │ depends on ↓
   ┌───────────────────────────┴──────────────────────────┐
   │  DOMAIN        Engine (rules · pricing · validation) │
   │                Pure functions. No WordPress. No I/O. │
   │                Unit-testable without loading WP.     │
   └───────────────────────────┬──────────────────────────┘
                               │ depends on ↓
   ┌───────────────────────────┴──────────────────────────┐
   │  INFRASTRUCTURE  Api\Client · Config\Repository ·    │
   │                  Support\Logger · TokenStore         │
   └──────────────────────────────────────────────────────┘
```

**The rule: dependencies point downward only.** `Engine\` must never `use` a WordPress
function, and never reach into `Integration\`. If a pricing calculation needs
`get_option()`, the value is **passed in** — not fetched.

Why this is worth the discipline: it is what lets the pricing engine be unit-tested in
milliseconds without a WordPress bootstrap, and it is the difference between a test suite
you run on every save and one you never run.

#### Principle 2 — One canonical place for each concern

Before writing any helper, check whether the concern already has an owner. Duplication here
is how a codebase rots.

| Concern | The single owner | Never do this instead |
|---|---|---|
| Outbound HTTP | `Api\Client` | a stray `wp_remote_get()` |
| Money arithmetic | `Support\Money` | float maths, `number_format` |
| Reading cached config | `Config\Repository` | `get_option()` at a call site |
| Logging | `Support\Logger` | `error_log()`, `var_dump` |
| Option markup | `Frontend\Templates` + `templates/` | inline `echo '<div…'` |
| Input sanitising | `Support\Sanitize` | ad-hoc `sanitize_text_field` chains |
| Escaping on output | the template layer | `esc_html()` scattered in logic |
| Nonce + capability | `Admin\Request` guard | repeated inline checks |
| Cart item read/write | `Integration\CartItem` | direct `$cart_item['optionia']` access |

**Enforcement, not aspiration:** a CI grep asserts `wp_remote_` appears only in `src/Api/`,
and that no `float` cast appears in `src/Engine/`. A convention nobody checks is a
convention nobody keeps.

#### Principle 3 — The option type registry is the extensibility seam

This is the most important design decision in the plugin. Adding an option type must be
**registration, never modification**.

```text
Engine\Types\TypeRegistry            ← the only thing that knows the list
   ├── contracts/
   │     OptionType            interface: key, valueKind, cardinality
   │     Renderable            interface: render(config, value)
   │     Validatable           interface: validate(config, value): Result
   │     Priceable             interface: priceDelta(config, value, ctx): Money
   │     CartSerializable      interface: toCartData() / fromCartData()
   └── types/
         TextType · NumberType · ChoiceType · DateType · FileType …
```

**A type implements only the interfaces that apply to it.** A presentational item
([M5.4c](#m54c--presentational-items-are-not-options)) implements `Renderable` and nothing
else — so it is structurally incapable of reaching the pricing engine, rather than being
excluded by an `if`.

Test of success: **adding a type touches one new class, one registry line, one template
partial.** If it also requires editing the renderer, the validator, and the cart handler, the
abstraction has failed and must be fixed before type #3 — not after type #12.

Because cardinality is an axis
([M5.4b](#m54b--type-model-kind-cardinality-and-presentation-as-separate-axes)), `ChoiceType`
serves radio, dropdown, checkbox, colour swatch and image swatch — differing by
`presentation` (which template partial) and `cardinality` (one vs. many).

#### Principle 4 — Templates are data-in, markup-out

```text
templates/
├── option-group.php            wrapper: fieldset, legend, description
├── options/
│   ├── text.php   textarea.php   number.php   date.php
│   ├── choice-radio.php   choice-dropdown.php
│   ├── choice-checkbox.php   choice-swatch-color.php   choice-swatch-image.php
│   └── file.php
├── presentational/
│   └── heading.php   paragraph.php   divider.php
└── partials/
    ├── label.php   help-text.php   error.php
    ├── price-badge.php   char-counter.php
    └── required-marker.php
```

Two rules that make this a real component system rather than a folder of files:

1. **A template receives a prepared view-model array and nothing else.** No global lookups,
   no `Config\Repository` calls, no business logic. Everything it needs is already computed.
2. **Every template is theme-overridable** via `wc_get_template()` semantics, so a merchant's
   theme can supply `woocommerce/optionia/options/text.php`. This is the WordPress
   ecosystem's expectation and a genuine adoption lever for agencies.

`partials/` is where the reuse actually pays: the label, required marker, help text,
character counter and price badge are written **once** and composed by all twelve option
templates. Change the required-marker markup once, and every type updates.

#### Principle 5 — Shared vocabulary, not stringly-typed code

One place defines every string that crosses a boundary. Magic strings scattered across files
are the most common source of silent breakage in WordPress plugins.

```text
Support\Keys        meta keys, option names, transient keys, nonce actions
Support\Hooks       every hook name the plugin adds or exposes
Engine\Result       uniform { ok, value, errors[] } for validation and pricing
Support\Money       integer minor units — the ONLY money representation
```

`Support\Money` deserves emphasis: **no float ever represents money anywhere in the
codebase.** Construction from and conversion to WooCommerce's decimal format happens at the
boundary, once, in that class. This is the mechanism behind
[AC4](#ac4--price-is-server-authoritative-always) and the rounding correctness required by
[M11.4](#m114--cross-language-fixture-suite).

#### Principle 6 — Semantics shared with the cloud must be provably identical

`Engine\RuleEvaluator`, `Engine\PriceEvaluator`, and `Engine\SelectionValidator` are
**ports of TypeScript logic**. They are pure by design so the shared JSON fixture suite
([M11.4](#m114--cross-language-fixture-suite)) can execute against both languages in CI.

Practical consequence for Phase 3: these classes take **plain arrays in and plain values
out** — no `WC_Product`, no `WC_Cart`, no globals. That constraint is what makes the fixture
suite possible, and it is far cheaper to honour now than to retrofit.

#### Principle 7 — Fail loudly in development, safely in production

The plugin runs on stores you do not control. Two behaviours, one switch:

- **Development** (`WP_DEBUG`): invariant violations throw. A missing config key, a
  non-scalar cart value, an unregistered type — all loud.
- **Production**: the same conditions are logged, degraded, and **never fatal**. A broken
  option group renders nothing rather than white-screening a merchant's storefront.

`Support\Assert` centralises this so the choice is made once, not re-decided at each call
site.

#### Definition of structural done for Phase 3

```text
[ ] Engine/ has zero WordPress function calls (grep-verified in CI)
[ ] wp_remote_ appears only in src/Api/ (grep-verified in CI)
[ ] No float used for money anywhere (grep-verified in CI)
[ ] Every user-facing string is translatable with the optionia text domain
[ ] Every PHP file starts with the ABSPATH guard (PHPCS sniff)
[ ] PHPCS WordPress-Extra passes with zero errors
[ ] A new option type can be added by touching exactly 3 files — proven by doing it twice
[ ] Every template renders from a view-model with no global lookups
[ ] All templates theme-overridable and documented
```

### M3.1 — Repo and plugin scaffold

```text
optioniaWooCommercePlugin/
├── optionia.php                  # header, guards, bootstrap only
├── uninstall.php                 # data removal, gated on opt-in setting
├── composer.json                 # PSR-4 Optionia\, dev: phpcs, phpunit
├── phpcs.xml.dist                # WordPress-Extra + WordPress-Docs
├── readme.txt                    # WordPress.org format
├── CHANGELOG.md
├── src/
│   ├── Plugin.php                # singleton bootstrap, DI wiring
│   ├── Activation/
│   │   ├── Activator.php         # version checks, table creation
│   │   ├── Deactivator.php       # cron teardown, data preserved
│   │   └── Migrator.php          # schema upgrades between versions
│   ├── Admin/
│   │   ├── Menu.php              # Dashboard · Connection · Settings
│   │   ├── SettingsPage.php      # Settings API
│   │   ├── ConnectionPage.php
│   │   ├── SystemStatus.php      # support diagnostics (M3.6)
│   │   └── OrderMetaBox.php      # option display on admin order
│   ├── Api/
│   │   ├── Client.php            # THE only outbound HTTP (M3.5b)
│   │   ├── CircuitBreaker.php
│   │   └── ResponseValidator.php # schema-check before trusting a response
│   ├── Connection/
│   │   ├── Handshake.php         # PKCE-style flow (M8.1)
│   │   ├── StateMachine.php      # M8.1b
│   │   └── TokenStore.php        # hashed/scoped credential storage
│   ├── Config/
│   │   ├── Repository.php        # cache read/write
│   │   ├── Synchronizer.php      # pull, ETag, cron + manual
│   │   ├── ProductIndex.php      # product_id → option sets (M9.2)
│   │   └── SchemaVersion.php     # negotiation (M9.5)
│   ├── Engine/                   # AC2 — the ONLY business logic in PHP
│   │   ├── RuleEvaluator.php
│   │   ├── PriceEvaluator.php
│   │   └── SelectionValidator.php
│   ├── Frontend/
│   │   ├── Renderer.php          # classic template path
│   │   ├── Assets.php            # conditional enqueue
│   │   └── Templates.php         # overridable template loader
│   ├── Integration/
│   │   ├── ProductPage.php       # render hooks
│   │   ├── Cart.php              # cart item data + totals
│   │   ├── Checkout.php          # revalidation
│   │   ├── Order.php             # order meta persistence
│   │   ├── StoreApi.php          # block cart/checkout (AC7)
│   │   └── Webhooks.php          # inbound invalidation ping
│   ├── Upload/                   # Phase 15
│   └── Support/
│       ├── Logger.php            # wc_get_logger, token-redacting
│       ├── Money.php             # integer minor units, no floats
│       └── Cron.php
├── templates/                    # theme-overridable markup
│   ├── option-group.php
│   ├── options/                  # one partial per option type
│   └── cart-item-meta.php
├── assets/{js,css,images}/
├── languages/                    # .pot + translations (M29.8)
└── tests/{unit,integration}/
```

**Templates are theme-overridable** — a merchant's theme can supply
`woocommerce/optionia/option-group.php` and win, resolved via
`wc_get_template()` semantics. This is the WordPress ecosystem's expectation and a real
adoption lever for agencies.

**Every PHP file starts with a direct-access guard:**

```php
if ( ! defined( 'ABSPATH' ) ) { exit; }
```

Without it, a file is directly requestable over HTTP and any code with side effects
executes outside WordPress — a standard WordPress plugin vulnerability class.

**Acceptance:** plugin appears in WP Admin → Plugins as "Optionia"; activates with no
notices; PHPCS clean; every PHP file carries the ABSPATH guard (enforced by a PHPCS
sniff, not by review).

### M3.2 — Activation, deactivation, uninstall

Activation: version check (PHP ≥ 7.4, WP ≥ 6.0, WC ≥ 8.0), create custom tables via
`dbDelta()`, set `optionia_db_version`, schedule cron. Deactivation: clear cron, keep
data. Uninstall: full cleanup, gated on an explicit "delete my data" setting.

**Acceptance:** activate → deactivate → reactivate leaves no orphan state; uninstall with
the flag set removes all traces.

### M3.3 — WooCommerce dependency guard

If WooCommerce is missing or inactive: admin notice *"Optionia requires WooCommerce."*,
self-deactivate cleanly, **never** a fatal error. Handle WooCommerce being deactivated
while Optionia is active, and the load-order case (`woocommerce_loaded`).

**Acceptance:** with WooCommerce disabled, the site and WP Admin remain fully functional.

### M3.4 — Admin menu shell

```text
Optionia
├── Dashboard      (connection status, sync status, quick links)
└── Settings       (connection, cache controls, debug log toggle)
```

Capability-gated (`manage_woocommerce`), nonce-protected forms.

**Acceptance:** menu renders for shop managers, is invisible to subscribers.

### M3.5 — Asset pipeline

Conditional enqueueing — frontend assets **only** on product pages that actually have
options; admin assets only on Optionia screens. Versioned handles for cache busting.
Minified builds. No jQuery dependency in new frontend code.

**Acceptance:** a product page with no options loads **zero** Optionia bytes.

### M3.5b — Centralized API client

**One class owns every outbound HTTP call.** Scattering `wp_remote_get()` through the
plugin means auth, retry, and timeout behaviour drift per call site — and a single call
that forgets a timeout can hang a merchant's page render.

`Api\Client` responsibilities, in one place:

- Base URL from config (env-overridable for staging)
- `Authorization: Bearer` from the stored store token
- Standard headers: plugin version, WP version, WC version, PHP version, site URL
- **Hard timeouts** — connect 5s, total 10s. Never unbounded.
- Retry with exponential backoff and jitter, **only** on 429/5xx/network errors — never
  on a 4xx, which is a real answer
- `Retry-After` honoured on 429
- **Circuit breaker:** after N consecutive failures, stop calling for a cooling-off
  period and serve cache. Prevents a struggling API from being hammered by thousands of
  merchant sites simultaneously — and prevents each of those sites from wasting PHP
  workers on doomed requests
- TLS verification always on; never `sslverify => false`
- Structured error objects, never raw `WP_Error` leaking to UI
- Response size cap and JSON schema validation before use — a hostile or corrupted
  response must not reach the cache
- Request/response logging when debug mode is on, **with tokens redacted**

**Never called during a page render.** All calls originate from cron, admin actions, or
async requests ([AC3](#ac3--the-product-page-never-blocks-on-optionia)). This is enforced
by a guard that throws in debug mode if a request is attempted during a frontend render.

**Acceptance:** every outbound call routes through `Api\Client`; grep for
`wp_remote_` outside `src/Api/` returns nothing; the circuit breaker is unit-tested.

### M3.6 — Logging and diagnostics

⚠️ **Report WooCommerce "Coming Soon" mode.** Phase 4 lost time to a render test that
produced nothing and looked like a plugin failure; the cause was
`woocommerce_coming_soon = yes`, which serves a placeholder page instead of the product
template so **no WooCommerce product hooks fire at all**. A merchant reporting "options
don't appear" may simply have their store in this mode. Surface it in System Status and in
troubleshooting docs — it costs one line and prevents a whole class of support ticket.

A `Support\Logger` wrapping `wc_get_logger()`, off by default, with a Settings toggle.
A "System Status" panel reporting plugin version, WP/WC/PHP versions, connection state,
config version, last sync time, cache state.

**Acceptance:** support can diagnose a merchant install from the System Status panel
alone.

### Phase 3 exit criteria

```text
[ ] Plugin installs, activates, deactivates, uninstalls cleanly
[ ] Fails gracefully without WooCommerce
[ ] Admin shell with capability + nonce protection
[ ] Conditional asset loading verified
[ ] PHPCS (WordPress-Extra) passes with zero errors
[ ] System Status panel usable for support
```

---

## Phase 4 — Throwaway Prototype

**Depends on:** Phase 3
**Blocks:** Phase 10, Phase 12 (as knowledge, not as code)

> ⚠️ **This code is deliberately disposable.** Its purpose is to learn the WooCommerce
> data path with a hardcoded option, before a network, a cache, or a config schema is in
> play. It is deleted in Phase 10. Do not build it well; build it fast.

Target:

```text
Product $50 · Test Option: ○ Standard  ○ Premium +$10  ○ Luxury +$20
Customer picks Luxury → Cart: $50 + $20 = $70 → Order shows "Test Option: Luxury"
```

### M4.1 — Render a hardcoded option

Three radios, correctly escaped.

⚠️ **The render hook differs by product type** — verified in WC 11.0.1
([M2.5](#m25--integration-point-catalogue) Finding 4). `simple.php`, `grouped.php` and
`external.php` fire `woocommerce_before_add_to_cart_button` directly; **`variable.php`
does not**. It only reaches that hook via `variation-add-to-cart-button.php:15`, which
renders *inside* the variation form and only *after* a variation is chosen.

Test **both** a simple product (ID 20) and the variable product (ID 23). A probe that only
covers the simple case will pass while leaving Phase 10 with a broken assumption: on a
variable product, options would be absent on page load, appear once a variation is picked,
then be wiped or duplicated when the customer switches variation.

For the variable case, render at `woocommerce_after_variations_table` instead.

### M4.2 — Capture the selection

`$_POST` handling on add-to-cart, sanitized. Validate against the hardcoded set via
`woocommerce_add_to_cart_validation` — reject anything not in the whitelist.

### M4.3 — Compute the price server-side

Map selection → delta in PHP. **The browser sends only the selection key**, never a
price. First practical application of [AC4](#ac4--price-is-server-authoritative-always).

### M4.4 — Attach data to the cart item

`woocommerce_add_cart_item_data`. Understand cart item keys and why two different
selections must **not** merge into one line.

### M4.5 — Apply the price

`woocommerce_before_calculate_totals` (`class-wc-cart.php:1568`). Handle quantity changes
and the hook firing more than once per request — a non-idempotent price application
compounds, turning $50 into $70 and then $90 on the next recalculation.

**Measured in Phase 4: `before_calculate_totals` fired 5 times in a single request.**
The idempotent form below is what kept the total correct:

```php
// Recompute from the product's own base price every time.
$base  = Money::from_decimal( $product->get_regular_price() );
$total = $base->plus( Money::from_minor( $delta ) );
$product->set_price( $total->to_decimal_string() );
```

**Never read the current price and add to it.** That is the single most important
implementation detail found in Phase 4.

**On session restore** — corrected after testing. An earlier draft of this milestone
claimed `woocommerce_get_cart_item_from_session` was *required*, or the price would
silently revert on reload. Phase 4 disproved that. `WC_Cart_Session` merges the entire
stored cart item array back wholesale (`class-wc-cart-session.php:235`):

```php
$session_data = array_merge(
    $values,                     // ALL custom cart item data, including ours
    array( 'data' => $product )  // only the product object is replaced
);
```

Custom data therefore survives a reload with no filter at all. The *product object* is
re-fetched fresh — so a price set via `set_price()` is discarded — but
`before_calculate_totals` re-applies it on every load, which is what actually preserves
the total.

Register the filter anyway, but understand what it is for: **normalising, migrating or
validating stored cart data when the config schema version changes**
([Phase 9](#phase-9--config-sync--cache)). It is defensive, not load-bearing. Core emits
`wc_doing_it_wrong` if the callback returns an item without a valid `data` key.

**Acceptance:** the option price survives a page reload, a cart-page refresh, and a
quantity change — verified by observation, not assumption.

### M4.6 — Display in cart

`woocommerce_get_item_data`. Verify in both classic cart and the Cart **block**.

⚠️ **Corrected expectation.** An earlier draft said the block case "is expected to fail".
Verification in WC 11.0.1 ([M2.5](#m25--integration-point-catalogue) Finding 2) shows the
same filter serves **both** paths:

```text
includes/wc-template-functions.php:4538          → classic cart
src/StoreApi/Schemas/V1/CartItemSchema.php:170   → block cart
```

So block cart will most likely **work**, which is better than assumed. The real hazard is
narrower and far easier to ship unnoticed — the **scalar trap**:

```php
foreach ( $data as $data_value ) {
    if ( ! is_scalar( $data_value ) ) { continue 2; }  // drops the WHOLE element
}
```

A non-scalar value causes the entire item-data element to be **silently discarded in block
cart while rendering perfectly in classic cart**. No error, no warning.

**This milestone's real job is to prove that empirically:** deliberately pass an array
value, confirm it appears in classic cart and vanishes in block cart, then confirm a
joined scalar string works in both. That single observation is what
[M12.2](#m122--cart-display) is built on, and it is worth more than the "expected failure"
the draft predicted.

Note that this site's cart and checkout are **already block-based by default** under a
classic theme ([M2.8](#m28--block-themes-and-the-block-cartcheckout)), so the block path is
the primary one, not an edge case.

### M4.7 — Survive checkout, persist to order

`woocommerce_checkout_create_order_line_item` → order item meta. Confirm the value
survives with **HPOS both enabled and disabled**.

⚠️ **Prerequisite — run the sync before toggling.** On this environment HPOS is enabled
but **data sync is off**, so every existing order lives only in the HPOS table
(`wp_wc_orders`) and none in `wp_posts`. Toggling straight to legacy storage would show
empty orders and read as a plugin bug when nothing is wrong.

Correct sequence:

```text
1. enable sync            (woocommerce_custom_orders_table_data_sync_enabled)
2. wp wc cot sync         backfill existing orders into both stores
3. toggle to legacy       wp wc cot disable
4. place a second order   verify meta under legacy storage
5. toggle back            re-enable HPOS
```

Alternatively place a separate test order under each mode, which avoids the backfill
entirely. Either is acceptable; discovering the constraint mid-test is not.

### M4.8 — Show in admin order and fulfilment output

Selection legible on the admin order screen and in the customer's order-confirmation
email.

**Also check the printed output.** [M12.6b](#m126b--fulfilment-output) establishes that
merchants selling customized products fulfil from a **printed sheet at a workbench**, not
from a browser tab. WooCommerce renders order item meta into print views and most
PDF-invoice plugins automatically — but only when the meta keys are human-readable.
Machine-shaped keys (`_optionia_sel_a3f9`) render as noise or are hidden entirely.

Phase 4 is the cheapest possible place to see how a chosen key actually renders there, and
the finding directly shapes the meta-key strategy in
[M12.5](#m125--order-persistence). Check WooCommerce's own print view at minimum.

**Acceptance:** the selection is legible without truncation in the admin order screen, the
confirmation email, and the print view.

### Phase 4 exit criteria

```text
[x] End-to-end via a REAL checkout: order #31, created_via=store-api, 2 x (80+20) = 200.00
[x] Price survives page reload — mechanism is before_calculate_totals, NOT the session
    filter (M4.5 amendment was overstated and has been corrected)
[x] before_calculate_totals fire count measured: 5 per request; idempotent form required
[x] SIMPLE product: render, cart, price, order — all verified
[x] VARIABLE product end-to-end: Large+Premium 40.00, Small+Premium 30.00,
    Large+Luxury 50.00 — 3 distinct lines; variation id and option key both
    participate in the cart hash independently
[x] Quantity: add qty 3 = 300.00, update to qty 5 = 500.00 — multiplies, does not compound
[x] Invalid value rejected: POST probe_finish=HACKED left the cart empty
[x] Scalar trap proven empirically: classic 2 rows, block cart 1 — array silently dropped
[x] Verified with HPOS on and off (sync run first, then restored)
[x] Admin order screen loaded over HTTP: "Finish: Luxury" visible
[x] Print/email template rendered: full value, no truncation, no hidden key leaked
[x] Two different selections produce two cart lines; identical selections merge
[x] Adversarial pass: price injection, array type confusion, unknown value,
    negative quantity and absurd quantity all repelled — AC4 holds under attack
[x] Reorder path (the array call site) triggered — found it blocks reorders entirely
[x] Deleted-option scenario tested: checkout completed, proving M12.4 is load-bearing
[x] Findings written to docs/woocommerce-notes/prototype-findings.md
[x] Design impacts folded back into M3.6, M10.2, M11.7, M12.1, M12.2, M12.4, M12.5
[x] Probe kept OUTSIDE the plugin repository; scheduled for deletion in Phase 10
```

### Environment prerequisites discovered

Two settings blocked testing and would equally block a merchant:

| Symptom | Cause |
|---|---|
| Product page renders no options at all | `woocommerce_coming_soon = yes` serves a placeholder; **no product hooks fire** |
| Checkout returns HTTP 400 | No shipping method in the zone — *"this order requires a shipping option"* |

Both belong in [System Status](#m36--logging-and-diagnostics) and troubleshooting docs.

**Local environment changes made during Phase 4**, recorded so the drift is deliberate
rather than mysterious later:

| Setting | Was | Now | Why |
|---|---|---|---|
| `woocommerce_coming_soon` | `yes` | `no` | A placeholder page fires no product hooks; nothing could be tested |
| Shipping zone 0 methods | none | `free_shipping` | Checkout returns HTTP 400 without one |
| `woocommerce_custom_orders_table_data_sync_enabled` | `false` | `true` | Required before toggling HPOS, or orders exist in only one store. **Doubles order writes — revert if measuring write performance.** |

Test orders **#29, #31, #32** were left in place deliberately: they are the evidence
behind the findings above and useful fixtures for [Phase 12](#phase-12--cart-checkout-order).

### Probe location and disposal

```text
tools/phase4-probe/                     ← source of truth, versioned
~/Studio/.../plugins/optionia-phase4-probe/   ← the running copy
```

Kept **outside the plugin repository** so Phase 3's tree stays clean, but **inside this
repository** so it survives a Studio site rebuild. The running copy lives in a disposable
WordPress install; the tracked copy is what makes it recoverable.

Deactivated but not deleted, because [Phase 10](#phase-10--storefront-renderer) benefits
from re-running it while building the real renderer — comparing a known-good hook trace
against new code is faster than reasoning about why options fail to appear.

`tools/phase4-probe/README.md` records how to run it, the two environment settings that
silently prevent testing, and the hardcoded product ids.

**Delete `tools/phase4-probe/` at the end of Phase 10.**

### Phase 4 result

Eight design rules were earned by observation rather than assumption, and **three
assumptions were proven wrong and corrected**:

1. The session-restore hook is defensive, not load-bearing — `before_calculate_totals` is
   what actually preserves the price.
2. **A leading underscore does not hide order meta from the admin screen.** That needs
   `woocommerce_hidden_order_itemmeta`, and the payload renders as an *editable field*, so
   it must be treated as untrusted on read.
3. **Checkout does not re-validate selections against config.** A deleted option completed
   an order for $100 — proving [M12.4](#m124--checkout-integrity) prevents a real failure
   rather than a hypothetical one.
4. **Type-checking the reorder path is not enough.** The array signature signals that the
   *data source* changed too: reorder carries the selection in order item meta, not
   `$_POST`. A validator reading only `$_POST` blocks the whole reorder
   ([M12.8](#m128--refunds-edits-and-edge-cases)).

Each was found by challenging something already marked complete. The first recheck found
six criteria passed on partial evidence; the adversarial round found the third; and a
final audit noticed that the reorder path had defensive code written for it but had never
actually been triggered — which produced the fourth.

Full detail in [docs/woocommerce-notes/prototype-findings.md](docs/woocommerce-notes/prototype-findings.md).

### Scope discipline

The probe is a **diagnostic instrument, not an implementation**. It must not touch
`Api\Client`, `Config\Repository`, `Engine\`, the type registry, admin UI, or templates —
introducing a network, a cache, or a config schema defeats the purpose of isolating the
WooCommerce data path.

One exception: use `Support\Money`. Computing prices with floats even in throwaway code
teaches the wrong reflex and produces numbers that cannot be compared against
[M11.4](#m114--cross-language-fixture-suite)'s fixtures.

**The probe lives outside the plugin repository**, as a standalone file in the local
WordPress install. Phase 3's tree stays clean and its gates stay green; a throwaway must
not leave fingerprints on code that is otherwise finished.

---
---

# Part IV — Stage 2: The Vertical Slice

**Goal:** one option type working end-to-end through the *real* architecture — cloud
authoring, signed sync, cached config, PHP evaluation, order persistence.

**This is the most important stage in the plan.** It is where the architecture is either
validated or corrected, at a point where correction is still cheap.

---

## Phase 5 — Data Model & Migrations

> **Sequencing note.** Phases 2–4 ran ahead of Phase 1 because they are
> WooCommerce-side work that needs no cloud decisions. Phase 5 is where that catches up:
> its **Step 0** executed [M1.1](#m11--repository-and-tooling-setup),
> [M1.2](#m12--environment-topology) and [M1.7](#m17--decision-log) — repository, CI,
> secret scanning, environment topology, and the decision log.
>
> [M1.3](#m13--decide-d1-billing-provider) and [M1.4](#m14--decide-d2-and-d3-free-tier-and-positioning)
> remain open: they need business input, not engineering judgement, and neither blocks the
> schema. `subscriptions.provider` is a string and plan limits are data, so either answer
> fits without migration. [M1.5](#m15--competitive-teardown) is deferred to before
> Phase 14 — see ADR-006.

**Depends on:** Phase 1 ([D1](#s0-project-scope-and-starting-point), [D3](#ac1--optionia-cloud-is-the-source-of-truth-the-plugin-is-a-projection))
**Blocks:** Phases 6–13
**Repo:** new — `optioniaWooCommerceBackend`

> This is original design work with no legacy schema to inherit. Spend real time on it —
> the data model is the hardest thing to change once merchant data exists in it. Use the
> competitive teardown ([M1.5](#m15--competitive-teardown)) as input: the option models
> those plugins expose are a decade of accumulated evidence about what merchants actually
> configure.

### M5.1 — Bootstrap `optioniaWooCommerceBackend`

New NestJS 11 project, from scratch, in the repository created at
[M1.1](#m11--repository-and-tooling-setup).

Fixed from the first commit: `synchronize: false`, **no hardcoded credential fallbacks**
(missing env throws), `NODE_ENV`-driven config, secrets env-injected only, migrations for
every schema change.

Bootstrap configuration:

- Global `ValidationPipe` — `whitelist: true`, `forbidNonWhitelisted: true`, `transform:
  true`. Every endpoint has an explicit DTO; unknown fields are **rejected**, not ignored,
  which closes mass-assignment as a class of bug
- Global response-envelope interceptor so no controller hand-rolls a response shape
- Global exception filter mapping TypeORM and domain errors to stable error codes
- CORS from an env allowlist — never `*`
- `/v1` route prefix with a written deprecation policy
- Structured JSON logging with a correlation ID propagated from the caller, so a plugin
  request can be traced through the API
- `GET /health` returning database connectivity and build version
- Helmet-equivalent security headers, and per-IP plus per-tenant rate limiting

Target module layout — created **incrementally per milestone**, not all at once:

```text
optioniaWooCommerceBackend/src/
├── main.ts                    # bootstrap, pipes, filters, CORS
├── app.module.ts
├── config/                    # typeorm + env config, NO hardcoded defaults
├── migrations/
├── common/
│   ├── interceptors/          # ApiResponseInterceptor
│   ├── filters/               # TypeOrmExceptionFilter
│   ├── decorators/            # @CurrentUser, @CurrentTenant
│   ├── guards/
│   ├── pipes/
│   ├── money/                 # integer minor units, shared with pricing
│   └── tenancy/               # AsyncLocalStorage context + scoped repository (M6.4)
├── auth/                      # Phase 6  — copied, then extended
├── users/                     # Phase 6
├── tenants/                   # Phase 6
├── members/                   # Phase 6  — team invites
├── stores/                    # Phase 8
├── connection/                # Phase 8  — handshake endpoints
├── store-api/                 # Phase 9  — store-token realm: config, heartbeat, events
├── option-sets/               # Phase 7
├── option-groups/             # Phase 7
├── options/                   # Phase 7  — includes the type registry
├── option-values/             # Phase 7
├── rules/                     # Phase 17
├── pricing/                   # Phase 11 — TS evaluator, shared fixtures
├── assignments/               # Phase 19
├── products/                  # Phase 19 — catalogue mirror
├── orders/                    # Phase 12 — order facts ingestion
├── plans/                     # Phase 22
├── subscriptions/             # Phase 22
├── billing/                   # Phase 22 — BillingProvider abstraction
├── usage/                     # Phase 24
├── webhooks/                  # Phases 19, 23 — inbound, signature-verified
├── analytics/                 # Phase 25
├── uploads/                   # Phase 15
├── admin/                     # Phase 26 — super admin, separate guard
└── audit/                     # Phase 6 onward
```

**Two guard realms, structurally separated:** `store-api/` is the only module accepting
store tokens; everything else accepts user JWTs. Enforced by module-level guards, not by
per-route decoration — see [M7.7](#m77--api-contract-written-before-implementation).

**Acceptance:** boots against its own dedicated database, `GET /health` green, zero
secrets in source, missing-env failure is loud and immediate.

### M5.2 — Tenancy core

```text
tenants           id, name, slug, status, plan_id, trial_ends_at, timestamps
users             id, email, password, email_verified_at, name, locale,
                  last_login_at, timestamps
tenant_members    id, tenant_id, user_id,
                  role ENUM(owner|admin|editor|viewer|billing),
                  invited_by, invited_at, accepted_at, revoked_at
tenant_invitations id, tenant_id, email, role, token_hash, invited_by,
                  expires_at, accepted_at, revoked_at
platform_staff    id, user_id,
                  role ENUM(super_admin|support|billing_ops|read_only),
                  granted_by, granted_at, revoked_at
impersonation_sessions id, staff_user_id, tenant_id, consented_at,
                  started_at, ends_at, ended_at, reason
```

`platform_staff` is a **separate table**, not a role value on `tenant_members`. Realm
separation is structural ([M6.5](#m65--roles-and-permission-matrix)): there is no row shape
that can express "merchant who is also super_admin", so no bug can create one.

`tenant_members` as a join table — not `user.tenant_id` — because agencies manage
multiple merchant tenants and that is a real early customer segment.

### M5.3 — Store connection model

```text
stores               id, tenant_id, platform(enum: woocommerce|shopify), name,
                     store_url, status, connected_at, last_seen_at, plugin_version,
                     wp_version, wc_version, config_version
store_credentials    id, store_id, token_hash, token_prefix, scopes,
                     last_used_at, revoked_at, expires_at
```

Tokens stored **hashed** (`token_prefix` retained for support identification only).
`platform` is an enum from day one. WooCommerce is the only value at launch, but modelling
it as an enum means a future second platform is a new adapter rather than a schema
migration across every table.

### M5.4 — Option domain model

```text
option_sets       id, tenant_id, store_id, name, status(draft|published|archived),
                  version, published_at
option_groups     id, option_set_id, label, description, display_type,
                  sort_order, is_collapsible
options           id, option_group_id, type, label, key, description, placeholder,
                  is_required, sort_order, default_value, validation(json),
                  pricing(json), display(json)
option_values     id, option_id, label, value_key, sort_order, price_config(json),
                  image_url, color_hex, sku_suffix, is_default
option_rules      id, option_set_id, target_type, target_id, action, conditions(json),
                  match_type(all|any), sort_order
```

Design notes:

- `options.key` is a **stable merchant-facing identifier**, immutable after publish, used
  in order meta so historic orders stay readable after a rename.
- `pricing`, `validation`, `display`, `conditions` are JSON columns — flexible per type,
  and each has a **versioned Zod schema** so it is validated, not free-form.
- `option_sets.version` increments on publish and drives cache invalidation
  ([Phase 9](#phase-9--config-sync--cache)).

### M5.4b — Type model: kind, cardinality, and presentation as separate axes

**Do not model option types as a flat enum.** The naive approach — one type per picker
entry — duplicates the renderer, validator, and pricing path for types that differ only in
how many values a customer may pick.

Three orthogonal axes instead:

```text
value_kind    none | text | number | date | file | choice
              ↑ what sort of value this option produces

cardinality   none | one | many
              ↑ how many values may be selected (choice types only)

presentation  text_field · textarea · number_field · date_picker · file_input
              radio · dropdown · checkbox · color_swatch · image_swatch · range
              ↑ how it is drawn — independent of the two above
```

So a single-select colour swatch and a multi-select colour swatch are **one type with a
different cardinality**, not two types. Same renderer, same validator, same pricing path,
written once. The picker UI can still present them as separate cards
([M20.3](#phase-20--full-builder-ui)) — the merchant's mental model and the storage model
do not have to match, and here they shouldn't.

**Cardinality drives everything downstream:** validation (`min_selections`/`max_selections`
only exist for `many`), pricing (a `many` option can contribute several deltas at once), and
cart data (scalar vs. array).

### M5.4c — Presentational items are not options

Headings, paragraphs, dividers, and rich-text blocks have **no value, no validation, no
pricing, and produce no cart or order data**. Modelling them as `Option` rows with
`value_kind: none` forces null-checks through the renderer, validator, pricing engine, cart
integration, and order persistence — five subsystems paying for one convenience.

Model the group's children as a discriminated union:

```text
option_group.items[]  →  ValueOption          (participates in everything)
                      →  PresentationalItem   (ordering + visibility only)

presentational_items  id, option_group_id, kind(heading|paragraph|divider|rich_text),
                      content(text|html), sort_order, display(json)
```

Presentational items participate in **exactly two** systems: ordering, and conditional
visibility (a rule may hide a heading). Nothing else can touch them — the pricing engine
never sees one.

**Why merchants need them:** a made-to-order product form with twelve options is unusable
without section headings and explanatory text. This is not decoration; it is what makes a
complex option set comprehensible to a customer.

**The `rich_text`/HTML variant is a security boundary.** It is merchant-authored markup
rendered on a **public storefront**, so it is an XSS vector by construction. Requirements:
a strict allowlist sanitizer server-side at publish time *and* on render, no `<script>`, no
event-handler attributes, no `<iframe>`, no inline `style` with `url()`. Consider gating it
to paid tiers — it is a support-and-liability surface, not just a feature.

### M5.5 — Assignment model

```text
option_set_assignments  id, option_set_id, mode(all|manual|conditional),
                        target_type(product|category|tag|attribute|price_range),
                        target_ref, match_rules(json), priority, created_at
```

**Three assignment modes**, mutually exclusive per set:

| Mode | Behaviour |
|---|---|
| `all` | Every product in the store |
| `manual` | An explicit product list the merchant picked |
| `conditional` | A **rule** — category, tag, attribute, price range — evaluated dynamically |

`conditional` is materially different from `manual` and worth the extra work:
**a product created next month that matches the rule inherits the option set with no
merchant action.** For a merchant adding products weekly, that is the difference between the
option set working and quietly not working. A manual list silently goes stale.

**Resolution order still matters.** Because assignment is exclusive *per set* but a product
can match *several sets* (one `all`, one `conditional`), `priority` remains necessary — it
resolves across sets, not within an assignment. Merchants see the outcome via
[M19.4](#m194--assignment-resolution)'s "effective options for this product" preview.

**Conditional rules are evaluated in the cloud at publish time** and materialized into the
config document as a resolved product list — *not* evaluated in the plugin at render time.
Otherwise every product page would have to run the matcher, which violates
[AC3](#ac3--the-product-page-never-blocks-on-optionia). New products entering scope are
picked up by the next product sync ([Phase 19](#phase-19--product-sync--assignment)).

### M5.6 — Product mirror

```text
store_products   id, store_id, external_id, name, sku, type, price, status,
                 permalink, image_url, categories(json), tags(json),
                 synced_at, external_updated_at
```

A **cache of the merchant's catalogue for the picker UI**, never a source of truth. Price
here is display-only; the plugin always uses WooCommerce's live price.

### M5.7 — Order facts

```text
order_events      id, store_id, external_order_id, order_total, currency,
                  option_revenue, occurred_at, raw(json)
order_selections  id, order_event_id, option_key, option_label,
                  value_key, value_label, price_delta
```

Written from webhooks/plugin reports for analytics. Denormalized labels are intentional —
an analytics record must remain readable after the option is renamed or deleted.

### M5.8 — Billing model

```text
plans                  id, code, name, price_monthly, price_yearly,
                       limits(json), features(json), is_public, sort_order
subscriptions          id, tenant_id, plan_id, provider, provider_subscription_id,
                       status, current_period_end, grace_ends_at, cancel_at,
                       trial_ends_at
usage_records          id, tenant_id, metric, value, period_start, period_end
billing_events         id, provider, provider_event_id (UNIQUE), type, payload(json),
                       processed_at, error
```

`billing_events.provider_event_id` is **UNIQUE** — this is the idempotency guarantee for
[Phase 23](#phase-23--billing-webhooks).

### M5.9 — Operational tables

```text
webhook_deliveries  id, store_id, direction, event, payload(json), status,
                    attempts, last_error, next_retry_at
audit_logs          id, tenant_id, user_id, action, resource_type, resource_id,
                    changes(json), ip, user_agent, created_at
sync_jobs           id, store_id, type, status, started_at, finished_at, stats(json)
```

### M5.10 — Migrations, seeds, and fixtures

**Migrations:** one per logical group, all reversible. `migration:revert` verified on each
before the migration is committed — an irreversible migration is a production incident
waiting for a bad deploy. Migrations are forward-only in production but must be *tested*
in both directions. No data-destroying migration without an explicit, reviewed decision.

**Seeds** (idempotent, safe to re-run):

```text
plans           Free / Pro / Business with real limits from M22.1
super-admin     from env, never a hardcoded credential
```

> **Corrected during Phase 5 closure.** This list originally carried a third
> entry — `roles`, with permission mappings. There is nothing to seed: roles are
> enum columns on `tenant_members` and `platform_staff` (`TenantRole`,
> `StaffRole`), not rows in a `roles` table, and the permission matrix those
> roles map to is [M6.5](#m65--roles-and-permission-matrix).
>
> Seeding it here would have meant inventing a permission model one phase before
> the milestone that designs it — the same mistake as seeding a conditional rule
> the engine cannot yet evaluate (ADR-018). The line predates the M6.5 split and
> was never removed.

**Development fixtures** — a `db:seed:demo` command producing a realistic tenant:

```text
1 tenant · 1 connected store (mock) · 30 products
5 option sets covering every shipped option type
   → 4 published, plus 1 draft carrying 40 options across 4 groups
50 historical orders with option selections spread across values
   → so analytics screens have something real to render
```

> **Delivered, with one deferral.** The fixture produces 5 option sets (44
> options, 134 values), 30 products, 50 orders and 147 selections spread across
> more than five distinct values, all from a seeded PRNG so the data is identical
> on every machine.
>
> The 40-option draft is the "200-option builder" case this milestone names below:
> a builder that feels responsive with four options is why
> [M28.5](#phase-28--performance) tests with a hundred. It is kept as a draft and
> assigned to no product, because its purpose is to load the builder rather than
> render on a storefront.
>
> **Conditional rules are not seeded.** This line originally asked for a cascading
> case. The rule engine is [Phase 17](#phase-17--conditional-logic-engine), so a
> seeded condition tree could not be validated, evaluated, or shown to be
> cycle-free — JSON nobody can prove is meaningful. Deferred with the reason
> recorded in ADR-018 rather than fabricated here.

This matters more than it sounds. Without realistic fixtures, every developer builds
against three hand-typed records, and the screens that break under real data — analytics,
the product picker, a 200-option builder — break for the first time in front of a merchant.
The fixture set is also the seed data for E2E tests
([M30.7](#phase-30--test-suite)) and for the public demo store
([M35.5](#m355--launch-assets)).

**Acceptance:** a new developer runs migrate + seed + seed:demo and has a working,
populated environment in one command.

### Phase 5 exit criteria

```text
[x] optioniaWooCommerceBackend boots on its own database with no secrets in source
[x] All migrations run forward and revert cleanly
[x] Every tenant-scoped table has a tenant_id or an FK path to one
[x] Money columns are BIGINT minor units, named *_minor (ADR-013 supersedes the
    earlier DECIMAL(12,4) guidance — see the reasoning below)
[x] Every FK declares ON DELETE behaviour; audit_logs.user_id is SET NULL so
    GDPR user erasure is possible
[x] docs/DATABASE.md written with an ERD
[x] Seeds produce a working demo tenant
```

**Phase 5 complete.** Evidence for each criterion, from a live database rather
than from memory — several of this phase's defects existed because intent was
recorded as if it were verification.

| Criterion | Evidence |
| --- | --- |
| Boots, no secrets | Boots on :4000 with `Found 0 errors`; `/health` returns 200 with `database: up`. `check-secrets.sh` passes four checks, including that `.env` is untracked |
| Migrations reversible | `migration:revert` succeeded with seed data present, then `migration:run` rebuilt from an empty database |
| Tenant path | 8 tables carry `tenantId` directly, 15 reach one through an FK, 3 are deliberately global (`plans`, `users`, `billing_events`) |
| Money columns | 9 money columns, every one `BIGINT` and named `*Minor`. `priceConfig` (json) and `priceType` (varchar) are a config blob and a discriminator, not money |
| Delete rules | 32 FKs, **zero** reported as `NO ACTION` by MySQL: 18 CASCADE, 8 RESTRICT, 6 SET NULL. Both `audit_logs.userId` and `audit_logs.tenantId` are SET NULL, so erasure never destroys the audit trail |
| `docs/DATABASE.md` | 26 documented tables against 26 live domain tables, and all 32 stated delete rules compared against `information_schema` — now enforced by `bin/check-docs.sh` in CI |
| Seeds | 3 plans, 1 tenant, 30 products, 5 option sets (44 options, 134 values), 50 orders, 147 selections. 9 e2e tests cover idempotency, volume, determinism and the production guard |

A full clean-database rehearsal was run end to end — drop, `migration:run`,
`db:seed`, `db:seed:demo`, 28 e2e tests, boot, `/health` — because that is what a
new developer does on day one and it had never been executed as one unbroken
sequence.

**Carried forward — three test-coverage gaps found in the Phase 5 audit.**
Measured, not estimated: `jest --coverage` reports **15.7% statements / 58.5%
branches** across `src/`. The files that were claimed to be guarded are guarded —
`money.transformer.ts` is at 100% and `env.ts` at 97.9% — but three are not.

1. **`bigint.transformer.ts` — 0%, lines 14–30 uncovered.** It throws on a value
   that is not a safe integer, and that throw has never executed. It is used by
   four entities: `option_sets.published_config_version`, `stores.config_version`,
   `order_selections.config_version` and `usage_records.value`. Those are the
   numbers [AC1](#ac1--optionia-cloud-is-the-source-of-truth-the-plugin-is-a-projection)
   projects to the plugin and the ones [Phase 24](#phase-24--plan-limits-and-usage)
   bills against. Its own comment names the bug it prevents — a version counter
   arriving as a string, so `configVersion + 1` becomes `"421"`.

2. **`super-admin.seed.ts` — 3 of 4 branches never execute.** CI runs the seed but
   sets no `SEED_ADMIN_*` variables, so only the skip path is taken. The
   12-character password minimum, the user-creation path and the staff-grant path
   have never run in any automated check — on the one account that can impersonate
   any merchant.

3. **No coverage threshold, and coverage is never measured in CI.** This is the
   reason the other two went unnoticed, and it is the same failure as the
   documentation drift (ADR-020): a guarantee with no guard. `npm run check`
   passes at 15.7% exactly as it would at 90%.

Assigned to [Phase 30](#phase-30--test-suite), which owns the test strategy, with
the transformer and the password guard pulled forward into
[M6.6](#m66--tenant-isolation-test-suite) — both are small, and the second is a
security control on the most privileged account in the system.

**Carried forward — fixture coverage gap.** `uq_options_group_key` is
`(option_group_id, key, deleted_at)`, so the same option key in a *different*
group is permitted by design — that is what lets two option sets both have a
`size`. The fixture never exercises it: every key in the demo data is unique
across all 44 options, so the permitted case has no regression guard.

Verified by hand during the Phase 5 audit — inserting the same key into two
groups succeeds, and a third insert into the first group is rejected by MySQL
with `ER_DUP_ENTRY`. The constraint is correct; only the coverage is thin.
[M6.6](#m66--tenant-isolation-test-suite) is the right place to fix it, since
that suite already builds a second tenant and the interesting case is two tenants
using identical keys.

**Carried forward:** conditional rules are absent from the fixture. The rule
engine is [Phase 17](#phase-17--conditional-logic-engine), so a seeded condition
tree could not be validated, evaluated, or shown to be cycle-free — see ADR-018.
Plan limits are provisional pending **D2**; `limits` is a JSON column, so
revising them is an `UPDATE` rather than a migration.

---

## Phase 6 — Tenancy & Auth

**Depends on:** Phase 5
**Blocks:** Phase 7
**Implements:** [AC5](#ac5--tenant-isolation-is-enforced-at-the-data-access-layer)

### M6.0 — Transactional email infrastructure

**Built before authentication, because authentication cannot work without it.** Email
verification, password reset, team invites, and dunning notices are all blocked on this,
and "we'll wire up email later" means those flows are untestable.

**Provider:** a transactional email service with a delivery API and webhooks — Postmark,
Resend, SES, or equivalent. **Not** SMTP through a shared host, and never the application
server's own mailer: deliverability is the whole point, and a merchant who never receives
a verification email never becomes a customer.

**Domain setup, required before the first send:** SPF, DKIM, and DMARC records on the
sending domain, plus a dedicated subdomain for transactional mail so a marketing send can
never damage transactional reputation.

**A `Mailer` abstraction** behind an interface, same reasoning as
[M22.2](#m222--billingprovider-abstraction) — the provider must be swappable.

**Template catalogue** (each with plain-text and HTML, each i18n-ready per
[M29.8](#m298--internationalization-and-localization)):

```text
AUTH             verify-email · password-reset · password-changed
                 new-device-login · email-change-confirm
TEAM             invitation · invitation-accepted · member-removed
LIFECYCLE        welcome · onboarding-nudge · trial-ending · trial-ended
BILLING          payment-succeeded · payment-failed · card-expiring
                 subscription-cancelled · grace-period-warning · invoice
OPERATIONAL      store-disconnected · sync-failing · plan-limit-approaching
```

**Delivery guarantees:** queued through
[optioniaWooCommerceWorker](#m341--infrastructure-topology) (or the queue's stand-in
until it exists), retried on transient failure, idempotent so a retry cannot double-send,
and logged per recipient so support can answer *"did they get it?"*

**Bounce and complaint handling:** provider webhooks update the user record. A hard bounce
marks the address undeliverable and surfaces it in the dashboard rather than silently
failing forever.

**Never in an email:** a password, a store token, a full API key, or a link that
authenticates without expiry. Verification and reset links are single-use and
time-limited.

**Acceptance:** every template renders in both formats; SPF/DKIM/DMARC verified; a send
failure is visible in the ops queue; delivery for each template confirmed to a real inbox.

### M6.1 — Merchant authentication

Register → email verification → login → refresh → logout → password reset. bcrypt (cost
≥ 12), short-lived access tokens with rotating refresh tokens, refresh-token reuse
detection.

**Rate limiting on every auth endpoint** — per IP and per account. Login, register,
password reset, and verification resend are the endpoints that get attacked; without limits
they are a credential-stuffing surface and an email-bombing vector.

Generic failure messages on login ("email or password is incorrect") so the endpoint is not
a user-enumeration oracle. Password strength enforced server-side, with a breached-password
check against a k-anonymity API if available.

**Acceptance:** unverified users cannot access tenant resources; auth endpoints are
rate-limited and do not leak whether an address is registered.

### M6.2 — Tenant provisioning

On registration: create tenant, add user as `owner`, start trial, seed a default empty
option set. One atomic transaction.

### M6.3 — `TenantGuard` and request context

`JwtAuthGuard` → `TenantGuard` resolves the active tenant from the token plus a header,
verifies membership, and attaches it to an `AsyncLocalStorage` request context.

### M6.4 — Tenant-scoped repository layer

**The core of [AC5](#ac5--tenant-isolation-is-enforced-at-the-data-access-layer).** A
`TenantScopedRepository` base that reads tenant context from `AsyncLocalStorage` and
injects the predicate automatically. It **throws if no tenant context is present** rather
than returning unscoped rows.

```ts
// Impossible to forget the tenant predicate — the base class owns it.
class OptionSetsRepository extends TenantScopedRepository<OptionSet> {}
```

**Acceptance:** a service method that forgets tenant scoping cannot leak data — it
throws.

### M6.5 — Roles and permission matrix

**Two entirely separate identity systems.** They must never share a role table, a guard, or
a token audience — a merchant must be structurally incapable of holding a platform role.

```text
REALM 1 — PLATFORM STAFF          (you and your team; a handful of people)
   super_admin · support · billing_ops · read_only
        ↓ authenticated by user JWT with audience = "platform"
        ↓ guarded by PlatformGuard, only on /admin/* routes
        ↓ NOT scoped to a tenant — deliberately cross-tenant

REALM 2 — TENANT MEMBERS          (merchants; the customers)
   owner · admin · editor · viewer · billing
        ↓ authenticated by user JWT with audience = "tenant"
        ↓ guarded by TenantGuard + RolesGuard
        ↓ ALWAYS scoped to one tenant (AC5)

REALM 3 — STORE TOKENS            (the plugin; machines, not people)
   single scope: read config · write events · heartbeat
        ↓ NOT a user, NOT a role — a scoped credential
        ↓ guarded by StoreTokenGuard, only on /store/* routes
```

A token from one realm presented to another realm's route is a **401, never a 403** — the
route should not admit it exists.

#### Tenant roles

| Capability | owner | admin | editor | viewer | billing |
|---|:---:|:---:|:---:|:---:|:---:|
| View option sets | ✅ | ✅ | ✅ | ✅ | — |
| Create / edit option sets | ✅ | ✅ | ✅ | — | — |
| Delete option sets | ✅ | ✅ | — | — | — |
| **Publish to storefront** | ✅ | ✅ | — | — | — |
| Rollback a published version | ✅ | ✅ | — | — | — |
| Assign to products | ✅ | ✅ | ✅ | — | — |
| Connect / disconnect a store | ✅ | ✅ | — | — | — |
| Rotate store credential | ✅ | ✅ | — | — | — |
| View analytics | ✅ | ✅ | ✅ | ✅ | ✅ |
| Export data | ✅ | ✅ | — | — | — |
| Invite / remove members | ✅ | ✅ | — | — | — |
| Change a member's role | ✅ | — | — | — | — |
| View invoices & usage | ✅ | — | — | — | ✅ |
| Change plan / payment method | ✅ | — | — | — | ✅ |
| Cancel subscription | ✅ | — | — | — | — |
| Delete the tenant | ✅ | — | — | — | — |
| View audit log | ✅ | ✅ | — | — | — |

**The deliberate separations, each with a reason:**

- **`editor` cannot publish.** Editing is safe; publishing changes a live storefront and
  what customers are charged. An agency contractor should be able to build an option set
  without being able to push it live. This is the single most important line in the matrix.
- **`billing` sees money but not configuration.** A bookkeeper or finance contact needs
  invoices, not the option builder.
- **`viewer` is read-only** — for stakeholders and for handing a client visibility without
  risk.
- **`admin` can do everything operational but cannot change roles, alter billing, or delete
  the tenant.** Those are ownership acts.
- **Only `owner` changes roles**, so an `admin` cannot escalate themselves or a peer to
  `owner`.

#### Platform staff roles

| Capability | super_admin | support | billing_ops | read_only |
|---|:---:|:---:|:---:|:---:|
| View any tenant / store | ✅ | ✅ | ✅ | ✅ |
| View operations queue | ✅ | ✅ | ✅ | ✅ |
| Retry a failed job | ✅ | ✅ | — | — |
| **Impersonate a merchant** | ✅ | ✅ | — | — |
| Read merchant option config | ✅ | ✅ | — | ✅ |
| **Edit merchant option config** | — | — | — | — |
| Manually adjust a subscription | ✅ | — | ✅ | — |
| Issue a refund / credit | ✅ | — | ✅ | — |
| Edit plans & limits | ✅ | — | — | — |
| Manage feature flags | ✅ | — | — | — |
| Manage platform staff | ✅ | — | — | — |
| Delete tenant data | ✅ | — | — | — |

**`edit merchant option config` is denied to every platform role, including
`super_admin`.** Staff diagnose and advise; they do not silently change what a merchant's
customers are charged. If a config genuinely must change, it happens through
**impersonation** — which is consented, time-boxed, and audit-logged as the merchant's own
action so the trail is honest about who did what.

#### Enforcement rules

1. **Deny by default.** A capability absent from the matrix is denied. New endpoints are
   inaccessible until explicitly granted.
2. **Server-side only.** The dashboard hides what a role cannot do as a *courtesy*; the API
   enforces it as the *rule*. Every capability has a negative test
   ([M6.6](#m66--tenant-isolation-test-suite)).
3. **Audit every privileged action** — role changes, publishes, impersonation, billing
   changes, deletions — with actor, target, before/after, IP.
4. **Impersonation is fenced:** merchant consent required, time-limited session, a banner
   visible throughout, every action attributed to both staff member and merchant, and
   billing/deletion actions blocked while impersonating.
5. **Last-owner protection.** The final `owner` cannot be removed or demoted. Ownership
   transfer is an explicit two-step flow with email confirmation.
6. **Invitations carry a role**, are single-use, expire, and cannot grant a role above the
   inviter's own.

### M6.5b — Team management flows

Invite by email ([M6.0](#m60--transactional-email-infrastructure) templates), accept flow
for both existing and new users, role change, revoke, seat counting against plan limits
([M24.1](#m241--usage-metering)), pending-invite list with resend and cancel, and ownership
transfer.

**MVP note:** the schema, guards, and matrix ship in full — enforcement is not something to
retrofit. The **team-management UI** is deferred per
[S4](#s4-mvp-scope--what-ships-first); at launch every merchant is a single `owner`. The
roles exist and are enforced from day one, so enabling the UI later requires no migration
and no re-audit.

### M6.6 — Tenant isolation test suite

**This suite is permanent and runs in CI forever.** Create tenants A and B with full
object graphs, then assert that every endpoint returns 404/403 for cross-tenant access:
direct ID access, list endpoints, nested resources, update, delete, bulk operations,
filter/search parameters, and sort parameters.

**Acceptance:** every tenant-scoped endpoint has a passing negative test.

### Phase 6 exit criteria

```text
[ ] Full auth lifecycle working with email verification
[ ] TenantGuard enforced on all tenant routes
[ ] Tenant-scoped repository layer in place and throwing without context
[ ] Cross-tenant access impossible — proven by tests, not asserted
[ ] Three identity realms separated; cross-realm token is a 401
[ ] Full permission matrix enforced server-side with negative tests per capability
[ ] editor cannot publish; admin cannot change roles; no platform role can edit config
[ ] Last-owner protection working
[ ] Impersonation consented, time-boxed, audit-logged
[ ] Audit log capturing auth, role, publish, and billing events
```

---

## Phase 7 — Option Authoring API

**Depends on:** Phase 6
**Blocks:** Phases 9, 13
**Scope discipline:** exactly **one** option type — `radio`. Types 2–N are
[Phase 14](#phase-14--option-type-library).

### M7.1 — Option set CRUD

List (paginated, filtered), create, read, update, delete (soft), duplicate. Tenant-scoped
throughout.

### M7.2 — Group and option CRUD

Nested under an option set. The **full lifecycle operation set**, defined once here and
inherited by groups, options, and values alike:

| Operation | Semantics |
|---|---|
| Create | Appended at the end of its parent's ordering |
| Rename | Label changes freely; **`key` is immutable after first publish** |
| Update | Config patched; validated against the type's Zod schema |
| Enable / disable | Soft toggle — retained, excluded from published config. The merchant's escape hatch for "turn this off for the holidays" without losing the work |
| Duplicate | Deep copy including values and rules; new `key`s generated; `-copy` suffix on the label |
| Reorder | Explicit `sort_order`, bulk endpoint, gap-tolerant integers so a single move is one write |
| Delete (soft) | Hidden and excluded from config; historic orders unaffected |
| Delete (hard) | Only permitted when no order ever referenced it |

**Cascade rules, stated explicitly rather than inherited from the ORM:**

```text
delete option_set   → soft-deletes groups, options, values, rules, assignments
delete group        → soft-deletes its options; rules targeting it are disabled + flagged
delete option       → soft-deletes its values; rules referencing it are disabled + flagged
delete value        → blocked if it is the target of an enabled rule (explicit error)
```

A rule left pointing at a deleted target is **disabled and surfaced to the merchant**,
never silently dropped and never left to fail at evaluation time.

**Why `key` is immutable after publish:** order meta stores `option_key`. If a key can
change, every historic order becomes unreadable. Labels are free to change because they
are snapshotted per order ([M12.1](#m121--cart-item-data-model)).

### M7.2b — Serialization contract

One canonical serializer produces the option model for **every** consumer, so no two
surfaces can disagree about what an option is:

```text
                    ┌─ Dashboard editor  (full model, incl. drafts)
   Option model ────┼─ Live preview      (published projection, Phase 21)
   (single source)  ├─ Store config      (published projection, M7.5)
                    ├─ Pricing evaluator (TS + PHP, shared fixtures M11.4)
                    └─ Validation        (Zod cloud-side, mirrored PHP-side)
```

Two projections only: the **authoring** shape (includes drafts, internal ids, audit
fields) and the **published** shape (the config document — no drafts, no internal ids, no
tenant data, money as integer minor units). A field appears in the published projection
only if the plugin genuinely needs it — the config document is public-ish data sitting on
merchant servers, so anything unnecessary is needless exposure.

**Acceptance:** one serializer, two projections, round-trip tested. Adding a field to the
model requires an explicit decision about whether it appears in the published projection.

### M7.3 — `radio` type definition and validation

A `type registry` keyed by option type, each entry carrying a Zod schema for its
`validation` / `pricing` / `display` JSON. Implement `radio` only — but build the
registry so [Phase 14](#phase-14--option-type-library) is registration, not refactoring.

**Acceptance:** malformed pricing config is rejected at the API boundary with a precise
error.

### M7.4 — Publish, versioning, and rollback

**State model:**

```text
draft ──publish──> published ──edit──> published (with unpublished changes)
  │                    │                          │
  │                    └──unpublish──> draft      └──publish──> published (v+1)
  └──archive──> archived
```

An edit to a published set does **not** immediately reach storefronts. The set holds a
published version *and* a working draft, so a merchant can edit safely on a live store —
which is the whole point of a draft state and the thing a self-hosted plugin cannot offer.

**Publish is a transaction:** validate the whole set (including
[M17.3](#m173--cascading-and-cycle-detection) cycle detection and
[M14.4](#m144--per-type-validation) regex complexity), increment `version`, stamp
`published_at` and `published_by`, write an **immutable snapshot**, bump the store's
`config_version`, then trigger invalidation ([M9.4](#m94--push-invalidation)).

**Version history and rollback:**

```text
option_set_versions  id, option_set_id, version, snapshot(json),
                     published_by, published_at, note
```

Snapshots are immutable and retained (retention per plan, per
[Phase 26b](#phase-26b--data-protection--compliance)). A merchant can view the history,
diff any version against the current draft, and **roll back** — which publishes a prior
snapshot as a new version rather than rewriting history.

Rollback matters commercially: a merchant who breaks their storefront at 9pm and can undo it
in one click does not churn. One who cannot, does.

**Pre-publish checks**, surfaced before the button, not as errors after it: options with no
values, rules pointing at deleted targets, required options hidden by their own rule, pricing
referencing a removed value, sets with no product assignment (publishing to nothing).

### M7.4b — Concurrency control

Two people editing one option set is normal in an agency, and the
[failure-mode table](#m3010--failure-and-recovery-testing) already promises "second sees a
conflict, not a silent overwrite." This is where that is built.

**Optimistic locking** via a `row_version` column on `option_sets`, incremented on every
mutation. Every write carries the version the client loaded; a mismatch returns **409
Conflict** with the current server state, never a silent last-write-wins.

The dashboard turns that 409 into a real choice — reload and lose local edits, or view what
changed — rather than an error toast. Silent overwrite is the failure mode to design out:
losing an afternoon's work to a colleague's save is unforgivable in an authoring tool.

**Publish is serialized** per option set. Two simultaneous publishes must not interleave into
a half-built snapshot; the second waits and then sees the first's version.

**Autosave** ([M20.10](#phase-20--full-builder-ui)) writes drafts frequently, so it carries
the same version check and must degrade gracefully — an autosave conflict warns rather than
discarding.

**Acceptance:** two concurrent editors both save; the second gets a 409 with a usable
choice; no write is silently lost; a snapshot is never partially written.

### M7.5 — Config document contract

**The single most important interface in the system.** The exact JSON the plugin
consumes:

```jsonc
{
  "schema_version": 1,
  "config_version": 42,
  "store_id": "…",
  "generated_at": "2026-08-21T10:00:00Z",
  "option_sets": [{
    "id": "…", "version": 7,
    "assignments": [{ "target_type": "product", "target_ref": "123", "priority": 10 }],
    "groups": [{
      "id": "…", "label": "Customization", "sort_order": 1,
      "options": [{
        "id": "…", "key": "print_placement", "type": "radio",
        "label": "Print", "is_required": true,
        "validation": { … }, "pricing": { … }, "display": { … },
        "values": [
          { "value_key": "none",  "label": "None",  "price_config": { "type": "fixed", "amount": 0 } },
          { "value_key": "front", "label": "Front", "price_config": { "type": "fixed", "amount": 1000 } }
        ]
      }]
    }],
    "rules": []
  }]
}
```

Money is **integer minor units** on the wire. `schema_version` is separate from
`config_version` so the plugin can refuse a document it is too old to understand.

**Deliverable:** `docs/CONFIG-CONTRACT.md` — versioned, and the reference for both the
PHP and TS implementations.

### M7.6 — Audit logging

Every option-set mutation recorded with actor, diff, IP.

### M7.7 — API contract, written before implementation

**Design the endpoint surface before building it, not after.** Retrofitting a contract
onto endpoints that already exist produces an API shaped by implementation accidents
rather than by the client's needs — and the plugin is a client you cannot easily
redeploy across thousands of merchant sites.

For **every** endpoint document: method and path, authentication, authorization (which
role, which tenant scope), request schema, response schema, validation rules, error codes
and their meanings, rate limits, and pagination semantics.

The v1 surface:

```text
AUTH
POST   /auth/register              POST /auth/login
POST   /auth/verify-email          POST /auth/refresh
POST   /auth/logout                POST /auth/forgot-password
POST   /auth/reset-password

TENANTS & MEMBERS
GET    /tenants/me                 PATCH /tenants/me
GET    /tenants/me/members         POST  /tenants/me/members/invite
PATCH  /tenants/me/members/:id     DELETE /tenants/me/members/:id

STORES
GET    /stores                     GET   /stores/:id
POST   /stores/:id/disconnect      POST  /stores/:id/rotate-credential
GET    /stores/:id/products

CONNECTION  (see Phase 8)
POST   /connect/initiate           POST  /connect/authorize
POST   /connect/exchange

OPTION SETS
GET    /option-sets                POST  /option-sets
GET    /option-sets/:id            PATCH /option-sets/:id
DELETE /option-sets/:id            POST  /option-sets/:id/duplicate
POST   /option-sets/:id/publish    GET   /option-sets/:id/versions
POST   /option-sets/:id/rollback

GROUPS · OPTIONS · VALUES  (nested, tenant-scoped)
POST   /option-sets/:id/groups     PATCH  /groups/:id     DELETE /groups/:id
POST   /groups/:id/options         PATCH  /options/:id    DELETE /options/:id
POST   /options/:id/values         PATCH  /values/:id     DELETE /values/:id
POST   /option-sets/:id/reorder

RULES
POST   /option-sets/:id/rules      PATCH /rules/:id       DELETE /rules/:id
POST   /option-sets/:id/rules/test

ASSIGNMENTS
GET    /option-sets/:id/assignments
POST   /option-sets/:id/assignments
DELETE /assignments/:id
GET    /stores/:id/products/:pid/effective-options

STORE-FACING  (store-token auth, not user JWT)
GET    /store/config               POST /store/heartbeat
POST   /store/events               POST /store/orders

BILLING  (Phase 22)
GET    /plans                      GET  /subscription
POST   /subscription/checkout      POST /subscription/change-plan
POST   /subscription/cancel        GET  /subscription/invoices
GET    /usage

ANALYTICS  (Phase 25)
GET    /analytics/overview         GET  /analytics/options
GET    /analytics/revenue          GET  /analytics/export

WEBHOOKS  (inbound)
POST   /webhooks/billing/:provider
POST   /webhooks/woocommerce/:storeId
```

**Two authentication realms, kept strictly separate.** User JWT endpoints and
store-token endpoints (`/store/*`) are distinct guard chains. A store token must **never**
be accepted on a `/option-sets` route, and a user JWT must never be accepted on
`/store/config`. This is the API-boundary form of
[AC8](#ac8--no-saas-secret-ever-ships-inside-the-plugin).

**Conventions fixed now, not per-endpoint:** cursor pagination on all list endpoints;
`ApiResponseInterceptor` envelope everywhere; RFC-style error bodies with a stable
machine-readable `code`; `/v1` prefix with an explicit deprecation policy.

**Deliverable:** `docs/API-CONTRACT.md` + generated OpenAPI spec, both reviewed before
implementation begins.

**Acceptance:** every endpoint documented with auth, authz, schemas, errors, and limits
**before** its controller is written.

### Phase 7 exit criteria

```text
[ ] API contract documented and reviewed BEFORE implementation
[ ] Option sets, groups, options, values fully CRUD-able
[ ] Type registry in place; radio implemented and validated
[ ] Publish produces an immutable versioned snapshot
[ ] Config document contract documented and frozen for v1
[ ] User-JWT and store-token realms strictly separated
[ ] All endpoints tenant-scoped with negative tests
[ ] OpenAPI/Swagger published
```

---

## Phase 8 — Store Connection

**Depends on:** Phases 3, 7
**Blocks:** Phase 9
**Implements:** [AC8](#ac8--no-saas-secret-ever-ships-inside-the-plugin)

### M8.1 — Connection handshake design

No SaaS secret in the plugin, resistant to replay, and comprehensible to a
non-technical merchant.

```text
Plugin: merchant clicks "Connect Optionia"
   → plugin generates a local nonce + PKCE-style verifier, stores it
   → redirect to app.optionia.com/connect?site_url=…&callback=…&state=…&challenge=…
Cloud: merchant logs in / signs up, sees "Connect <store_url> to <tenant>?", approves
   → cloud creates store + one-time authorization code
   → redirect back to the site's callback with code + state
Plugin: verifies state, exchanges code (+ verifier) server-to-server for a store token
   → stores token, discards the code
Cloud: marks the store connected; token is bound to that store_url
```

**Acceptance:** the authorization code is single-use, short-lived (≤5 min), and bound to
both `state` and `site_url`.

### M8.1b — Connection state machine

Connection state must be an **explicit, persisted state machine on both sides** — not
inferred from whether a token happens to be present. Ambiguous connection state is the
single largest source of support tickets in this category of product: the merchant sees
"connected", the cloud disagrees, and nobody can tell which is right.

```text
                    ┌──────────────┐
       ┌────────────►│ DISCONNECTED │◄───────────┐
       │                └───────┬───────┘            │
       │                        │ merchant clicks Connect
       │                        ▼                        │
       │                 ┌────────────┐   timeout    │
       │                 │ CONNECTING │──────────────┘
       │                 └──────┬─────┘
       │                        │ code exchanged
       │                        ▼
       │                 ┌───────────┐
       │  merchant       │ CONNECTED │───────┐
       └──disconnects────┤           │       │ sync/auth failure
                         └────┬──────┘       ▼
                              │          ┌───────┐
              cloud revokes   │          │ ERROR │──┐
                              ▼          └───┬───┘  │ recovers
                         ┌─────────┐      │      │
                         │ REVOKED │      └──────┘
                         └─────────┘   → back to CONNECTED
```

| State | Storefront | Dashboard | Merchant sees |
|---|---|---|---|
| `DISCONNECTED` | No options rendered | Store not listed | "Connect your store" |
| `CONNECTING` | Unchanged | Pending | "Waiting for authorization…" |
| `CONNECTED` | Renders from cache | Full function | Healthy, last sync time |
| `ERROR` | **Keeps serving cache** | Warning banner | What failed + retry |
| `REVOKED` | **Keeps serving cache** | Reconnect prompt | "Reconnect to publish changes" |

`ERROR` and `REVOKED` **never** stop the storefront — that is
[AC3](#ac3--the-product-page-never-blocks-on-optionia) and the trust commitment in
[D5](#d3--positioning-against-one-time-purchase-competitors). A store in either state
still sells; it just cannot receive new configuration.

**Reconciliation:** plugin state and `stores.status` can drift (a database restore, a
migrated site, a cloned staging environment). The heartbeat in
[M8.5](#m85--store-heartbeat) carries the plugin's own view of its state, and a mismatch
raises an operations item in [Phase 26](#phase-26--super-admin) rather than being silently
tolerated.

**Site-URL change detection:** if a connected store's `site_url` changes (staging clone,
domain migration), the cloud must detect it and require re-authorization. Otherwise a
cloned staging site inherits production's credential and starts reporting orders.

**Acceptance:** every transition is logged; both sides agree on state after any
transition; a cloned site cannot silently reuse the original's credential.

### M8.2 — Cloud endpoints

`POST /connect/initiate`, `POST /connect/authorize`, `POST /connect/exchange`,
`POST /stores/:id/disconnect`, `POST /stores/:id/rotate-credential`. Rate-limited.

### M8.3 — Plugin connection UI

Settings → Connection: connect button, connected state (tenant, store, last sync, config
version), disconnect, reconnect. Plain-language errors.

### M8.4 — Token storage and transport

Token in `wp_options`, autoload off. Every request over HTTPS with
`Authorization: Bearer`, a plugin-version header, and a signed timestamp to limit replay.
Certificate verification **never** disabled.

### M8.5 — Store heartbeat

Daily authenticated ping reporting plugin/WP/WC/PHP versions and cache state → updates
`stores.last_seen_at`. This is the support and analytics backbone: it reveals stale
installs and dead connections before merchants report them.

### M8.6 — Disconnect and revocation

Merchant-side disconnect (plugin clears token, cloud revokes) and cloud-side revoke
(plugin detects 401 → surfaces a reconnect notice → **keeps serving cached config**, per
[AC3](#ac3--the-product-page-never-blocks-on-optionia)).

**Acceptance:** revoking a credential never breaks a live storefront.

### Phase 8 exit criteria

```text
[ ] Merchant can connect a store in under 60 seconds
[ ] No SaaS secret present anywhere in plugin source
[ ] Codes single-use, short-lived, state-verified
[ ] Token rotation and revocation working
[ ] Revocation degrades gracefully — storefront keeps working
[ ] Heartbeat populating store telemetry
```

---

## Phase 9 — Config Sync & Cache

**Depends on:** Phases 7, 8
**Blocks:** Phase 10
**Implements:** [AC3](#ac3--the-product-page-never-blocks-on-optionia)

> **The phase that makes or breaks merchant trust.** Get this wrong and either product
> pages are slow, or merchants see stale options after publishing.

### M9.1 — Config delivery endpoint

`GET /store/config` authenticated by store token. Returns the M7.5 document. Supports
`If-None-Match` → `304 Not Modified`. `ETag` = `config_version`. Gzipped.

### M9.2 — Plugin cache layer

Config in `wp_options` (autoload **off**, it can be large), with an object-cache layer for
hot reads. Store alongside it: `config_version`, `fetched_at`, `schema_version`.

An **index** built at write time — `product_id → applicable option sets` — so a product
page does a single indexed lookup instead of scanning assignments.

**Acceptance:** rendering options adds **zero** external HTTP calls and **≤1** extra DB
read to a product page.

### M9.3 — Pull-based refresh

WP-Cron every 15 min, conditional (`If-None-Match`). Plus a manual "Sync now" button —
because WP-Cron is unreliable on low-traffic sites and merchants need a deterministic
escape hatch.

### M9.4 — Push invalidation

On publish, the cloud pings the store's callback: *"config_version 43 available."* The
plugin then **pulls** (the push carries no config — it only wakes the pull, so the push
channel needs no payload trust). Signed with the store credential. Queued with retry and
recorded in `webhook_deliveries`.

**Acceptance:** publish → live storefront in under 30 seconds on a healthy store, and
within 15 minutes even if push delivery fails entirely.

### M9.5 — Schema version negotiation

If `schema_version` exceeds what the plugin understands: keep the last good config, raise
an admin notice asking for an update, and report the mismatch on heartbeat. **Never**
render a config it cannot fully parse.

### M9.6 — Degradation matrix

Explicit, tested behaviour:

| Condition | Behaviour |
|---|---|
| API unreachable | Serve cached config; log; retry with backoff |
| Token revoked (401) | Serve cached config; admin notice to reconnect |
| Subscription lapsed | Serve cached config (read-only); notice ([Phase 24](#phase-24--plan-limits--enforcement)) |
| Config malformed | Keep previous good version; alert |
| No cache at all (fresh install) | Render nothing; no error to the customer |
| `schema_version` too new | Keep last good; ask for plugin update |

**Acceptance:** with `optioniaWooCommerceBackend` fully stopped, storefront and checkout work normally.

### M9.7 — Cache observability

System Status shows config version, last successful fetch, last error, cache size, next
scheduled sync, and index entry count.

### Phase 9 exit criteria

```text
[ ] Product page makes zero synchronous API calls
[ ] Publish reaches storefront in <30s via push, <15min via cron fallback
[ ] Every row of the degradation matrix tested
[ ] Schema version negotiation working
[ ] Cache state fully visible in System Status
[ ] Load test: cached config render adds <5ms to page generation
```

---

## Phase 10 — Storefront Renderer

**Depends on:** Phases 4, 9
**Blocks:** Phase 11
**Implements:** [AC7](#ac7--both-theme-worlds-are-first-class)
**First action:** delete the Phase 4 prototype.

### M10.1 — Resolve applicable options

Given a product, resolve applicable option sets by assignment priority, merge
deterministically, and cache per product.

### M10.2 — Classic theme renderer

Render from config at the per-type hook chosen in
[M10.5](#m105--product-type-coverage) — **not** a single uniform hook.

⚠️ **The renderer must be idempotent per product.** Phase 4 observed a variable product
reaching the render path **twice** in one request; without a guard it printed two option
blocks. Track what has been rendered and skip repeats.

Server-rendered PHP,
progressive enhancement, correct labels/required markers/descriptions, full escaping,
theme-neutral markup, accessible (labels bound, fieldset/legend for groups, ARIA for
required and errors).

### M10.3 — Frontend JS runtime

Vanilla ES6, no jQuery. Handles selection state, client-side price *display* (labelled as
an estimate, never trusted), validation feedback, rule evaluation for show/hide
([Phase 17](#phase-17--conditional-logic-engine)), and a `data-optionia` hook surface for
theme developers.

### M10.4 — Block theme / Store API integration

Register a Store API schema extension so block-based product/cart surfaces receive
Optionia data. Where the block ecosystem cannot yet host the UI, degrade to the classic
render path deliberately and document it.

**Acceptance:** options render and function on a block theme with Cart & Checkout Blocks
enabled.

### M10.5 — Product type coverage

⚠️ **Verified in WC 11.0.1: the render hook does not fire in the same place for every
product type.** Hooking one hook uniformly produces a broken variable-product experience.

| Template | fires `woocommerce_before_add_to_cart_button`? |
|---|---|
| `simple.php` | ✅ directly |
| `grouped.php` | ✅ directly |
| `external.php` | ✅ directly |
| **`variable.php`** | ❌ **not directly** — only via `variation-add-to-cart-button.php:15`, *inside* the variation form and only **after** a variation is selected |

Hooking only `woocommerce_before_add_to_cart_button` on a variable product means: options
are **absent on page load**, appear once a variation is chosen, and are **wiped or
duplicated** when the customer switches variation. Broken for exactly the target segment —
apparel with size/colour variants *plus* customization.

**Required per-type strategy:**

| Type | Render at | Support |
|---|---|---|
| Simple | `woocommerce_before_add_to_cart_button` | ✅ Full |
| Variable | `woocommerce_after_variations_table` (or `woocommerce_before_add_to_cart_form`), plus JS `found_variation` / `reset_data` events to re-evaluate rules and recompute price | ✅ Full |
| Grouped | Per-child, documented limits | ⚠️ Partial |
| External | **Render nothing** — no cart exists; the hook fires but the product links offsite | ❌ N/A |

The external case is a real code path, not a theoretical one: the hook fires, so without an
explicit guard Optionia would render options that can never be purchased.

**Acceptance:** on a variable product, options are present **before** any variation is
selected, survive a variation change without duplicating, and re-price correctly on change.
On an external product, nothing renders.

### M10.6 — Live price display

Show the running total as options are chosen. Clearly an **estimate**; the server
recomputes at add-to-cart ([AC4](#ac4--price-is-server-authoritative-always)). Currency
formatting via WooCommerce's own settings.

### M10.7 — Client-side validation UX

Required-field enforcement before submit, inline messages, focus management, and a
disabled add-to-cart with an explanation while invalid — always re-checked server-side.

### Phase 10 exit criteria

```text
[ ] Options render from real cloud config on classic AND block themes
[ ] Simple and variable products fully working
[ ] Zero synchronous API calls on page load
[ ] Accessibility: keyboard navigable, screen-reader labelled
[ ] Phase 4 prototype deleted — `tools/phase4-probe/` and the Studio copy
[ ] Verified on Storefront + Twenty Twenty-Five + one page builder
```

---

## Phase 11 — Pricing Engine

**Depends on:** Phase 10
**Blocks:** Phase 12
**Implements:** [AC4](#ac4--price-is-server-authoritative-always)

> The correctness-critical phase. A pricing bug charges real customers the wrong amount
> on someone else's store.

### M11.1 — Pricing model specification

```text
fixed        → + amount
percentage   → + (base_price × pct)
per_unit     → + (amount × option_quantity)
per_char     → + (amount × strlen(text))       # engraving
tiered       → amount by quantity bracket
formula      → constrained expression (Phase 16)
```

Specify precisely: order of operations, whether percentages compound, what percentages
apply to (base only, vs. base + prior deltas), rounding mode and precision, tax
inclusive/exclusive interaction, and multi-currency behaviour.

**Deliverable:** `docs/PRICING-SPEC.md` — normative for both implementations.

### M11.2 — PHP evaluator

A pure function `(config, selections, base_price, quantity) → price_delta + breakdown`.
No I/O, no globals, fully unit-testable. Integer minor units internally; converted once
at the boundary. **Never floats for money.**

### M11.3 — TypeScript evaluator

Same function in the cloud, for preview ([Phase 21](#phase-21--live-preview)) and
validation. Cloud is authoritative for *authoring*; PHP is authoritative for
*transactions*.

### M11.4 — Cross-language fixture suite

**The mechanism that keeps two implementations honest.** A shared JSON fixture file —
inputs plus expected outputs — executed by **both** the PHP and the TS test suites in CI.
A divergence fails the build.

Must cover: each pricing type alone; combinations; zero and negative deltas; rounding
boundaries (`0.005`, `0.015`); large quantities; empty selections; percentage-of-percentage;
currencies with 0 decimals (JPY) and 3 decimals (KWD).

**Acceptance:** identical fixtures, identical results, both languages, enforced in CI.

### M11.5 — Server-side enforcement at add-to-cart

`woocommerce_add_to_cart_validation`: accept only selection keys; reject unknown option
or value keys; reject options not applicable to this product; enforce required; enforce
validation rules; recompute price from cached config, ignoring anything price-like in the
request.

**This filter has two call sites with different signatures** — verified in WC 11.0.1
`includes/class-wc-form-handler.php`:

```php
apply_filters( 'woocommerce_add_to_cart_validation', true, $product_id, $quantity ); // :981
apply_filters( 'woocommerce_add_to_cart_validation', true, $item, $quantity );       // :1013
```

The second passes an **array**, not a product id. A callback assuming an integer will
misbehave on that path — which is the one used by order-again/reorder flows. **Type-check
the second argument**; never assume it is an int.

### M11.6 — Cart total application

`woocommerce_before_calculate_totals`, idempotent under repeated firing, correct under
quantity change and session restore. Verified against tax-inclusive and tax-exclusive
stores, and with a coupon applied.

### M11.7 — Adversarial test suite

Tamper attempts that must all fail: injected `price` field; modified value keys; option
keys from another product; option keys from **another tenant's** store; negative
quantities; oversized text on a per-char option; array where a scalar is expected; unicode
and emoji in text inputs; direct `?add-to-cart=` GET bypass.

**Phase 4 ran an early subset of these against the prototype, and all were repelled:**

| Attack | Result |
|---|---|
| Injected `price=1` and `delta=99999` in the POST body | Ignored — correct $80.00 |
| Sent the selection as an array (`probe_finish[]`) | Rejected; cart empty; no PHP warning |
| Unknown value (`probe_finish=HACKED`) | Rejected; cart empty |
| Negative quantity (`-5`) | Rejected by WooCommerce |
| Absurd quantity (`999999`) | Capped at 9999 by WooCommerce; no integer overflow |

The browser genuinely cannot influence price when only selection keys are trusted. This
suite extends that to every option type and every pricing model.

**Acceptance:** every attack yields either a validation error or the correct price. Never
a wrong price.

### Phase 11 exit criteria

```text
[ ] Pricing spec written and normative
[ ] PHP and TS evaluators agree on a shared fixture suite in CI
[ ] Money handled as integer minor units end-to-end
[ ] Rounding correct at boundaries; verified for 0/2/3-decimal currencies
[ ] Correct with tax inclusive and exclusive, and with coupons
[ ] Full adversarial suite passing
```

---

## Phase 12 — Cart, Checkout, Order

**Depends on:** Phase 11
**Blocks:** Gate 1

### M12.1 — Cart item data model

Persist selection keys, resolved labels, per-option price deltas, the `config_version`
used, and a selection hash. Labels are snapshotted so a rename does not rewrite history.

**WooCommerce already derives the cart item key from `cart_item_data`** — verified in
`WC_Cart::generate_cart_id()` (WC 11.0.1, `includes/class-wc-cart.php`). Different
selections therefore produce separate cart lines and identical selections merge, without
Optionia computing a key itself.

Three constraints follow from how that key is built, and violating any of them causes a
real bug:

```php
// generate_cart_id(), verbatim behaviour for cart_item_data:
foreach ( $cart_item_data as $key => $value ) {
    if ( is_array( $value ) || is_object( $value ) ) {
        $value = http_build_query( $value );   // ORDER-SENSITIVE
    }
    $cart_item_data_key .= trim( $key ) . trim( $value );
}
```

1. **Selection data must be canonically sorted before attaching.** `http_build_query` is
   order-sensitive, so the same selections in a different key order hash differently and
   produce a spurious duplicate cart line. Sort keys deterministically — this is the single
   easiest bug to introduce here.
2. **No volatile values in the payload.** A timestamp, nonce, or random id would make every
   add-to-cart a new line and break merging entirely.
3. **Nested arrays are flattened by `http_build_query`**, so deeply nested selection
   structures collide more easily. Keep the attached shape flat and explicit.

**Verified in Phase 4:** adding `luxury` then `premium` produced two lines; adding
`premium` again merged into the existing line. Totals were correct at
`(80+20) + 2 × (80+10) = 280`. WooCommerce's own `generate_cart_id()` provides this — no
custom key logic is needed, only a deterministically ordered payload.

**Variable products verified too:** variation id and option key participate in the cart
hash **independently**. Three combinations produced three distinct lines with correct
per-variation base prices:

```text
Large + Premium  →  $40.00   (variation 30.00 + option 10.00)
Small + Premium  →  $30.00   (variation 20.00 + option 10.00)
Large + Luxury   →  $50.00   (variation 30.00 + option 20.00)
```

No interference between the two mechanisms — important, since apparel with size variants
*plus* customization is a core target segment.

**Why `config_version` is stored on the line, not just referenced:** Phase 4 changed an
option's delta from $20 to $99 while an item sat in the cart, and the cart correctly kept
the **stored** $20. The captured version is what makes that possible and auditable — the
line records what it was priced against, so a later dispute or refund can be reasoned
about. See [M12.4](#m124--checkout-integrity) for the policy this enables.

**Acceptance:** adding identical selections twice yields one line with quantity 2; adding
different selections yields two lines; re-ordering the selection keys internally does **not**
create a duplicate line.

### M12.2 — Cart display

**`woocommerce_get_item_data` serves both cart worlds** — verified in WC 11.0.1:

```text
includes/wc-template-functions.php:4538        → classic cart template
src/StoreApi/Schemas/V1/CartItemSchema.php:170 → BLOCK cart (Store API)
```

Better than [AC7](#ac7--both-theme-worlds-are-first-class) assumed: one filter may cover
classic and block cart display. **Verify rather than trust it** — the block path starts from
`array()` while the template path receives populated `$item_data`, so a callback that appends
without checking could behave differently on each.

The *checkout* block is a separate question and may still need `ExtendSchema`
([M10.4](#m104--block-theme--store-api-integration)).

⚠️ **Three verified constraints on the block path** (WC 11.0.1,
`src/StoreApi/Schemas/V1/CartItemSchema.php`):

**1. Values must be scalar or the row is silently dropped.**

```php
foreach ( $data as $data_value ) {
    if ( ! is_scalar( $data_value ) ) { continue 2; }  // discards the WHOLE element
}
```

An array value — a multi-select's selections, an uploaded-file descriptor — renders fine in
classic cart and **vanishes without error in block cart**. Every value returned from
`woocommerce_get_item_data` must be a pre-formatted scalar string; join arrays before
returning.

**2. Hiding a row requires an experimental key.**
`__experimental_woocommerce_blocks_hidden` — the prefix is a stability warning. Wrap it in
one helper so a core rename is a one-line change, and cover it with a compatibility test.

**3. `wp_kses_post` is applied to every value.** Markup does not survive intact; plan for
plain text.

Readable `Label: Value (+$X)` formatting, long values truncated in display with the full
value available, mobile layout verified.

**Proven empirically in Phase 4.** The probe emitted one scalar row and one array row:

```text
classic cart path      → 2 rows   (both render, array included)
block cart Store API   → 1 row    (array row SILENTLY DISCARDED)
```

No error, no warning, no log entry. A developer testing only on a classic cart would ship
this and never see it. Use `Support\Assert::scalar()` at this boundary.

**Acceptance:** the same selection renders correctly in classic cart **and** block cart,
including a multi-select option whose value is a joined string. Cart/checkout implementation
is varied **independently of theme** — verified in M2.8 that a classic theme can and does use
block cart.

### M12.3 — Session persistence

Selections survive: page reload, cart update, quantity change, login mid-session (guest →
account cart merge), and cart recovery from a persistent cart.

### M12.4 — Checkout integrity

Re-validate the entire selection set at checkout against current cached config, because
config may have changed since add-to-cart.

🔴 **Phase 4 proved what happens without this.** A deleted option was removed from config
while it sat in a customer's cart, and checkout completed anyway:

```text
Order #32   HTTP 200   status: processing
Total:      $100.00
Meta:       "Finish: Luxury"        ← option no longer exists
```

**An option that no longer exists was charged for and sent to fulfilment.** Nothing
re-validated it. This is not theoretical: a merchant discontinues an option, and anyone
holding it in a cart still buys something the merchant cannot make.

**Two distinct policies, and they are deliberately different:**

| Situation | Policy | Reason |
|---|---|---|
| Option **price** changed since add-to-cart | Honour the `config_version` captured at add-to-cart | The customer was quoted a price; changing it under them is indefensible |
| Option **deleted**, disabled, or now invalid | **Block checkout** with a clear, actionable message | There is no honest price for something that no longer exists |

The distinction matters. Freezing price is customer-fair; freezing *validity* sells
phantom products.

**A related core behaviour, verified in Phase 4 and worth knowing:** WooCommerce follows
the **live** product base price in an existing cart. Changing a product from $80 to $200
updated the cart to $220 with no re-add — and plain WooCommerce with no plugin behaves
identically. So the base price is live while the option delta is frozen. That asymmetry is
inherited from the platform, not introduced here, and the policy above is the deliberate
choice about our half of it.

**Acceptance:** a publish between add-to-cart and checkout never silently changes what the
customer is charged; **and** a selection whose option has been deleted or disabled blocks
checkout rather than completing. Both verified by test, not assumed.

### M12.5 — Order persistence

`woocommerce_checkout_create_order_line_item` → order item meta: selections, labels,
deltas, `config_version`, option-set id. Verified with **HPOS enabled and disabled**.
Keys chosen so they render sensibly in default WooCommerce output.

### M12.6 — Merchant-facing order display

Admin order screen: a clear per-line-item option breakdown. Sufficient for fulfilment
without opening Optionia — the merchant should be able to *make the product* from the
order screen. Plus order emails, customer order-detail page, and CSV/order export
compatibility.

### M12.6b — Fulfilment output

**The plan's own MVP definition ends with "and fulfil it from the order screen"
([S4](#s4-mvp-scope--what-ships-first)) — this milestone is what makes that true.**

Merchants selling customized products do not fulfil from a screen. They fulfil from a
**printed sheet at a workbench, a laser cutter's job queue, or a file handed to a print
shop.** An option breakdown that only exists inside WordPress admin is not a fulfilment
artifact, and this is where options plugins are most often abandoned in practice.

**Required surfaces:**

| Surface | Requirement |
|---|---|
| Admin order screen | Per-line-item breakdown, grouped, readable at a glance, no truncation of engraving text |
| **Print / packing slip** | Options must appear on WooCommerce's own print output and survive the common PDF-invoice plugins |
| **Order emails** | Both merchant-notification and customer-confirmation |
| Customer order page | So the customer can verify what they ordered |
| **CSV / order export** | Options as usable columns, not a JSON blob in one cell |
| **Uploaded files** | Retrievable from the order, per [M15.5](#m155--merchant-retrieval) |

**Meta-key strategy is the mechanism.** WooCommerce order item meta renders automatically
in print output, emails, and most third-party invoice plugins — *if* the keys are
human-readable and registered conventionally. Keys chosen for developer convenience
(`_optionia_sel_a3f9`) render as noise or get hidden entirely.

```text
Order #1025 — line item: Custom T-Shirt
  Print placement:  Front            (+$10.00)
  Gift wrap:        Yes              (+$5.00)
  Engraving text:   "For Anna, 2026"
  Uploaded artwork: logo-final.ai    [download]
```

**Hidden vs. visible meta:** the human-readable pairs are visible meta; the machine data
(option keys, value keys, `config_version`, selection hash) is underscore-prefixed hidden
meta. Merchants see the first, the system reads the second, and nobody sees an id where a
label belongs.

**Long-value handling:** an engraving can be 200 characters and an uploaded filename can be
long. Neither may be truncated in print output — a truncated engraving is a wrong product
manufactured.

**Verified in Phase 4** on orders #29 and #31 (the latter a genuine `store-api` checkout),
under both storage backends. Writing via the CRUD API (`$item->add_meta_data()`) is what
made this identical under HPOS (`OrdersTableDataStore`) and legacy
(`WC_Order_Data_Store_CPT`).

⚠️ **Two separate hiding mechanisms — the underscore prefix is not enough.**

Phase 4 assumed a leading underscore hides machine payload everywhere. It does not. The
prefix governs **customer-facing** output only. On the **admin order screen** the key
appeared twice — once in the read-only meta table and once as an **editable input**:

```html
<th>_optionia_probe_data:</th>
<td><p>{"delta":2000,"key":"probe_finish",…</p></td>

<input name="meta_key[5][48]" value="_optionia_probe_data" />
```

The admin screen uses `OrderItemMetaUtil::get_hidden_keys()`, an explicit allow-list
filtered by `woocommerce_hidden_order_itemmeta`:

```php
apply_filters( 'woocommerce_hidden_order_itemmeta', array(
    '_qty', '_tax_class', '_product_id', '_variation_id',
    '_line_subtotal', '_line_total', … ) );
```

**Required in M12.5:**

1. Register every machine key via `woocommerce_hidden_order_itemmeta`, or merchants see
   raw JSON on every order.
2. Treat the payload as **untrusted on read** — it renders as an editable field, so a
   merchant can alter it by hand. Re-validate before relying on it.
3. Handle both mechanisms: underscore prefix for customer-facing output, the filter for
   the admin screen.

Verified working in customer-facing output: `get_formatted_meta_data()` returned exactly
one row (`Finish: Luxury`), and the `emails/email-order-details.php` template — the same
partial used for print — rendered it in full with no hidden key leaked.

**Acceptance:** print a packing slip from a real order and the full option detail is on it,
legible, with nothing cut off. Verified against WooCommerce's native print view **and** at
least one PDF-invoice plugin ([Phase 29](#phase-29--compatibility-matrix)).

### M12.7 — Order reporting to cloud

Post order facts to `optioniaWooCommerceBackend` (`order_events` + `order_selections`) for
[Phase 25](#phase-25--analytics). Queued and retried; **never blocking checkout**. A
failure here must be invisible to the customer.

### M12.8 — Refunds, edits, and edge cases

Partial refunds (option deltas refunded proportionally or individually — decide and
document); admin order editing with option data intact; stock handling per
[M16.9](#m169--inventory-and-stock-interaction); subscription-plugin interaction per
[M29.4](#m294--plugin-interaction-testing) Tier C.

🔴 **Order-again / reorder — proven broken in Phase 4.** Replaying a past order rejected
it outright, because the validator read `$_POST` while the selection lived in order item
meta. Full trace in [M11.5](#m115--server-side-enforcement-at-add-to-cart).

Reorder needs three things, and they compound:

1. **Read the selection from order item meta**, not `$_POST`.
2. **Re-validate against current config** — a past order may reference an option since
   deleted, renamed or repriced. This is where [M12.4](#m124--checkout-integrity)'s policy
   matters most: a stored payload is a *record*, not an authority.
3. **Reprice from current config**, not the stored delta. A reorder is a new purchase, so
   the frozen-price argument that applies mid-session does not apply here.

**Acceptance:** a customer can reorder a product with options; a reorder referencing a
deleted option fails with a message naming the option, not a generic validation error.

### Phase 12 exit criteria

```text
[ ] Selections survive cart → checkout → order → email → admin
[ ] Verified with HPOS on and off
[ ] Verified on classic checkout AND checkout blocks
[ ] Order screen alone is sufficient for fulfilment
[ ] Order facts reaching the cloud without blocking checkout
[ ] Guest and logged-in flows both correct
```

---

## Phase 13 — Minimum Builder UI

**Depends on:** Phases 7, 12; [D2](#s1-blocking-decisions)
**Blocks:** Gate 1
**Scope:** deliberately minimal — enough to author a `radio` option without curl. The
real builder is [Phase 20](#phase-20--full-builder-ui).

### M13.1 — Dashboard bootstrap

Next.js App Router + TypeScript + Tailwind + shadcn/ui + TanStack Query + RHF + Zod.
Auth, protected routes, tenant context, API client with token refresh, error boundaries.

Target route structure — built incrementally:

```text
optioniaWooCommerceFrontend/src/
├── app/
│   ├── (auth)/                     # unauthenticated
│   │   ├── login/  register/  verify-email/
│   │   └── forgot-password/  reset-password/
│   ├── (app)/                      # merchant, tenant-scoped
│   │   ├── dashboard/              # activation checklist + health
│   │   ├── option-sets/            # list · [id] builder · new
│   │   ├── products/               # catalogue + assignment
│   │   ├── rules/                  # Phase 17
│   │   ├── analytics/              # Phase 25
│   │   ├── stores/                 # connect · health · disconnect
│   │   ├── subscription/           # plan · invoices · usage
│   │   └── settings/               # profile · team · notifications
│   ├── (admin)/                    # super admin, separate guard (Phase 26)
│   │   ├── overview/  merchants/  stores/
│   │   ├── plans/  subscriptions/
│   │   └── operations/  logs/
│   └── connect/                    # Phase 8 handshake landing page
├── components/{ui,builder,forms,layout}/
├── lib/{api,auth,zod-schemas,money}/
└── hooks/
```

**Three route groups, three guard behaviours:** `(auth)` redirects away when already
authenticated; `(app)` requires a verified user with a tenant; `(admin)` requires a
platform-staff role and is **never** reachable with a merchant token.

**Every screen ships four states** — loading (skeleton, not a spinner), empty (with the
action that fills it), error (with a retry), and populated. An empty state that just says
"No data" is a defect: a merchant's first visit to every screen is the empty state, and
it is the highest-leverage onboarding surface in the product.

Responsive from the start: merchants check stores on phones. The builder
([Phase 20](#phase-20--full-builder-ui)) is the one screen allowed to be
desktop-first, and it must still be *readable* on mobile.

### M13.2 — Auth screens

Register, verify email, login, forgot/reset password, logout. Zod-validated.

### M13.3 — Store connection screen

Receive the [Phase 8](#phase-8--store-connection) handshake, show the approval prompt,
list connected stores with health (last seen, config version, plugin version), disconnect.

### M13.4 — Option set list

List, create, rename, duplicate, delete, publish. Draft/published status visible.

### M13.5 — Minimal option editor

Add a group; add a `radio` option; add values with labels and fixed prices; reorder; mark
required; save; publish. Functional, not beautiful.

### M13.6 — Product assignment picker

Search products from `store_products`, assign an option set to one or more products, show
current assignments.

### M13.7 — Shell and navigation

App shell with the navigation skeleton for the eventual full IA (Dashboard, Products,
Option Sets, Rules, Analytics, Stores, Subscription, Settings), unbuilt items disabled
rather than hidden.

### Phase 13 exit criteria

```text
[ ] Merchant registers, connects a store, and publishes a radio option in the UI
[ ] Zero curl required for the full happy path
[ ] Tenant context correct throughout
[ ] Loading, empty, and error states present on every screen
```

---

## 🚩 GATE 1 — Architecture Proven

**Nothing in Stage 3 begins until this gate passes.**

The canonical end-to-end test, executed manually and as an automated E2E:

```text
Merchant registers on Optionia
  → connects a WooCommerce store
  → creates an option set with one radio option (+$10)
  → assigns it to a product
  → publishes
  → within 30s the option appears on the live product page
  → a customer selects it
  → price is $base + $10, computed server-side
  → adds to cart, sees the option in the cart
  → checks out through the merchant's normal gateway
  → the order shows the selection with its price
  → the merchant can fulfil from the order screen alone
  → the option event appears in the cloud
```

Gate checklist:

```text
[ ] Canonical E2E test passes, automated
[ ] Zero synchronous API calls from any storefront page
[ ] Storefront works with optioniaWooCommerceBackend fully stopped
[ ] Price cannot be manipulated from the client (adversarial suite green)
[ ] Cross-tenant access impossible (isolation suite green)
[ ] Works on classic AND block themes
[ ] Works with HPOS on and off
[ ] No SaaS secret in plugin source
[ ] PHP and TS pricing engines agree in CI
[ ] docs/ARCHITECTURE.md, DATABASE.md, CONFIG-CONTRACT.md, PRICING-SPEC.md current
```

> **If any item fails, fix the architecture now.** Every subsequent phase multiplies the
> cost of these corrections.

---
---

# Part V — Stage 3: Widen The Product

**Goal:** from one option type to a competitive feature set. Every phase here rides the
Gate-1 architecture; none of them should require changing it.

---

## Phase 14 — Option Type Library

**Depends on:** Gate 1

Each type is: a registry entry + Zod schema (cloud) + renderer (plugin) + validator (both)
+ pricing behaviour + fixtures + builder UI + docs. **Same seven artifacts every time** —
if a type needs more, the registry abstraction is wrong and should be fixed rather than
special-cased.

Types are declared along the three axes from
[M5.4b](#m54b--type-model-kind-cardinality-and-presentation-as-separate-axes), so a
"single-select colour swatch" and a "multi-select colour swatch" are **one** entry in this
list with `cardinality` configurable — not two separate builds.

### M14.1 — Tier 1 (MVP)

| Presentation | `value_kind` | `cardinality` | Notes |
|---|---|---|---|
| `text_field` | text | — | length, pattern, charset validation |
| `textarea` | text | — | plus line-count limit |
| `number_field` | number | — | min/max/step/integer |
| `radio` | choice | one | ✅ built in Phase 7 |
| `dropdown` | choice | one | same engine as radio, different render |
| `checkbox` | choice | one \| many | single = a yes/no toggle; many = multi-select |
| `color_swatch` | choice | one \| many | one renderer, both cardinalities |
| `image_swatch` | choice | one \| many | one renderer, both cardinalities |

**Presentational items** (M5.4c — not options): `heading`, `paragraph`, `divider`.

That is 8 option presentations + 3 presentational items. Because cardinality is an axis,
this covers **11 of the 16 entries** a competitor's picker displays — at 8 builds.

### M14.2 — Tier 2

| Presentation | `value_kind` | `cardinality` |
|---|---|---|
| `date_picker` | date | — |
| `time_picker` | date | — |
| `datetime_picker` | date | — |
| `range` / slider | number | — |
| `quantity` | number | — |
| `hidden` | text | — |

Plus the `rich_text` presentational item — **sanitizer-gated and plan-gated** per
[M5.4c](#m54c--presentational-items-are-not-options).

### M14.3 — Tier 3

`file_input` (→ [Phase 15](#phase-15--file-upload-subsystem), `cardinality: one|many`
covering single and multi-file in one build), `swatch_grid`, `dropdown_grouped`,
`dependent_select`.

### M14.4 — Per-type validation

The complete rule catalogue. Every rule is enforced **twice** — client-side for UX,
server-side for truth — and the server is the only one that decides
([AC4](#ac4--price-is-server-authoritative-always)).

| Applies to | Rules |
|---|---|
| **All types** | `required`, `enabled`, rule-conditional requirement ([M17.4](#m174--server-side-authority)) |
| `text`, `textarea` | `min_length`, `max_length`, `pattern` (regex), `allowed_charset`, `forbidden_words`, `trim_whitespace`, line-count limit for textarea |
| `number` | `min`, `max`, `step`, `integer_only`, `allow_negative`, `decimal_places` |
| `select`, `radio` | value must exist in the option's own value set and be enabled |
| `checkbox`, `multi-checkbox` | `min_selections`, `max_selections`, mutually-exclusive value groups |
| `date`, `time`, `datetime` | `min_date`, `max_date`, `blackout_dates`, `allowed_weekdays`, `lead_time_days`, `max_advance_days`, store-timezone resolution |
| `range` | `min`, `max`, `step` |
| `quantity` | `min`, `max`, `step`, and interaction with product quantity |
| `color` | valid hex; restricted palette when the merchant defines one |
| `file-upload` | `max_size`, `min/max_files`, `allowed_mime` (content-verified), image dimension bounds — [Phase 15](#phase-15--file-upload-subsystem) |

**Regex is a security boundary.** Merchant-authored patterns run on both server and
client, so a catastrophically backtracking pattern is a denial-of-service vector. Patterns
are length-capped, compiled with a timeout where the runtime allows it, and rejected at
**publish** time if they fail a complexity check — not discovered at customer request time.

**Error messages** are per-rule and merchant-overridable, because "Invalid input" is
useless to a customer trying to buy something. Defaults are specific: *"Engraving text must
be 20 characters or fewer (you entered 24)."*

**Acceptance:** every rule has a passing test and a failing test; every failure produces a
message naming the field and the constraint; a pathological regex is rejected at publish.

### M14.4b — Per-option display and guidance configuration

Every option carries a `display` config the merchant controls. These are the affordances
that decide whether a customer **completes** the form — the difference between a
configurator that converts and one that gets abandoned mid-way. They are cheap to build and
routinely omitted.

| Setting | Purpose |
|---|---|
| `help_text` | Persistent guidance under the field — *"Max 20 characters, capitals only"* |
| `tooltip` | On-demand explanation for a term the customer may not know |
| `placeholder` | Example input, never a substitute for a label |
| `default_value` | Pre-selected value; reduces friction on the common choice |
| `character_counter` | Live `12/20` on length-limited text — **required** whenever `max_length` is set |
| `price_display` | Show as `+$10`, `$60 total`, or hidden |
| `layout` | Columns for swatches/radios; inline vs. stacked |
| `swatch_size` | Small / medium / large |
| `show_labels` | Whether swatch names render beside the swatch |
| `image` | Per-option illustrative image, distinct from image-swatch values |
| `collapsed_by_default` | For long optional sections |

**Two of these are correctness, not polish:**

- **`character_counter` with `max_length`.** Silently rejecting the 21st character of an
  engraving is a support ticket and often an abandoned cart. The counter must be present
  whenever a limit exists.
- **`default_value` interacts with `required`.** A required option with a default can never
  fail validation, which changes what "required" means. Resolve explicitly: a default
  satisfies required, and merchants are told so in the builder.

**Accessibility ties in:** `help_text` and `tooltip` must be associated via
`aria-describedby`, and a tooltip must be keyboard-reachable — see
[M29.7b](#m297b--accessibility). A tooltip only reachable by hover is invisible to a large
group of customers.

**Acceptance:** every setting round-trips config → storefront → preview identically; the
character counter appears wherever a length limit exists; `help_text` is programmatically
associated with its field.

### M14.5 — Competitive parity check

Compare the shipped list against the competitive teardown
([M1.5](#m15--competitive-teardown)). Reference point observed in a competitor's type
picker: **16 picker entries, 13 distinct types** — 5 input, 4 single-select, 3
multi-select (two of which duplicate the single-select renderers), 4 presentational.

Tier 1 + presentational items reaches effective parity at 11 builds. Any public claim about
type counts must be counted from `docs/OPTION-TYPES.md`, not estimated.

**Deliverable:** `docs/OPTION-TYPES.md` — the definitive supported list, with each entry's
three axes, validation rules, pricing support, and cart/order representation.

### Phase 14 exit criteria

```text
[ ] Every shipped type has all seven artifacts
[ ] Every type: rendered, validated, priced, cart-persisted, order-persisted
[ ] Adversarial tests extended to every new type
[ ] Type count reconciled with the pricing page
```

---

## Phase 15 — File Upload Subsystem

**Depends on:** Phase 14

> Promoted from the roadmap's "later" list to its own phase. It is **core** for
> print-on-demand and signage — two of the best-fit segments — and it is the hardest
> subsystem in the product.

### M15.1 — Storage architecture decision

| Option | For | Against |
|---|---|---|
| Optionia cloud storage (S3-compatible) | Merchant server untouched; a real recurring-value differentiator; central virus scanning | Storage cost is yours; a cloud dependency in the *purchase* path |
| Merchant's WordPress uploads | No cost to you; no cloud dependency | Fills their disk; no scanning; not a differentiator |
| Hybrid: WP first, mirrored to cloud | Resilient | Most complex |

**Recommendation: Optionia cloud storage**, with direct-to-storage presigned uploads so
the file never transits `optioniaWooCommerceBackend`. It is a genuine [D5](#d3--positioning-against-one-time-purchase-competitors)
differentiator, and it keeps print-ready artwork retrievable even if the merchant's site
is later rebuilt.

**Acceptance:** decision recorded in `docs/DECISIONS.md` with cost modelling per plan.

### M15.2 — Upload flow

Customer picks a file → plugin requests a presigned URL → browser uploads directly →
returns an opaque token → token (never a path) stored in cart item data → confirmed at
order creation.

### M15.3 — Validation and safety

Allowlisted MIME types **verified by content, not extension**; per-plan size limits; image
dimension limits; count limits; magic-byte checks; malware scanning; **SVG rejected by
default** (it is an XSS vector); EXIF stripped from images; no filename-derived paths.

### M15.4 — Lifecycle and retention

Orphan cleanup for abandoned carts (TTL); promotion to permanent on order creation;
retention policy per plan; what happens on subscription cancellation (a real customer-trust
question — must be documented, not implicit); GDPR deletion on request.

### M15.5 — Merchant retrieval

Download from the admin order screen; bulk download per order; an expiring signed link in
order emails; thumbnail previews. The merchant must be able to get **print-ready** files
without friction — this is the fulfilment path for their business.

### M15.6 — Storage accounting

Per-tenant usage into `usage_records` for [Phase 24](#phase-24--plan-limits--enforcement).

### Phase 15 exit criteria

```text
[ ] Customer uploads; merchant retrieves print-ready files from the order
[ ] Content-based MIME verification; SVG blocked; malware scanned
[ ] Orphan cleanup running; retention policy documented
[ ] Per-plan quotas enforced and metered
[ ] Cancellation behaviour for stored files documented
```

---

## Phase 16 — Advanced Pricing

**Depends on:** Phases 11, 14

### M16.1 — `percentage` of base

With the compounding and rounding semantics from `PRICING-SPEC.md` made explicit.

### M16.2 — `per_unit` and `per_char`

Quantity-driven and character-count-driven pricing (engraving). Whitespace and unicode
counting rules defined precisely.

### M16.3 — `tiered` / quantity breaks

Bracket definition, boundary behaviour (inclusive/exclusive), and interaction with product
quantity vs. option quantity.

### M16.4 — Conditional pricing

Price depending on other selections — e.g. engraving costs more on metal than on wood.
Expressed through the [Phase 17](#phase-17--conditional-logic-engine) rule engine rather
than a parallel mechanism.

### M16.5 — Constrained formula pricing

A **safe** expression evaluator: whitelisted operators and named variables only, no
`eval`, no function calls, hard iteration/complexity limits. Explicitly a security
boundary — arbitrary expressions from merchant config are evaluated on both server and
client.

### M16.6 — Negative pricing and discounts

Options that *reduce* price, with a floor at zero and interaction with coupons defined.

### M16.7 — Multi-currency

Behaviour with currency-switcher plugins; whether option prices convert or are fixed per
currency; documented and tested.

### M16.8 — Non-price line-item effects

**Price is not the only thing an option changes.** A "Heavy oak" material option changes
shipping weight. A "Digital delivery" option removes shipping entirely. A gift-wrap add-on
may sit in a different tax class. The plan currently treats price as the sole consequence of
a selection, which is wrong for exactly the merchants this product targets — furniture,
signage, and made-to-order.

Per-value modifiers, each optional:

| Modifier | Effect | Why it matters |
|---|---|---|
| `weight_delta` | Adds/sets line-item weight | Weight-based shipping rates are wrong without it |
| `sku_suffix` | Appends to the line SKU | Fulfilment and inventory systems match on SKU |
| `shipping_class` | Overrides the line's shipping class | "Oversized" options need different rates |
| `tax_class` | Overrides the line's tax class | Some add-ons are taxed differently by jurisdiction |
| `requires_shipping` | Forces a line to virtual | Digital-delivery options must not charge shipping |
| `lead_time_days` | Adds production time | Made-to-order needs an honest ship date |

**Applied at the same point as price** — `woocommerce_before_calculate_totals` for weight
and classes, so WooCommerce's own shipping and tax engines do the work rather than Optionia
reimplementing them ([AC6](#ac6--woocommerce-owns-the-transaction)).

**Ordering caution:** shipping is calculated *after* cart totals. A weight change applied
too late means the customer is quoted a shipping rate for the wrong weight — and the
merchant absorbs the difference. Verified by test, not by inspection.

**Scope:** `weight_delta` and `sku_suffix` are the two that materially affect fulfilment and
belong in Tier 1 of this phase. The rest are per-value config with clear defaults, and can
follow.

### M16.9 — Inventory and stock interaction

**The default position, stated deliberately: Optionia does not manage stock.**

Reasoning: an option is not a SKU. Modelling stock per option combination reintroduces the
exact combinatorial explosion that makes variants unusable
([S0](#s0-project-scope-and-starting-point)) — the problem this product exists to solve. A
free-text engraving has no stock. An uploaded file has no stock.

What must nonetheless be handled correctly:

- **Product-level stock still applies.** Option selection must not bypass WooCommerce's own
  stock check; a customer cannot order an out-of-stock product because they configured it.
- **Variable products:** options layer *on top of* the selected variation, and the
  variation's stock governs. Options never override it.
- **Backorder and stock status** messaging remains WooCommerce's, untouched.
- **Per-option stock is explicitly out of scope**, documented as such in
  `docs/OPTION-TYPES.md` so it is a stated boundary rather than a discovered surprise.
  Merchants who need it are asking for variants, and should use variants.

**Acceptance:** an out-of-stock product cannot be purchased through the option flow; a
variable product's variation stock is respected; the limitation is documented publicly.

### Phase 16 exit criteria

```text
[ ] All pricing types implemented in both PHP and TS
[ ] Shared fixture suite extended and green in CI
[ ] Formula evaluator sandboxed and security-reviewed
[ ] Multi-currency behaviour documented and tested
[ ] weight_delta and sku_suffix working; shipping quoted on correct weight
[ ] Stock position documented; out-of-stock cannot be bypassed
```

---

## Phase 17 — Conditional Logic Engine

**Depends on:** Phase 14

### M17.1 — Rule model

```text
IF   <conditions, matched ALL|ANY>
THEN <action> ON <target>
```

Conditions: `equals`, `not_equals`, `contains`, `greater_than`, `less_than`, `is_empty`,
`is_not_empty`, `in`, `not_in`. Targets: option, group, value. Actions: `show`, `hide`,
`require`, `unrequire`, `set_price`, `set_default`.

### M17.2 — Evaluator (both languages)

Deterministic, order-independent, cycle-safe. Shared fixtures as in
[M11.4](#m114--cross-language-fixture-suite).

### M17.3 — Cascading and cycle detection

Rules whose targets are themselves rule inputs. Fixed-point evaluation with an iteration
cap; cycles detected at **publish** time and rejected with a clear merchant-facing error.

### M17.4 — Server-side authority

Hidden options must be **rejected**, not merely invisible: if a rule hides an option, a
submitted value for it is a validation error. Conversely, conditionally-required options
are enforced only when their condition holds.

**Acceptance:** submitting a value for a rule-hidden option fails validation.

### M17.5 — Frontend rule runtime

Show/hide with no layout jank; clear values of hidden options (with a documented policy on
whether they are restored if re-shown); animate transitions; keep focus management sane.

### M17.6 — Rule builder UI

Visual condition builder, plain-language rule summaries (*"Show Engraving Text when
Engraving = Yes"*), conflict warnings, and a rule tester.

### Phase 17 exit criteria

```text
[ ] Rules evaluate identically in PHP and TS against shared fixtures
[ ] Cycles rejected at publish with an actionable message
[ ] Hidden-option submissions rejected server-side
[ ] Nested/cascading rules correct
[ ] Merchants can author rules without documentation
```

---

## Phase 18 — Option Groups & Ordering

**Depends on:** Phase 14

M18.1 group model and nesting (depth-limited); M18.2 display types (inline, accordion,
tabs, stepped/wizard); M18.3 drag-and-drop ordering across groups and options; M18.4
group-level rules and validation (e.g. "choose at least 2 from this group"); M18.5 group
presentation config (columns, swatch sizing, label placement, help text).

**Exit:** merchants can structure a complex product into legible sections; ordering
persists and renders identically in dashboard, preview, and storefront.

---

## Phase 19 — Product Sync & Assignment

**Depends on:** Phases 8, 13

### M19.1 — Initial catalogue import

Paginated pull from the WC REST API into `store_products`, resumable, progress-reported,
handling large catalogues (100k+ products) without timing out.

### M19.2 — Incremental sync via webhooks

Register `product.created|updated|deleted` webhooks → verified endpoint on
`optioniaWooCommerceBackend` → update the mirror. Signature verification mandatory
(`X-WC-Webhook-Signature`, HMAC-SHA256).

### M19.3 — Reconciliation

Scheduled diff to repair missed webhooks. Webhooks are best-effort; the mirror must be
self-healing.

### M19.4 — Assignment resolution

Product / category / tag / all-products targeting, with deterministic priority resolution
and an "effective options for this product" preview so merchants can see the result of
overlapping assignments.

### M19.5 — Bulk assignment

Multi-select, assign-by-category, assign-by-search-result, and bulk unassign — with
counts shown before applying.

### M19.6 — Deleted and unpublished products

Assignments to deleted products handled gracefully; no orphan errors on the storefront.

**Exit:** catalogue mirrored and self-healing; assignment resolution deterministic and
explainable; large catalogues performant.

---

## Phase 20 — Full Builder UI

**Depends on:** Phases 13–19

> **The competitive surface.** Per roadmap Phase 18: it must feel like a real SaaS builder,
> not a pile of CRUD forms. This is a large phase; treat each milestone as its own cycle.

M20.1 builder shell — three-pane layout (structure · editor · live preview);
M20.2 drag-and-drop composition with keyboard-accessible alternatives;
M20.3 per-type option editors driven by the type registry, not hand-written per type;
M20.4 inline value editing with bulk paste (merchants have existing lists);
M20.5 rule builder integrated in context;
M20.6 pricing editor with worked examples showing a computed sample total;
M20.7 templates and presets (T-shirt, engraving, gift wrap) — the fastest path to a
merchant's first success;
M20.8 import/export option sets as JSON, and copy between stores (a multi-store
differentiator per [D5](#d3--positioning-against-one-time-purchase-competitors));
M20.9 validation and publish UX — pre-publish checks, diff-vs-published, one-click
publish, publish history and rollback;
M20.10 autosave, undo/redo, and unsaved-change guards.

**Exit:** a merchant builds a realistic multi-group, conditional, priced option set in one
sitting without reading documentation; no data loss on navigation; publish is reversible.

---

## Phase 20b — Onboarding & Activation

**Depends on:** Phases 13, 19, 20
**Blocks:** [Gate 2](#-gate-2--feature-complete)

> The plan builds a capable product across twenty phases and then hands the merchant an
> empty dashboard. **Activation — a merchant reaching their first published option on a
> live product — is the metric the business lives or dies on**, and nothing in the plan
> owned it until here.

A merchant who signs up and does not reach a published option is worth nothing, regardless
of how good the builder is. The path from signup to first live option crosses two systems,
a WordPress install, and a plugin download; every step loses people.

### M20b.1 — The activation funnel, defined and instrumented

```text
signup → email verified → plugin installed → store connected
       → products synced → option set created → assigned → PUBLISHED
       → first customer selection → first order with options
```

Every transition is an event. **Activation = "published"**; the two steps after it are
value-realized. Instrumented from the first beta merchant, because
[Phase 33](#phase-33--closed-beta) is where the drop-off points are discovered and you
cannot discover them without the funnel.

**Acceptance:** the dashboard can answer "of merchants who signed up this month, what
fraction published?" and "where exactly do the rest stop?"

### M20b.2 — Guided setup checklist

A persistent, dismissible checklist on the dashboard home, reflecting real state rather
than a static list:

```text
✓ Create your account
✓ Install the Optionia plugin          [Download plugin]
○ Connect your store                   [Connect]  ← current step highlighted
○ Create your first option set         [Use a template]
○ Assign it to a product
○ Publish
```

Each step links directly to the action. The current step is unambiguous. Completed steps
stay visible — progress is motivating, and a merchant returning after a week needs to see
where they were.

### M20b.3 — The plugin installation path

The weakest link: the merchant is in a browser tab on `app.optionia.*` and must get a
plugin into their WordPress admin.

Provide: a direct download of the exact matching version, copy-paste install instructions
with screenshots, the WordPress.org search term once listed
([M35.2](#m352--wordpressorg-submission)), and a "I've installed it — check" button that
verifies by heartbeat rather than trusting the merchant's word.

**Acceptance:** a merchant with no WordPress experience can install and connect using only
the on-screen instructions.

### M20b.4 — Templates as the first-run path

Per [M20.7](#phase-20--full-builder-ui), starter templates (T-shirt printing, engraving,
gift wrap, made-to-order dimensions) are the fastest route to a published option.

**A merchant's first option set should be a template they adapt, never a blank canvas.**
Blank-canvas first runs are where builders lose people: the merchant does not yet know what
"option group" means, and an empty screen does not teach them.

### M20b.5 — Empty states that do the teaching

Every list screen's empty state ([M13.1](#m131--dashboard-bootstrap)) is an onboarding
surface: what this screen is for, why it matters, and one button that fills it. A merchant's
first visit to every screen is the empty state — an empty state reading "No data" is a
wasted teaching moment and a defect.

### M20b.6 — Progressive nudges

Email sequence keyed on funnel position, not elapsed time
([M6.0](#m60--transactional-email-infrastructure) templates): stalled before install,
stalled before connect, connected but nothing published, published but no selections yet.
Each nudge names the *next* action and stops on completion. Capped, and unsubscribable.

### M20b.7 — In-product help

Contextual help on the concepts that confuse first-timers — option set vs. group vs. option,
what publish does, why a price is server-calculated. Short embedded explanations rather than
a link to a docs site that loses them.

### M20b.8 — Time-to-value measurement

Measure the median time from signup to publish. Treat it as a product metric with a target
and track it per release. If it rises, something in the funnel regressed.

**Exit criteria:**

```text
[ ] Full activation funnel instrumented end to end
[ ] Guided checklist reflects real state and links to each action
[ ] Plugin install path usable without WordPress knowledge
[ ] Templates available and offered on first run
[ ] Every list screen has a teaching empty state
[ ] Nudge sequence live, funnel-keyed, capped
[ ] Median time-to-publish measured, with a target
[ ] 3 non-team testers reach publish unaided (validates M20's builder claim too)
```

---

## Phase 21 — Live Preview

**Depends on:** Phases 16, 17, 20

M21.1 preview renderer sharing the storefront's rule and pricing semantics (TS
evaluators from M11.3/M17.2 — never a second set of rules);
M21.2 desktop/tablet/mobile viewports;
M21.3 interactive preview with real rule evaluation and price computation;
M21.4 preview against a real product's base price;
M21.5 documented and tested fidelity limits (theme CSS cannot be fully reproduced).

**Exit:** preview matches storefront behaviour for rules and pricing; deviations are
documented rather than surprising.

---

## 🚩 GATE 2 — Feature Complete

```text
[ ] All committed option types shipped with the full seven artifacts each
[ ] File upload production-ready end-to-end
[ ] All pricing models correct; fixtures green in both languages
[ ] Conditional logic correct, cycle-safe, server-enforced
[ ] Product sync self-healing on a large catalogue
[ ] Builder usable without documentation (validated on 3 non-team testers)
[ ] Activation funnel instrumented; median time-to-publish measured
[ ] Fulfilment output verified on a printed packing slip
[ ] Version history + rollback working; concurrent edits 409 rather than overwrite
[ ] weight_delta/sku_suffix correct; stock position documented
[ ] Preview faithful for rules and pricing
[ ] Every pricing-page promise either delivered or corrected
[ ] Gate 1 canonical E2E still green
```

---
---

# Part VI — Stage 4: Become A Business

---

## Phase 22 — Billing Integration

**Depends on:** Gate 2; [D4](#d1--billing-provider), [D5](#d3--positioning-against-one-time-purchase-competitors)

### M22.1 — Plan definition

Define Free/Pro/Business with **enforceable** limits, reconciled against the live pricing
page ([M1.6](#m16--feature-scope-and-mvp-line)):

```text
metric              free    pro        business
option_sets         10      50         unlimited
products_assigned   20      unlimited  unlimited
option_types        tier1   tier1+2    all
file_storage_mb     100     5000       25000
conditional_rules   basic   full       full
analytics           —       basic      advanced
stores              1       3          10
team_seats          1       3          10
rich_text_html      —       —          yes
```

Every number must be **measurable in code** and metered in `usage_records`. A limit that
cannot be measured cannot be sold.

### M22.2 — `BillingProvider` abstraction

An interface — `createCheckout`, `getSubscription`, `cancelSubscription`,
`updatePlan`, `verifyWebhook` — so [D4](#d1--billing-provider) is reversible.

### M22.3 — Provider implementation

The chosen provider behind the interface: products/prices, checkout session, customer
portal, proration on plan change, trial handling, tax configuration.

### M22.4 — Subscription lifecycle in the app

Trial → active → past_due → grace → cancelled → reactivated. `subscriptions` is updated
**only** from verified webhooks ([Phase 23](#phase-23--billing-webhooks)), never from a
browser redirect.

### M22.5 — Billing UI

Plan comparison, upgrade/downgrade with proration preview, payment method management,
invoice history, cancellation with reason capture, and current usage vs. limits.

### M22.6 — Free tier design

Per [D5](#d3--positioning-against-one-time-purchase-competitors), the free tier must be
**genuinely useful** — a real store running real options — because these merchants must
trust the cloud dependency before they will pay monthly.

**Exit:** a merchant subscribes, upgrades, downgrades, and cancels; state is always
webhook-derived; every plan limit is measurable.

---

## Phase 23 — Billing Webhooks

**Depends on:** Phase 22

M23.1 signature-verified endpoint, raw-body preserved for verification;
M23.2 idempotent processing via the UNIQUE `billing_events.provider_event_id`;
M23.3 handlers for created/updated/cancelled/payment_succeeded/payment_failed/
trial_will_end/invoice_paid;
M23.4 async processing with retry, and dead-lettering to the admin ops view
([Phase 26](#phase-26--super-admin));
M23.5 replay/reconciliation tooling — a scheduled diff of provider state vs. local state
so a missed webhook cannot silently strand a paying merchant on the wrong plan.

**Exit:** all lifecycle events handled idempotently; duplicate delivery is a no-op;
provider and local state provably reconciled; **no subscription state is ever derived from
a browser redirect**.

---

## Phase 24 — Plan Limits & Enforcement

**Depends on:** Phases 22, 23

### M24.1 — Usage metering

Count option sets, assigned products, storage, stores, **team seats**, and API calls into
`usage_records`.

Seats count **accepted members plus pending invitations** — otherwise a tenant can exceed
its seat limit by holding invitations open. Roles do not change the seat cost: a `viewer`
occupies a seat like an `owner` does.

### M24.2 — Limit enforcement at write time

Guards on creation paths, with actionable errors (*"Free plan allows 10 option sets. You
have 10. Upgrade to Pro for 50."*).

### M24.3 — The lapse policy — **decide before production**

Per roadmap Phase 24, the governing principle is: **do not unexpectedly break an existing
merchant storefront.**

```text
Payment fails
  → grace period (14 days), full function, escalating notices
  → grace expires: dashboard becomes READ-ONLY,
                   storefront KEEPS WORKING on the last published config,
                   new/changed configuration blocked
  → after 30 more days: storefront rendering disabled with 7 days' notice
  → data retained 90 days, then deleted per the retention policy
```

The storefront-keeps-working rule is deliberate. Breaking a merchant's live store over a
failed card is how a SaaS earns a permanent reputation problem in the WordPress community.

**Deliverable:** `docs/SUBSCRIPTION-POLICY.md`, published to merchants **before** launch.

### M24.4 — Downgrade handling

Over-limit state after a downgrade: block new creation, keep existing working, prompt for
explicit choices about what to disable. Never silently delete merchant work.

### M24.5 — Plugin-side awareness

Config document carries plan state so the plugin can show accurate notices; enforcement
decisions remain server-side.

**Exit:** limits enforced with clear messaging; the full lapse lifecycle tested end-to-end;
no scenario in which a paid, then lapsed, then recovered merchant loses configuration.

---

## Phase 25 — Analytics

**Depends on:** Phases 12, 22

M25.1 event ingestion (option views, selections, add-to-cart, order) — batched from the
plugin, never blocking a page render;
M25.2 aggregation pipeline into rollup tables (scheduled, not query-time);
M25.3 merchant analytics: option revenue, most/least selected values, attach rate,
conversion with vs. without options, revenue per option set;
M25.4 comparisons over time and per product;
M25.5 CSV export;
M25.6 privacy — no PII in analytics, GDPR-compatible, documented retention.

Per roadmap Phase 25, analytics must answer real merchant decisions: *which options make
money, which are ignored, what should be priced differently.* Not vanity charts. This is
also a core [D5](#d3--positioning-against-one-time-purchase-competitors) differentiator —
self-hosted plugins cannot compute it.

**Exit:** a merchant can identify their highest-revenue options and their dead ones;
ingestion never affects storefront performance.

---

## Phase 26 — Super Admin

**Depends on:** Phases 22–25

M26.1 tenant list with health, plan, usage, and revenue;
M26.2 store list with connection status, plugin/WP/WC versions, last seen, stale-install
detection;
M26.3 **operations queue** — failed webhooks, failed syncs, failed connections, failed
billing events, with retry and dismiss (roadmap Phase 30's admin surface);
M26.4 impersonation for support, audit-logged and consent-gated;
M26.5 plan and feature-flag management;
M26.6 platform metrics — MRR, churn, activation funnel, feature adoption.

**Exit:** support can diagnose and resolve a merchant issue without database access;
every failure class has a visible queue and a retry path.

---

## Phase 26b — Data Protection & Compliance

**Depends on:** Phases 12, 15, 25
**Blocks:** [Gate 3](#-gate-3--launch-ready)

> Not a documentation task. GDPR and similar regimes require **working mechanisms**, and
> the plan references them in five places without ever building them. This phase builds
> them.

**The exposure is structural:** Optionia is a **data processor** for its merchants (who are
controllers of their own customers' data), and a **controller** for merchant account data.
Customer option selections routinely contain personal data — an engraving with a name, a
gift message, an uploaded photo, a delivery date. That means real obligations, and merchants
in the EU will ask about them during evaluation.

### M26b.1 — Data inventory and classification

Every field the system stores, classified: personal data / pseudonymous / non-personal,
with its lawful basis, retention period, and location.

Particular attention to the places personal data arrives unannounced: `order_selections`
values, uploaded files ([Phase 15](#phase-15--file-upload-subsystem)), `audit_logs` IP
addresses, analytics events, and email delivery logs.

**Deliverable:** `docs/DATA-INVENTORY.md` — the record of processing activities that a DPA
requires you to have.

### M26b.2 — Merchant data export

A merchant can export **everything** Optionia holds for their tenant — account, stores,
option sets, rules, assignments, order facts, analytics — in a machine-readable archive,
self-service from the dashboard, without a support ticket.

This is a data-portability right and also a **sales asset**: "you can take your data and
leave whenever you want" directly answers the lock-in half of
[D3](#d3--positioning-against-one-time-purchase-competitors).

**Acceptance:** self-service export completes for a large tenant; the archive is complete
enough to reconstruct their configuration elsewhere.

### M26b.3 — Deletion and erasure

Three distinct operations, each specified separately because they mean different things:

| Operation | Effect |
|---|---|
| **Merchant deletes their account** | Configuration deleted; anonymized aggregate analytics may be retained; documented grace window before irreversible deletion |
| **End-customer erasure request** (via the merchant) | Personal data in `order_selections` and uploaded files erased; the order fact survives in anonymized form so the merchant's revenue reporting is not corrupted |
| **Retention expiry** | Scheduled job deletes data past its stated retention period without anyone asking |

Erasure must reach **every** copy: primary tables, object storage, analytics rollups,
backups (documented policy — backups typically age out rather than being surgically
edited), email logs, and the merchant's plugin cache.

**Acceptance:** an erasure request provably removes personal data from every store listed
in the inventory, and the merchant's reporting still balances afterwards.

### M26b.4 — WordPress privacy tool integration

WordPress ships core personal-data export and erasure hooks
(`wp_privacy_personal_data_exporters`, `wp_privacy_personal_data_erasers`). The plugin
**must** register with them — merchants use WordPress's own privacy tools to service
requests, and a plugin that hides data from those tools silently breaks their compliance.

**Acceptance:** WordPress's built-in export and erase produce Optionia option data for a
given customer email.

### M26b.5 — Consent and telemetry

Explicit opt-in for any plugin telemetry, defaulting to **off**. Clear disclosure of
exactly what leaves the merchant's site — required for WordPress.org
([M35.2](#m352--wordpressorg-submission)) and simply honest. No cookies set on the
merchant's storefront without a documented purpose; nothing that would drag the merchant
into a cookie-consent obligation they did not choose.

### M26b.6 — Legal instruments

A Data Processing Agreement merchants can actually sign, sub-processor list (email
provider, object storage, billing provider, error tracking), international-transfer basis,
a breach-notification procedure with defined timelines, and privacy policy plus terms that
match what the code actually does.

**Deliverable:** `docs/DATA-PROTECTION.md`, plus the published DPA.

**Exit criteria:**

```text
[ ] Data inventory complete and accurate
[ ] Self-service merchant export working
[ ] All three deletion operations implemented and tested
[ ] WordPress privacy hooks registered and verified
[ ] Telemetry opt-in, defaulting off, fully disclosed
[ ] DPA published; sub-processors listed
[ ] Retention jobs running
[ ] Privacy policy matches implemented behaviour
```

---
---

# Part VII — Stage 5: Production Hardening

---

## Phase 27 — Security Audit

**Depends on:** Gate 2

### M27.1 — API security review

Auth, authz, tenant isolation (re-run the M6.6 suite), input validation on every DTO,
rate limiting per tenant and per IP, SQL injection (parameterized everywhere), mass
assignment (`forbidNonWhitelisted` verified), IDOR sweep across every `:id` route, JWT
handling (expiry, rotation, revocation), CORS allowlist, security headers, no secrets in
logs or error responses.

### M27.2 — Plugin security review

**The highest-risk surface — it runs on infrastructure you do not control, and a
vulnerability here compromises merchants' stores, not just yours.**

Nonces on every admin action; capability checks on every privileged path; `sanitize_*` on
every input; `esc_*` on every output; `$wpdb->prepare()` on every query; no `eval`; safe
deserialization; SSRF review of every outbound call; file-upload hardening (Phase 15);
no information disclosure in debug output; secure token storage; TLS verification never
disabled; safe handling of a hostile API response.

### M27.3 — Dashboard security review

XSS (including in merchant-authored labels rendered in preview), CSRF, token storage,
dependency audit, CSP.

### M27.4 — Storefront security review

Options rendered on public pages with merchant-controlled content: every label,
description, and value escaped; no injection via option config; the formula evaluator
(M16.5) sandboxed and re-reviewed here.

### M27.5 — Webhook security

Signature verification on **every** inbound webhook (WooCommerce and billing); timing-safe
comparison; replay protection; raw-body integrity.

### M27.6 — Third-party review

An external penetration test or security review before public launch. Findings triaged and
blockers fixed.

### M27.7 — Security documentation

`docs/SECURITY.md`, a vulnerability disclosure policy and contact, and an incident
response plan.

**Exit:** every item above verified and documented; external review passed with no
unresolved high or critical findings; `SECURITY.md` published.

---

## Phase 28 — Performance

**Depends on:** Gate 2

M28.1 storefront budget — Optionia adds **<50ms** to server render and **<50KB** to
transferred bytes on an options-enabled product page; measured, not estimated;
M28.2 Core Web Vitals — no CLS from option rendering, no LCP regression; this affects the
**merchant's SEO** and is therefore a sales objection, not just an engineering metric;
M28.3 API performance — index review, N+1 elimination, config generation cached and
served with ETags;
M28.4 sync efficiency — 304s on unchanged config, gzip, incremental product sync;
M28.5 dashboard performance — code splitting, virtualized long lists, builder
responsiveness with 100+ options;
M28.6 load testing — 1,000 stores syncing, a 100k-product catalogue, a 200-option set;
M28.7 caching-plugin compatibility — WP Rocket, W3TC, LiteSpeed, Cloudflare APO,
Varnish; correctness with page caching and with option markup fragment-cached.

**Exit:** budgets met and enforced in CI; verified under load; correct behind the common
caching stack.

---

## Phase 29 — Compatibility Matrix

**Depends on:** Gate 2

> WooCommerce is not one target. It is WordPress × WooCommerce × PHP × theme × page
> builder × caching × currency × other option plugins. This is the product's real cost
> center. Per roadmap Phase 28: **do not promise universal compatibility.**

M29.1 version matrix (WP, WC, PHP — supported ranges, tested combinations, minimums);
M29.2 theme testing (Storefront, Twenty Twenty-Four/Five, Astra, Kadence, Flatsome,
Woodmart);
M29.3 page builders (Elementor, Divi, Bricks, WPBakery, Gutenberg);
M29.5 HPOS, block cart/checkout, and the classic path — all verified. **Theme and
cart/checkout implementation are orthogonal axes** and must be varied independently: M2.8
verified that a *classic* theme (Storefront) ships *block* cart and checkout by default, so
"tested on Storefront" proves nothing about which cart path ran;
M29.6 mobile and cross-browser;
M29.7 the published, honest matrix.

### M29.4 — Plugin interaction testing

**The largest support-cost driver in the product.** Optionia modifies the cart line price —
which puts it in direct contention with every other plugin that does the same. These
conflicts are not hypothetical; they are the daily reality of shipping on WooCommerce.

Tested in **three tiers**, so the matrix can be honest about what is supported versus merely
known:

**Tier A — must work (blocks launch)**

| Category | Examples | Specific risk |
|---|---|---|
| Page caching | WP Rocket, W3TC, LiteSpeed, Cloudflare APO | A cached product page serving stale or cross-customer option state |
| PDF invoice / packing slip | WooCommerce PDF Invoices, WPO | Options missing from the fulfilment document ([M12.6b](#m126b--fulfilment-output)) |
| Security / firewall | Wordfence, Sucuri | Outbound API calls or the connect handshake blocked |
| Minification | Autoptimize, and the caching plugins' own | The frontend runtime broken by JS concatenation |

**Tier B — should work (documented, best effort)**

| Category | Specific risk |
|---|---|
| Currency switchers (WOOCS, Aelia) | Whether option prices convert or are fixed per currency ([M16.7](#m167--multi-currency)) |
| Multilingual (WPML, Polylang) | Option labels untranslatable, or duplicated per language |
| Bookings / appointments | Both plugins competing to own the date field |
| Composite / bundle products | Nested line items where option data must not be lost |
| Checkout field editors | Interference with the block/classic checkout paths |

**Tier C — known incompatible (stated plainly)**

| Category | Why |
|---|---|
| **Competing option plugins** | Two plugins modifying the same line price will produce a wrong total. Detect on activation and warn the merchant explicitly. |
| **Subscription plugins** | A recurring line whose price came from an option raises real questions — does the option persist on renewal, can it be changed mid-term? Out of scope at launch; **detected and disclosed**, not silently broken. |

**Active conflict detection**, not just documentation: on activation and in System Status,
detect known-conflicting plugins and surface a specific, actionable notice. A merchant who
installs Optionia alongside an existing options plugin must be told *before* their storefront
prices go wrong — not after a customer is charged incorrectly.

**Deliverable:** the tier assignments in `docs/COMPATIBILITY.md`, and a conflict-detection
list maintained as new conflicts are reported through
[M32.6](#m326--support-operations).

### M29.7b — Accessibility

**Target: WCAG 2.1 Level AA** for both the storefront renderer and the merchant dashboard.

This is not optional politeness. Optionia renders **on the merchant's public storefront**,
which means an inaccessible option group makes the *merchant's* store inaccessible — and in
several jurisdictions exposes the merchant to legal risk they did not sign up for. An
options plugin that blocks a screen-reader user from completing a purchase is costing the
merchant money.

**Storefront requirements:**

- Every input has a programmatically associated label; groups use `fieldset`/`legend`
- Required state conveyed by `aria-required`, not colour or an asterisk alone
- Validation errors linked with `aria-describedby`, announced via a live region, and focus
  moved to the first invalid field on submit
- Rule-driven show/hide announced to assistive tech, not a silent DOM mutation
  ([M17.5](#m175--frontend-rule-runtime))
- Price changes announced politely as options are selected
- Full keyboard operability — swatches and image options are the usual failure, since a
  `div` with a click handler is invisible to a keyboard
- Contrast ≥ 4.5:1 for text; a colour swatch never the *only* means of conveying a choice
- Custom controls carry correct roles and states; native elements preferred wherever they
  will do
- Zoom to 200% without loss of function

**Dashboard requirements:** the same baseline, plus a keyboard-accessible alternative to
every drag-and-drop interaction ([M20.2](#phase-20--full-builder-ui)) — drag-only reordering
is an accessibility dead end.

**Verification, not assumption:** automated axe-core pass in CI, plus **manual testing with
a real screen reader** (VoiceOver and NVDA) on the storefront purchase flow. Automated tools
catch roughly a third of real issues; the keyboard-and-screen-reader walkthrough of
"select options → add to cart" is the test that matters.

**Deliverable:** `docs/ACCESSIBILITY.md` — conformance statement plus known limitations.

**Acceptance:** a customer can complete a full option selection and add-to-cart using only
a keyboard and a screen reader; axe-core clean in CI; contrast verified.

### M29.8 — Internationalization and localization

WooCommerce is heavily used outside English-speaking markets. A plugin with hardcoded
English strings is unusable for a large part of the addressable market, and retrofitting
i18n after the UI exists means touching every template.

**Plugin (PHP/JS):** every user-facing string through `__()` / `_e()` / `esc_html__()`
with the `optionia` text domain; `load_plugin_textdomain()` on init; a generated `.pot` in
`languages/`; **no string concatenation** for sentences (word order differs by language);
`_n()` for plurals; dates and numbers via WordPress locale functions, never hardcoded
formats.

**Currency:** always `wc_price()` and the store's own currency settings — never a
hardcoded `$` or a hardcoded decimal separator. Verified against a store configured in
EUR with comma decimals and a JPY store with zero decimals.

**RTL:** logical CSS properties (`margin-inline-start`, not `margin-left`); verified in
Arabic or Hebrew with an RTL theme.

**Merchant-authored content:** option labels and descriptions are the *merchant's* strings,
not ours — never machine-translated, and stored/rendered as UTF-8 (`utf8mb4` end to end, so
emoji and CJK in labels survive). Compatibility with WPML/Polylang for translating option
labels is documented, and tested if supported.

**Dashboard:** i18n-ready structure even if only English ships at launch — externalized
strings, no concatenation, locale-aware dates and numbers.

**Acceptance:** the plugin renders correctly in a non-English RTL locale on a store using
a comma decimal separator; no untranslatable user-facing string remains; `utf8mb4` verified
end to end with emoji in an option label.

**Deliverable:** `docs/COMPATIBILITY.md` — a narrow, tested, honest matrix. Untested is
labelled untested.

**Exit:** matrix published; every "supported" entry actually tested; known incompatibilities
documented with workarounds.

---

## Phase 30 — Test Suite

**Depends on:** all feature phases

M30.1 API unit tests — services, evaluators, guards;
M30.2 API integration tests — every endpoint, auth, **the permanent tenant isolation
suite**;
M30.3 plugin unit tests (PHPUnit) — engine functions, config parsing, validation;
M30.4 plugin integration tests (WP test suite) — hooks, cart, order, HPOS;
M30.5 cross-language fixture suites for pricing and rules, green in CI;
M30.6 dashboard tests — components, forms, the builder;
M30.7 the canonical E2E suite (Playwright): Gate 1's flow, plus billing, plus lapse,
run against a real WooCommerce install;
M30.8 CI pipeline — everything on every PR, matrix across supported PHP/WP/WC versions;
M30.9 the adversarial suites (price tampering, tenant isolation, upload abuse) as
permanent CI jobs.

### M30.10 — Failure and recovery testing

Distinct from functional testing. Functional tests prove the happy path works; these prove
the **unhappy paths degrade the way the plan promises**. Every row below has a *defined
expected behaviour* that is asserted, not merely observed.

| Failure injected | Required behaviour |
|---|---|
| `optioniaWooCommerceBackend` unreachable | Storefront renders from cache; no customer-visible error; admin notice; backoff retry |
| API returns 500s | Circuit breaker opens; cache served; recovery on close |
| API returns malformed JSON | Rejected by schema validation; previous good config retained; alerted |
| API returns a *newer* `schema_version` | Last good config kept; update notice ([M9.5](#m95--schema-version-negotiation)) |
| Database unavailable (cloud) | Dashboard degrades with a clear error; storefronts unaffected |
| Store token revoked mid-operation | 401 → `REVOKED` state; cache still served; reconnect prompt |
| Duplicate billing webhook | Idempotent no-op via UNIQUE `provider_event_id` |
| Billing webhook arrives out of order | Later `updated_at` wins; state never regresses |
| Billing webhook never arrives | Reconciliation job ([M23.5](#phase-23--billing-webhooks)) repairs state |
| WooCommerce product webhook missed | Reconciliation diff repairs the mirror ([M19.3](#m193--reconciliation)) |
| Product deleted while assigned | Assignment orphaned gracefully; no storefront error |
| Option deleted after orders exist | Historic orders still readable (snapshotted labels, [M12.1](#m121--cart-item-data-model)) |
| Option renamed after orders exist | Historic orders show the original label |
| Config published mid-checkout | Add-to-cart `config_version` honoured ([M12.4](#m124--checkout-integrity)) |
| Network timeout on order reporting | Queued and retried; **checkout unaffected** |
| Upload fails mid-transfer | Cart item invalid until re-uploaded; no partial file promoted |
| WordPress cron not running | Manual "Sync now" works; staleness surfaced in System Status |
| WooCommerce deactivated while active | No fatal error; site stays up ([M3.3](#m33--woocommerce-dependency-guard)) |
| Plugin downgraded below config schema | Refuses to render unparseable config; asks for update |
| Cloned staging site | Site-URL change detected; re-authorization required ([M8.1b](#m81b--connection-state-machine)) |
| Two admins publish simultaneously | Optimistic concurrency; second sees a conflict, not a silent overwrite |
| Subscription lapses mid-session | Storefront keeps working; dashboard goes read-only ([M24.3](#m243--the-lapse-policy--decide-before-production)) |
| Clock skew between plugin and cloud | Signed-timestamp tolerance window documented and tested |

**Method:** a fault-injection harness — a proxy that can force timeouts, 5xx responses,
malformed bodies, and slow responses on demand; plus a WP-CLI command to force each
plugin-side state.

**Acceptance:** every row asserted in an automated test. **No failure mode may produce a
customer-visible error on a storefront** — that is the hard line.

**Deliverable:** `docs/FAILURE-MODES.md` — the table above with the actual observed
behaviour recorded per row.

**Exit:** CI green and required for merge; the canonical E2E runs on every release;
coverage meaningful on pricing, rules, tenancy, and cart/order — the four places a bug
costs real money.

---

## Phase 31 — Monitoring

**Depends on:** Phase 34 infra decisions

M31.1 error tracking (Sentry or equivalent) across API, dashboard, and plugin — plugin
errors reported only with merchant consent;
M31.2 uptime and synthetic monitoring of the config endpoint and the canonical flow;
M31.3 business alerting — sync failure rate, webhook failure rate, connection failures,
billing failures, unusual price-validation rejection rates (a tampering signal);
M31.4 structured logging with request correlation IDs spanning plugin → API;
M31.5 the ops dashboard fed into [Phase 26](#phase-26--super-admin)'s queue;
M31.6 an on-call runbook per alert.

**Exit:** every failure class alerts before merchants report it; every alert has a runbook.

---

## Phase 32 — Documentation

**Depends on:** Gate 2

```text
docs/
├── installation.md         ├── ARCHITECTURE.md
├── getting-started.md      ├── DATABASE.md
├── merchant-guide.md       ├── SECURITY.md
├── option-builder.md       ├── CONFIG-CONTRACT.md
├── pricing.md              ├── PRICING-SPEC.md
├── conditional-logic.md    ├── OPTION-TYPES.md
├── file-uploads.md         ├── COMPATIBILITY.md
├── troubleshooting.md      ├── SUBSCRIPTION-POLICY.md
├── api.md                  ├── DECISIONS.md
└── developer.md            └── CHANGELOG.md
```

M32.1 merchant docs (task-oriented, screenshotted);
M32.2 developer docs (hooks/filters the plugin exposes for theme developers — a real
adoption lever in the WordPress ecosystem);
M32.3 architecture docs kept current;
M32.4 support content — troubleshooting, FAQ, and the help-center content the marketing
site already links to;
M32.5 legal — privacy policy covering data flows and file storage, ToS, DPA, GDPR
statement (the instruments themselves are built in
[Phase 26b](#phase-26b--data-protection--compliance)).

### M32.6 — Support operations

Support is the largest ongoing cost in a WooCommerce product
([Phase 29](#phase-29--compatibility-matrix) explains why: you run on thousands of
environment combinations you do not control). Build the apparatus before merchants arrive,
not after they are waiting.

**Intake:** a support channel per plan tier with a stated response time, and a form that
captures the System Status output ([M3.6](#m36--logging-and-diagnostics)) automatically —
because the first three round-trips of every ticket are otherwise spent asking for versions.

**Diagnosis path**, in order of escalation:

```text
1. System Status panel        (merchant self-serve; plugin/WP/WC/PHP, config version, cache)
2. Super admin store view     (M26.2 — last seen, connection state, plugin version)
3. Operations queue           (M26.3 — did a sync or webhook fail for this store?)
4. Error tracking             (Phase 31 — correlated by request ID)
5. Consented impersonation    (M26.4 — audit-logged)
```

**Ticket taxonomy**, tracked so the top categories drive the roadmap rather than anecdote:
installation · connection · theme conflict · plugin conflict · pricing question · billing ·
performance · bug · feature request.

**Known-issues register** — public, honest, with workarounds. Merchants forgive a
documented limitation and resent an undocumented one.

**Escalation and on-call:** what a support agent can resolve alone, what reaches
engineering, and what constitutes an incident ([Phase 31](#phase-31--monitoring) runbooks).

**Feedback loop:** monthly review of ticket categories against the failure-mode table
([M30.10](#m3010--failure-and-recovery-testing)) and the compatibility matrix. A category
that keeps recurring is a product defect, not a support workload to absorb.

**Deliverable:** `docs/SUPPORT-PLAYBOOK.md`

**Exit:** a merchant can self-serve installation → first published option set; support has
an article for every common failure; legal documents reflect the actual data flows.

---

## 🚩 GATE 3 — Launch Ready

```text
[ ] Security audit passed; external review clean of high/critical
[ ] Data protection complete — export, erasure, DPA, WP privacy hooks
[ ] Accessibility: WCAG 2.1 AA verified with a real screen reader
[ ] Transactional email deliverable; SPF/DKIM/DMARC verified
[ ] Support playbook ready; intake channel live
[ ] Performance budgets met and CI-enforced
[ ] Compatibility matrix published and honest
[ ] Full test suite green in CI; canonical E2E green
[ ] Monitoring and alerting live with runbooks
[ ] Documentation complete
[ ] Subscription policy published
[ ] Billing tested end-to-end including failure and lapse
[ ] Every pricing-page claim true
[ ] Rollback plan for plugin and API
```

---
---

# Part VIII — Stage 6: Launch

---

## Phase 33 — Closed Beta

**Depends on:** Gate 3

M33.1 recruit 5–10 real WooCommerce merchants across the target segments (print-on-demand,
engraving/jewelry, furniture/made-to-order, gifts, signage) — **not** friends, and
ideally including one current competitor user, because that is where the
[D5](#d3--positioning-against-one-time-purchase-competitors) objection surfaces honestly;
M33.2 an onboarding protocol with an observed first session — watching where they get
stuck is the highest-value data in the whole project;
M33.3 the beta test plan (install, connect, build, assign, publish, real customer orders,
subscription);
M33.4 structured feedback plus telemetry on where merchants abandon;
M33.5 triage as Blocker / Critical / High / Medium / Low; **all blockers and criticals
fixed before launch**;
M33.6 iteration cycles — expect two or three;
M33.7 validate the positioning: did any beta merchant balk at recurring pricing, and what
changed their mind?

**Exit:** at least 5 merchants completed the full flow on live stores with real orders; all
blockers and criticals resolved; onboarding time measured and acceptable; the recurring-pricing
objection has a tested answer.

---

## Phase 34 — Production Deploy

**Depends on:** Phase 33

### M34.1 — Infrastructure topology

Provisioned fresh for this project. A single modest droplet plus a managed MySQL instance
is adequate for launch — the config endpoint is the only hot path, and it caches well.

Target topology:

```text
                        ┌──────────────┐
                        │  Cloudflare  │  TLS · CDN · WAF · rate limiting
                        └───────┬──────┘
                                │
                     ┌──────────┴──────────┐
                     │  nginx (reverse      │  TLS termination, gzip/brotli,
                     │  proxy)              │  static assets, per-IP limits
                     └──────────┬───────────┘
                  ┌───────────┴───────────┐
                  ▼                       ▼
      optioniaWooCommerceFrontend   optioniaWooCommerceBackend
              (Next.js)                   (NestJS)
                                          │
              ┌───────────┬───────────┬───┴────────┐
              ▼           ▼           ▼            ▼
           MySQL       Redis    Object store    Worker
        (managed,     (cache +   (S3-compatible, (queue consumer)
         backups,      queue)     uploads)
         private net)
```

**Add now** (each has a concrete trigger, not "best practice"):

- **nginx reverse proxy** — TLS termination, gzip/brotli on config responses (they compress
  extremely well), static asset serving, and per-IP rate limiting in front of the app
- **Redis** — the `/store/config` ETag/response cache. Every merchant store polls this
  endpoint; serving it from MySQL at scale is needless load on the one database that must
  never fall over
- **Job queue + worker** (`optioniaWooCommerceWorker`) — webhook processing, product sync,
  analytics rollups, and order-fact ingestion must not run in the request path. This is
  what keeps [M12.7](#m127--order-reporting-to-cloud)'s promise that a reporting failure
  never touches checkout
- **Object storage** — [Phase 15](#phase-15--file-upload-subsystem) uploads, with
  presigned direct-to-storage so files never transit the API

**Defer until measured:** read replicas, horizontal API scaling, multi-region. The config
endpoint is the hot path; cache it well and one instance goes a long way.

**Repository additions:** `optioniaWooCommerceWorker` (queue consumer, shares the `optioniaWooCommerceBackend`
entity layer) and optionally `optioniaWooCommerceDocs`.

**Isolation requirement:** this project's infrastructure is provisioned independently —
its own droplet or app instances, its own managed database, its own object storage, its own
DNS records. It shares nothing with any other project, so no unrelated deploy can affect
merchant storefronts.

M34.1b remaining infrastructure — managed database with automated backups and private-network-only
access ([M0.4](#m12--environment-topology)), object storage, monitoring agents;
M34.2 environment topology — local, staging (a real WooCommerce store), production —
with genuinely separate credentials, extending
[M1.2](#m12--environment-topology) to production;
M34.3 deployment pipeline — CI/CD, migrations gated and reversible, zero-downtime
deploys, tagged releases;
M34.4 backups and disaster recovery — automated backups, **tested restores**, documented
RTO/RPO;
M34.5 scaling readiness — the config endpoint is the hot path; CDN/edge caching by ETag,
horizontal API scaling, read replicas if needed;
M34.6 secrets management — env-injected, rotated on a schedule, never in source,
never a default value; continuous verification of the [M1.1](#m11--repository-and-tooling-setup)
scanning guarantee;
M34.7 the launch runbook and a rollback plan.

**Exit:** production running with monitoring, backups, tested restores, and CI/CD; staging
mirrors production; no secret in any repository.

---

## Phase 35 — Plugin Distribution

**Depends on:** Phase 34

### M35.1 — Distribution model

```text
Free Optionia plugin  +  Optionia SaaS account  +  paid subscription
```

### M35.2 — WordPress.org submission

Prepare `readme.txt`, assets, and screenshots; **read the current plugin review
guidelines carefully** — plugins whose primary function depends on a paid external
service face specific scrutiny around service disclosure, opt-in data transmission, and
not being "a wrapper for a commercial service." The free tier from
[M22.6](#m226--free-tier-design) matters here: it is both a funnel and a compliance
posture.

**Have a fallback:** self-hosted distribution with an update server, in case review is
declined or slow.

### M35.3 — Plugin release and update infrastructure

**Versioning:** semantic versioning, with the version declared in exactly two places that
must never disagree — the plugin header and a `OPTIONIA_VERSION` constant. A release check
asserts they match.

**Release artifacts, every release:**

```text
readme.txt          WordPress.org format: description, installation, FAQ,
                    changelog, "Tested up to", external-service disclosure
CHANGELOG.md        Keep-a-Changelog format, human-written, not commit dump
Screenshots         assets/screenshot-1..n.png — builder, product page,
                    cart, order screen (the four things merchants judge on)
Banner + icon       WordPress.org asset dimensions
Installation guide  Including the connect step, which is where merchants stall
Support pointers    Where to get help, and expected response time
Compatibility       The tested matrix (Phase 29), stated honestly
```

**Upgrade safety** — the part that breaks merchant sites if rushed:

- `Activation\Migrator` runs schema upgrades keyed on the stored `optionia_db_version`
- Every migration idempotent and forward-only; the previous version's data is readable
- **Backward-compatible config handling:** an old plugin against a newer cloud must
  degrade, never break ([M9.5](#m95--schema-version-negotiation))
- **Forward-compatible cloud:** the cloud continues serving the last N config schema
  versions, so a merchant who never updates keeps working
- Cached config validated after upgrade; refetched if the shape changed
- Rollback tested: install N, upgrade to N+1, downgrade to N, confirm the store still sells

**Release checklist**, run every time:

```text
[ ] Version bumped in both locations and they match
[ ] CHANGELOG updated
[ ] "Tested up to" reflects actual testing
[ ] Full test suite green on the supported PHP/WP/WC matrix
[ ] Upgrade path tested from the two previous versions
[ ] Downgrade tested (storefront must keep working)
[ ] Fresh-install tested on a clean site
[ ] PHPCS clean; no debug output
[ ] Tagged in Git; artifact built reproducibly
```

**Distribution fallback:** if WordPress.org review stalls or declines, a self-hosted
update server is required — implemented behind the same `update_plugins` filter so the
merchant experience is identical either way. Build this regardless: it is also the channel
for beta releases to [Phase 33](#phase-33--closed-beta) merchants.

### M35.4 — Compliance and legal

Privacy policy covering exactly what data leaves the merchant's site; explicit opt-in for
telemetry; GDPR data-processing terms; licensing (GPL-compatible for the plugin).

### M35.5 — Launch assets

Marketing/landing presence for Optionia WooCommerce; product documentation; a public demo
store a prospect can click through without signing up; support channels staffed and
monitored.

### M35.6 — Launch ladder and post-launch

Do not go from closed beta to public launch in one step:

```text
Closed beta (Phase 33)      5–10 hand-held merchants, self-hosted plugin build
        ↓  all blockers + criticals fixed
Public beta                 open signup, free tier only, "beta" labelled,
                            plugin self-hosted or WP.org pending
        ↓  onboarding completion rate acceptable, no new criticals for 2 weeks
Paid launch                 paid tiers enabled, billing live
        ↓  MRR and churn observable, support load sustainable
Marketing push              WooCommerce directory, content, partnerships
        ↓
Scale
```

**Gate between public beta and paid launch:** merchants must be completing onboarding
without hand-holding. Charging before that is how you buy churn and refund requests.

**Post-launch operations:**

- Support SLA per plan tier, staffed and measured
- Bug triage on the Blocker/Critical/High/Medium/Low scale from
  [M33.5](#phase-33--closed-beta)
- Public roadmap — meaningful in the WordPress ecosystem, where merchants evaluate
  whether a plugin is actively maintained before they depend on it
- Predictable release cadence, with security fixes out of band
- Monthly review of the failure-mode table ([M30.10](#m3010--failure-and-recovery-testing))
  against what actually happened in production

**Exit:** plugin installable by any merchant; update path working; legal complete;
marketing reflects both platforms; support ready.

---
---

# Appendix A — Why The Sequence Changed

### Change 1 — the core domain is built once

**Roadmap:** Phases 5–9 build the option engine, pricing engine, rule engine, groups, and
assignment **inside the WordPress plugin**. Phases 10–20 then build the same engines in
NestJS and have the plugin consume them.

**Problem:** that is the core domain twice, and the second build is not a port — different
language, different data model, different trust boundary. It also collides with the
roadmap's own **Rule 12** (*keep WooCommerce-specific code isolated from generic SaaS
business logic*): Phases 5–9 put business logic into the plugin, and Phases 15–20 pull it
back out.

**This plan:** authoring lives in NestJS from [Phase 7](#phase-7--option-authoring-api).
PHP keeps exactly three pure evaluators ([AC2](#ac2--the-plugin-evaluates-it-never-authors)),
which genuinely must be local because the trusted price calculation cannot depend on a
network call. Divergence is prevented by the shared cross-language fixture suite
([M11.4](#m114--cross-language-fixture-suite)), not by discipline.

### Change 2 — the architecture is proven before it is widened

**Roadmap:** the full SaaS/plugin architecture is not exercised end-to-end until ~Phase 20,
with 19 phases of work already committed to it.

**This plan:** [Gate 1](#-gate-1--architecture-proven) drives **one** option type through
the real architecture — cloud authoring, signed connection, cached sync, PHP evaluation,
order persistence — before option type #2 exists. If the sync model, the trust boundary, or
the cache design is wrong, it is found while it is still cheap.

### Change 3 — Phase 0 was dropped entirely

Both spec documents open with a Phase 0 that analyzes an existing implementation on another
platform and extracts reusable business logic from it. **This project is greenfield**
([S0](#s0-project-scope-and-starting-point)) — there is nothing to extract. Phase numbering
starts at 1.

What replaces it is more useful: [Phase 1](#phase-1--foundations--decisions) sets up the
repositories with secret hygiene and CI from the first commit, settles the three decisions
that gate later work ([D1](#d1--billing-provider)–[D3](#d3--positioning-against-one-time-purchase-competitors)),
and does a competitive teardown ([M1.5](#m15--competitive-teardown)) — which supplies the
design input that a prior implementation would otherwise have provided, and does it from
the products merchants are actually comparing against.

### Change 4 — decisions were pulled forward

Both spec documents defer the billing-provider choice ("select based on target countries")
to the billing phase, and neither addresses free-tier shape or competitive positioning at
all. All three are now [Phase 1](#phase-1--foundations--decisions) decisions, because they
affect company setup, tax obligations, plan-limit numbers, and how beta merchants are
recruited. Deciding them at Phase 22 means discovering a constraint after twenty phases of
work assume otherwise.

### Change 5 — three items were promoted

- **File upload** — roadmap "later"; here [Phase 15](#phase-15--file-upload-subsystem).
  Core for print-on-demand and signage; the hardest subsystem in the product.
- **Block themes / Store API** — roadmap Phase 28 (compatibility); here
  [AC7](#ac7--both-theme-worlds-are-first-class) and designed into Phases 10 and 12.
  Retrofitting a second rendering path late is expensive.
- **Billing provider choice** — roadmap "decide later"; here
  [D4](#d1--billing-provider), decided in Phase 1, because it affects entity structure,
  tax obligations, and the pricing page.

### Change 6 — six items added after cross-review

A cross-review against `OptioniaWooCommerceDeveloperMasterMilestone.md` surfaced six
genuine gaps, now closed:

| Added | Where | Why it matters |
|---|---|---|
| **MVP scope** | [S4](#s4-mvp-scope--what-ships-first) | Without an explicit line, every phase becomes launch-blocking and the product never ships |
| **API contract-first** | [M7.7](#m77--api-contract-written-before-implementation) | The plugin is a client you cannot redeploy across thousands of merchant sites; the contract must precede the code |
| **Connection state machine** | [M8.1b](#m81b--connection-state-machine) | Ambiguous connection state is the #1 support-ticket generator in this product category |
| **Centralized API client** | [M3.5b](#m35b--centralized-api-client) | Scattered HTTP calls means drifting timeout/retry behaviour; one missing timeout hangs a page render |
| **Failure/recovery testing** | [M30.10](#m3010--failure-and-recovery-testing) | Functional tests prove the happy path; these prove degradation matches the promises |
| **i18n/l10n** | [M29.8](#m298--internationalization-and-localization) | WooCommerce is heavily non-English; retrofitting i18n means touching every template |

### Change 7 — six cross-cutting concerns added

A second audit pass found six things referenced but never built. Each is now an owned
milestone or phase:

| Added | Where | Why |
|---|---|---|
| **Transactional email** | [M6.0](#m60--transactional-email-infrastructure) | Verification, invites, and dunning all depend on it; nothing provisioned it |
| **Data protection / GDPR** | [Phase 26b](#phase-26b--data-protection--compliance) | GDPR was named in five places and implemented in none; export and erasure are mechanisms, not sentences |
| **Onboarding & activation** | [Phase 20b](#phase-20b--onboarding--activation) | The plan built a product then handed merchants an empty dashboard; activation is the metric the business lives on |
| **Accessibility (WCAG 2.1 AA)** | [M29.7b](#m297b--accessibility) | Optionia renders on the *merchant's* public storefront; inaccessible options make their store inaccessible |
| **Support operations** | [M32.6](#m326--support-operations) | The largest ongoing cost in a WooCommerce product; needs apparatus before merchants arrive |
| **Seed & demo fixtures** | [M5.10](#m510--migrations-seeds-and-fixtures) | Without realistic data, the screens that break under real load break in front of a merchant |

### Change 8 — competitor teardown findings folded in

Analysis of a live competitor's option-set builder (2026-08-21) produced four model
corrections, now in the plan:

| Finding | Where | Consequence |
|---|---|---|
| Cardinality is an **axis**, not a type | [M5.4b](#m54b--type-model-kind-cardinality-and-presentation-as-separate-axes) | Single- and multi-select swatches are one build, not two — 16 picker entries covered by 8 builds |
| Presentational items are **not options** | [M5.4c](#m54c--presentational-items-are-not-options) | Discriminated union instead of nullable columns; five subsystems stop null-checking |
| Assignment needs a **conditional** mode | [M5.5](#m55--assignment-model) | New products inherit option sets automatically; a manual list goes stale |
| Merchant-authored HTML is an **XSS boundary** | [M5.4c](#m54c--presentational-items-are-not-options) | Allowlist sanitizer at publish *and* render; plan-gated |

### Change 9 — roles and permissions were specified

Both spec documents name `owner/admin/member` and stop there. Neither defines a capability,
and neither separates merchant identity from platform-staff identity — a serious omission in
a multi-tenant SaaS where staff can see every tenant.
[M6.5](#m65--roles-and-permission-matrix) now defines three isolated identity realms, two
full capability matrices, and six enforcement rules.

### Change 10 — five domain gaps closed on final audit

| Added | Where | Why it mattered |
|---|---|---|
| **Fulfilment output** | [M12.6b](#m126b--fulfilment-output) | The MVP definition says "fulfil from the order screen" — nothing built it. Merchants fulfil from *printed* sheets; meta-key strategy decides whether options appear there at all |
| **Non-price effects + stock** | [M16.8](#m168--non-price-line-item-effects), [M16.9](#m169--inventory-and-stock-interaction) | Options change weight, SKU, shipping and tax class — not just price. Weight applied late means the customer is quoted the wrong shipping and the merchant eats it |
| **Version history + rollback** | [M7.4](#m74--publish-versioning-and-rollback) | Publish existed; undo did not. A merchant who breaks their store at 9pm and can revert in one click does not churn |
| **Concurrency control** | [M7.4b](#m74b--concurrency-control) | The failure-mode table promised "409, not silent overwrite" — nothing implemented it. Losing an afternoon's work to a colleague's save is unforgivable in an authoring tool |
| **Per-option display config** | [M14.4b](#m144b--per-option-display-and-guidance-configuration) | Help text, tooltips, character counters, defaults. Cheap to build, routinely omitted, and they decide whether customers finish the form |
| **Plugin conflict tiers** | [M29.4](#m294--plugin-interaction-testing) | Was one dismissive line. This is the biggest support-cost driver; now three tiers plus **active conflict detection** so a merchant is warned before prices go wrong |

### Change 11 — security and testing were distributed

The roadmap parks them in Phases 26 and 29. Here each phase carries its own security items
and its own tests, and Phases 27/30 are *audits* of work already done rather than the first
time anyone thinks about it.

---

# Appendix B — Roadmap Phase Mapping

Every roadmap phase is accounted for. Nothing was dropped.

| Roadmap | This plan |
|---|---|
| 0 — Prior-platform analysis | **Dropped** — greenfield project; replaced by [Phase 1](#phase-1--foundations--decisions) foundations + [M1.5](#m15--competitive-teardown) teardown |
| 1 — Environment ✅ | Complete; context in [Phase 2](#phase-2--woocommerce-competence) |
| 2 — Learn WooCommerce | [Phase 2](#phase-2--woocommerce-competence) (+ M2.8 block themes) |
| 3 — Plugin fundamentals | [Phase 3](#phase-3--plugin-skeleton) |
| 4 — Option prototype | [Phase 4](#phase-4--throwaway-prototype) (explicitly disposable; **narrowed** — see note below) |
| 5 — Option engine | [Phase 7](#phase-7--option-authoring-api) (cloud) + [14](#phase-14--option-type-library) |
| 6 — Pricing engine | [Phase 11](#phase-11--pricing-engine) + [16](#phase-16--advanced-pricing) |
| 7 — Conditional logic | [Phase 17](#phase-17--conditional-logic-engine) |
| 8 — Option groups | [Phase 18](#phase-18--option-groups--ordering) |
| 9 — Product assignment | [Phase 19](#phase-19--product-sync--assignment) |
| 10 — NestJS backend | [Phase 5](#phase-5--data-model--migrations) (moved earlier) |
| 11 — Multi-tenancy | [Phase 6](#phase-6--tenancy--auth) + [AC5](#ac5--tenant-isolation-is-enforced-at-the-data-access-layer) |
| 12 — MySQL architecture | [Phase 5](#phase-5--data-model--migrations) |
| 13 — SaaS auth | [Phase 6](#phase-6--tenancy--auth) |
| 14 — Store connection | [Phase 8](#phase-8--store-connection) (moved earlier) |
| 15 — SaaS ↔ plugin sync | [Phase 9](#phase-9--config-sync--cache) |
| 16 — Product sync | [Phase 19](#phase-19--product-sync--assignment) |
| 17 — Next.js dashboard | [Phase 13](#phase-13--minimum-builder-ui) → [20](#phase-20--full-builder-ui) |
| 18 — Option builder | [Phase 20](#phase-20--full-builder-ui) |
| 19 — Preview | [Phase 21](#phase-21--live-preview) |
| 20 — Storefront renderer | [Phase 10](#phase-10--storefront-renderer) |
| 21 — Cart/checkout/order | [Phase 12](#phase-12--cart-checkout-order) |
| 22 — Billing | [Phase 22](#phase-22--billing-integration) |
| 23 — Billing webhooks | [Phase 23](#phase-23--billing-webhooks) |
| 24 — Subscription enforcement | [Phase 24](#phase-24--plan-limits--enforcement) |
| 25 — Analytics | [Phase 25](#phase-25--analytics) |
| 26 — Security | [Phase 27](#phase-27--security-audit) + per-phase items |
| 27 — Performance | [Phase 28](#phase-28--performance) + [AC3](#ac3--the-product-page-never-blocks-on-optionia) |
| 28 — Compatibility | [Phase 29](#phase-29--compatibility-matrix) + [AC7](#ac7--both-theme-worlds-are-first-class) |
| 29 — Testing | [Phase 30](#phase-30--test-suite) + per-phase tests |
| 30 — Monitoring | [Phase 31](#phase-31--monitoring) + [Phase 26](#phase-26--super-admin) |
| 31 — Documentation | [Phase 32](#phase-32--documentation) |
| 32 — Beta | [Phase 33](#phase-33--closed-beta) |
| 33 — Production | [Phase 34](#phase-34--production-deploy) |
| 34 — Distribution | [Phase 35](#phase-35--plugin-distribution) |
| — | **New:** [15](#phase-15--file-upload-subsystem) file uploads, [26](#phase-26--super-admin) super admin, [M1.5](#m15--competitive-teardown) competitive teardown |

#### Note — Phase 4 was deliberately narrowed

`OptioniaWooCommerceDeveloperMasterMilestone.md` specifies a broader Phase 4 than what was
built, and the difference is intentional:

| | Master Milestone M4.2–M4.3 | Built in Phase 4 |
|---|---|---|
| Input types | radio, checkbox, select, text, number | **radio only** |
| Validation | required, min/max length, min/max value | **whitelist only** |

**Reasoning.** The throwaway's purpose is to learn the *data path* — render → validate →
price → cart → session → checkout → order → fulfilment output — not to cover option types.
Five input types would have exercised five renderers against the same single data path,
adding time without adding information.

Type coverage properly belongs to [Phase 14](#phase-14--option-type-library), where the
three-axis model ([M5.4b](#m54b--type-model-kind-cardinality-and-presentation-as-separate-axes))
makes each type a registry entry rather than a bespoke build. Validation rules belong to
[M14.4](#m144--per-type-validation), which specifies the full catalogue including the regex
complexity limits that a Phase 4 prototype could not meaningfully test.

The narrowing was the right call: one option type through the real lifecycle found **four
wrong assumptions**. Five option types through a shallower lifecycle would have found
fewer.

### Also mapped from `OptioniaWooCommerceDeveloperMasterMilestone.md`

That document's independent numbering maps as follows. Items it covered that this plan
originally lacked are marked **★**.

| Master Milestone | This plan |
|---|---|
| 16 — API Contract | ★ [M7.7](#m77--api-contract-written-before-implementation) |
| 17 — Plugin API Client | ★ [M3.5b](#m35b--centralized-api-client) |
| 15 — Connection lifecycle states | ★ [M8.1b](#m81b--connection-state-machine) |
| 39 — Failure/Recovery Testing | ★ [M30.10](#m3010--failure-and-recovery-testing) |
| 53 — MVP Scope | ★ [S4](#s4-mvp-scope--what-ships-first) |
| 46/47/48 — Structure trees | [M5.1](#m51--bootstrap-optioniawoocommercebackend), [M13.1](#m131--dashboard-bootstrap), [M3.1](#m31--repo-and-plugin-scaffold) |
| 49 — Canonical option config | [M7.5](#m75--config-document-contract) (versioned, with money as minor units) |
| 43 — Backup/DR | [M34.4](#phase-34--production-deploy) |
| 33 — Operational error system | [Phase 26](#phase-26--super-admin) M26.3 ops queue |
| 30 — Usage and limits | [Phase 24](#phase-24--plan-limits--enforcement) |
| 38 — E2E testing | [Gate 1](#-gate-1--architecture-proven) canonical flow + [M30.7](#phase-30--test-suite) |
| 58 — Implementation order | Superseded by the risk-ordered staging + gates |

---

# Appendix C — Master Checklist

```text
OPTIONIA FOR WOOCOMMERCE
════════════════════════════════════════════════

STAGE 0 — FOUNDATIONS
[~] Phase 1  — Foundations & Decisions      (M1.1/M1.2/M1.7 done in Phase 5 Step 0;
                                            D1/D2/D3 deferred — need business input)

STAGE 1 — LEARN THE PLATFORM
[x] Phase 2  — WooCommerce Competence      (M2.7b practice plugin skipped)
[x] Phase 3  — Plugin Skeleton             (34/34 checks, 6/6 guards)
[x] Phase 4  — Throwaway Prototype         (8 design rules, 4 corrections)

STAGE 2 — THE VERTICAL SLICE
[ ] Phase 5  — Data Model & Migrations
[ ] Phase 6  — Tenancy & Auth
[ ] Phase 7  — Option Authoring API
[ ] Phase 8  — Store Connection
[ ] Phase 9  — Config Sync & Cache
[ ] Phase 10 — Storefront Renderer
[ ] Phase 11 — Pricing Engine
[ ] Phase 12 — Cart, Checkout, Order
[ ] Phase 13 — Minimum Builder UI
[ ] 🚩 GATE 1 — ARCHITECTURE PROVEN

STAGE 3 — WIDEN THE PRODUCT
[ ] Phase 14 — Option Type Library
[ ] Phase 15 — File Upload Subsystem
[ ] Phase 16 — Advanced Pricing
[ ] Phase 17 — Conditional Logic Engine
[ ] Phase 18 — Option Groups & Ordering
[ ] Phase 19 — Product Sync & Assignment
[ ] Phase 20 — Full Builder UI
[ ] Phase 20b— Onboarding & Activation
[ ] Phase 21 — Live Preview
[ ] 🚩 GATE 2 — FEATURE COMPLETE

STAGE 4 — BECOME A BUSINESS
[ ] Phase 22 — Billing Integration
[ ] Phase 23 — Billing Webhooks
[ ] Phase 24 — Plan Limits & Enforcement
[ ] Phase 25 — Analytics
[ ] Phase 26 — Super Admin
[ ] Phase 26b— Data Protection & Compliance

STAGE 5 — PRODUCTION HARDENING
[ ] Phase 27 — Security Audit
[ ] Phase 28 — Performance
[ ] Phase 29 — Compatibility Matrix
[ ] Phase 30 — Test Suite
[ ] Phase 31 — Monitoring
[ ] Phase 32 — Documentation
[ ] 🚩 GATE 3 — LAUNCH READY

STAGE 6 — LAUNCH
[ ] Phase 33 — Closed Beta
[ ] Phase 34 — Production Deploy
[ ] Phase 35 — Plugin Distribution
```

---

# Appendix D — Working With This Plan

### The milestone loop

```text
Read the milestone in this file
  → inspect the current code
  → plan, and get the plan reviewed
  → implement
  → test against the acceptance criteria
  → verify the Definition of Done
  → commit
  → next milestone
```

### Prompt template

```text
We are building Optionia for WooCommerce.

Read developePlan.md, then OptioniaStartRoadmap.md for scope context.

Current position:
  PHASE <n> — <name>
  MILESTONE <n.m> — <name>

Before writing code, inspect the repository and explain:
  1. Current relevant structure
  2. How this milestone fits the Architecture Contract (S2)
  3. Proposed implementation
  4. Files that will change
  5. How it will be tested against the stated acceptance criteria

Do not modify code yet.
```

Then, after the plan is reviewed:

```text
Implement the approved approach.

  - Do not modify unrelated files
  - Follow the conventions in S3
  - Honour the Architecture Contract in S2
  - Add validation and security where required
  - No hardcoded secrets, no production fallbacks
  - Explain every changed file
  - Give exact local testing steps
```

And on completion:

```text
The milestone is working.

Verify the Definition of Done (S3).
Update affected documentation.
Give a concise completion summary.
Do not start the next milestone.
```

### Guardrails

1. **Never skip a Gate.** The gates exist to catch architectural error while it is cheap.
2. **Never let the plugin author configuration** ([AC2](#ac2--the-plugin-evaluates-it-never-authors)).
3. **Never trust the client for price** ([AC4](#ac4--price-is-server-authoritative-always)).
4. **Never let a storefront depend on a live API call** ([AC3](#ac3--the-product-page-never-blocks-on-optionia)).
5. **Never break a merchant's storefront** — not on lapse, not on revocation, not on
   downtime.
6. **Never ship a secret in the plugin** ([AC8](#ac8--no-saas-secret-ever-ships-inside-the-plugin)).
7. **Record every architectural decision** in `docs/DECISIONS.md`.
8. When this plan and reality disagree, **update this plan** — it is a living document.

---

**End of plan.**
