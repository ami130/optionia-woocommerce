# Optionia WooCommerce SaaS — Complete Development Roadmap

**Project:** Optionia for WooCommerce  
**Architecture:** Multi-tenant SaaS + WooCommerce Plugin  
**Frontend:** Next.js + TypeScript  
**Backend:** NestJS + TypeScript  
**Database:** MySQL  
**WooCommerce Integration:** WordPress/WooCommerce Plugin (PHP + JS)  
**Billing:** Recurring SaaS subscription  
**Development Style:** Milestone-based, test-driven, Claude AI assisted

---

## 0. Product Vision

Optionia is a SaaS platform for WooCommerce merchants that allows merchants to create advanced product options/customizations and attach them to WooCommerce products.

Example:

```text
Custom T-Shirt
Base price: $50

Color
○ Black
○ White
○ Blue

Print
○ None
○ Front +$10
○ Front & Back +$20

Gift Wrapping
□ +$5

Engraving
□ Yes
```

A customer selects options before adding the product to the cart.

Example:

```text
Product                 $50
Front print             $10
Gift wrapping            $5
--------------------------------
Total                   $65
```

The customer continues through the merchant's normal WooCommerce cart and checkout.

### Business model

Optionia is NOT only a WordPress plugin.

It is a SaaS platform:

```text
Merchant
   ↓
Optionia account
   ↓
Connect WooCommerce store
   ↓
Create/manage product options
   ↓
Optionia WooCommerce Plugin
   ↓
Customer selects options
   ↓
WooCommerce cart/checkout/order
```

Merchants pay Optionia a recurring monthly/annual SaaS subscription.

The merchant's customer payment for products remains handled by the merchant's WooCommerce payment system.

---

# 1. High-Level Architecture

```text
                         OPTIONIA CLOUD
                              │
              ┌───────────────┴────────────────┐
              │                                │
              ▼                                ▼
       Next.js Dashboard                 Super Admin
              │                                │
              └───────────────┬────────────────┘
                              │
                              ▼
                         NestJS API
                              │
             ┌────────────────┼─────────────────┐
             │                │                 │
             ▼                ▼                 ▼
           MySQL           Billing           Webhooks
             │
             ▼
       Multi-Tenant SaaS
             │
             ▼
   WooCommerce Connections
             │
             ▼
   Optionia WooCommerce Plugin
             │
             ▼
        WooCommerce Store
             │
             ▼
          Customer
```

---

# 2. Recommended Repositories

Keep the project separated into three repositories:

```text
optionia-dashboard
optionia-api
optionia-woocommerce
```

### `optionia-dashboard`

Next.js SaaS merchant dashboard and super-admin interface.

### `optionia-api`

NestJS API, authentication, multi-tenancy, business logic, integrations, billing, webhooks, etc.

### `optionia-woocommerce`

WordPress/WooCommerce plugin written primarily in PHP with JavaScript/CSS where required.

---

# 3. Technology Stack

## SaaS Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod

## Backend

- NestJS
- TypeScript
- TypeORM
- MySQL
- JWT/session authentication
- REST API
- Webhooks
- Background jobs where needed

## WooCommerce Plugin

- PHP
- WordPress Plugin API
- WooCommerce hooks/actions/filters
- WooCommerce APIs
- JavaScript
- CSS
- REST API
- Webhooks

## Billing

Use a payment provider that supports recurring SaaS subscriptions and webhooks. The exact provider should be selected after researching the countries, currencies, merchant audience, tax requirements, and platform policies that apply to Optionia.

---

# 4. Core Product Responsibilities

## Optionia Cloud

The SaaS should be responsible for:

- Users
- Authentication
- Tenants
- Stores
- Subscription plans
- Merchant subscriptions
- Option configuration
- Option groups
- Conditional rules
- Pricing configuration
- Product assignments
- Analytics
- Usage/limits
- Centralized configuration
- Store connection management
- Webhook processing
- Super-admin management

## WooCommerce Plugin

The plugin should be responsible for:

- WooCommerce dependency detection
- Store connection
- Secure communication with Optionia
- Product-page integration
- Rendering customer options
- Customer selection handling
- Cart integration
- Checkout integration
- Order metadata
- WooCommerce-specific logic
- Local/cache synchronization where appropriate

### Important architecture rule

Do NOT duplicate the entire SaaS inside the WordPress plugin.

Keep Optionia Cloud as the central SaaS platform and the plugin as the WooCommerce integration/bridge.

---

# 5. Development Rules

These rules apply throughout the project.

1. Do not build the entire project in one AI prompt.
2. Work phase-by-phase and milestone-by-milestone.
3. Before changing code, inspect the existing repository.
4. Do not modify unrelated files.
5. Explain architectural changes before implementing large changes.
6. Use database migrations.
7. Do not rely on `synchronize: true` in production.
8. Never trust prices or configuration supplied by the browser.
9. Validate data on the server/plugin side.
10. Enforce tenant isolation on every SaaS resource.
11. Never put private SaaS secrets directly inside the public plugin.
12. Keep WooCommerce-specific code isolated from generic SaaS business logic.
13. Test every milestone before moving to the next.
14. Commit working milestones to Git.
15. Keep documentation updated as architecture changes.
16. Prefer small, reversible changes over large rewrites.

---

# PHASE 0 — Existing Shopify Optionia Analysis

**Status:** Existing Shopify version

Before recreating the product for WooCommerce, document the existing Shopify implementation.

## Milestone 0.1 — Feature Inventory

Document:

- Existing features
- Merchant flow
- Customer flow
- Option builder
- Product assignment
- Pricing
- Rules
- Dashboard
- Subscription
- Analytics
- Authentication
- APIs
- Database entities
- Webhooks
- Shopify-specific code

## Milestone 0.2 — Separate Business Logic from Shopify Logic

Classify every major feature as:

```text
Reusable business logic
OR
Shopify-specific integration
```

## Milestone 0.3 — Platform Mapping

Create a mapping:

| Shopify | WooCommerce |
|---|---|
| App | Plugin |
| App installation | Plugin installation |
| Shopify store | WooCommerce store |
| Shopify product | WooCommerce product |
| App API | Optionia API |
| Shopify webhook | WooCommerce webhook |
| App embed | Product-page/plugin integration |
| Shopify billing | External SaaS billing |

---

# PHASE 1 — WooCommerce Development Environment

**Status: COMPLETE**

Completed:

- Install WordPress Studio
- Create local Optionia WordPress site
- Open WordPress Admin
- Install WooCommerce
- Solve local MailPoet/SQLite issue
- Configure basic WooCommerce environment
- Create test product/store
- Understand basic cart/checkout/order flow

Target environment:

```text
WordPress Studio
    ↓
optionia
    ↓
WordPress
    ↓
WooCommerce
    ↓
Storefront/test theme
```

### Milestone 1 — COMPLETE

---

# PHASE 2 — Learn WooCommerce as a Developer

Before implementing the SaaS, understand the platform Optionia will integrate with.

## Milestone 2.1 — WordPress Fundamentals

Learn:

- WordPress structure
- Plugins
- Themes
- Admin
- Users
- Settings
- Database
- Hooks
- Actions
- Filters
- Shortcodes
- REST API
- Nonces
- Capabilities
- Cron

## Milestone 2.2 — WooCommerce Fundamentals

Learn:

- Products
- Simple products
- Variable products
- Product variations
- Attributes
- Categories
- Cart
- Checkout
- Orders
- Customers
- Coupons
- Payments
- Shipping
- Taxes
- Webhooks

## Milestone 2.3 — Product Experiment

Create:

```text
Simple Product
Variable Product
Attributes
Variations
```

## Milestone 2.4 — Order Experiment

Complete:

```text
Product
 ↓
Cart
 ↓
Checkout
 ↓
Order
 ↓
Admin Order
```

## Milestone 2.5 — WooCommerce Hooks

Learn how WooCommerce exposes integration points.

Understand:

- Actions
- Filters
- Product hooks
- Cart hooks
- Checkout hooks
- Order hooks

## Milestone 2.6 — APIs

Understand:

- WooCommerce REST API
- WordPress REST API
- WooCommerce Store API
- Authentication
- API permissions

## Milestone 2.7 — Webhooks

Understand:

```text
WooCommerce event
      ↓
Webhook
      ↓
Optionia API
```

### Phase 2 Exit Criteria

You should be able to explain how a WooCommerce product becomes a cart item and then an order, and where a plugin can safely modify that lifecycle.

---

# PHASE 3 — WooCommerce Plugin Fundamentals

Create:

```text
optionia-woocommerce
```

First goal: build a tiny working plugin.

## Milestone 3.1 — Basic Plugin

Create a plugin that appears under:

```text
WordPress
 ↓
Plugins
 ↓
Optionia
```

## Milestone 3.2 — Activation/Deactivation

Implement:

- Activation
- Deactivation
- Dependency checks

## Milestone 3.3 — Admin Menu

Create:

```text
Optionia
 ├── Dashboard
 └── Settings
```

## Milestone 3.4 — Assets

Learn and implement:

- PHP enqueueing
- JavaScript
- CSS
- Admin assets
- Frontend assets

## Milestone 3.5 — WooCommerce Dependency

If WooCommerce is inactive:

```text
Optionia requires WooCommerce.
```

The plugin should fail gracefully rather than causing fatal errors.

---

# PHASE 4 — First Product Option Prototype

Before SaaS integration, build a local proof of concept.

Example:

```text
Product
$50

Test Option

○ Standard
○ Premium +$10
○ Luxury +$20
```

Customer selects:

```text
Luxury
```

Cart:

```text
Product       $50
Luxury        $20
----------------
Total         $70
```

## Milestone 4.1

Render a test option on a WooCommerce product page.

## Milestone 4.2

Capture customer selection.

## Milestone 4.3

Calculate additional price.

## Milestone 4.4

Send selected data to cart.

## Milestone 4.5

Display selected option in cart.

## Milestone 4.6

Preserve option during checkout.

## Milestone 4.7

Save option into order data.

## Milestone 4.8

Display option in WooCommerce admin order.

### Phase 4 Exit Criteria

A customer can select an option, pay through the normal WooCommerce checkout, and the merchant can see the selected option inside the order.

---

# PHASE 5 — Option Engine

Build the actual option system.

Initial option types:

```text
Text
Textarea
Radio
Checkbox
Select
Number
Color
Image
```

Later:

```text
File upload
Date
Time
Quantity
```

Each option should support:

- Label
- Description
- Required/optional
- Default value
- Validation
- Display configuration
- Pricing configuration
- Conditional rules

---

# PHASE 6 — Pricing Engine

Build a deterministic pricing engine.

Initial pricing types:

```text
Fixed price
Percentage
Quantity-based
Conditional price
```

Example:

```text
Base product = $100

Option A = +$10
Option B = +10%
Quantity = 2
```

## Critical rule

Never trust a frontend-calculated price.

The trusted calculation must happen in the plugin/backend according to the stored configuration.

---

# PHASE 7 — Conditional Logic

Example:

```text
Do you want engraving?

○ No
○ Yes
```

If Yes:

```text
Engraving text
[____________]
```

Architecture:

```text
Condition
   ↓
Evaluate
   ↓
True?
 ├── YES → Show option
 └── NO  → Hide option
```

Build a reusable rule engine instead of hardcoding individual cases.

---

# PHASE 8 — Option Groups

Allow merchants to organize options:

```text
Product
 ├── Color
 ├── Size
 ├── Material
 ├── Customization
 └── Gift Options
```

Each group can have:

- Options
- Pricing
- Rules
- Validation
- Display configuration
- Ordering

---

# PHASE 9 — Product Assignment

Allow merchants to assign an option set to:

- One product
- Multiple products
- Product categories
- Other supported product collections/groupings

Example:

```text
Option Set: Premium Customization

Products:
 ├── T-Shirt
 ├── Hoodie
 └── Jacket
```

---

# PHASE 10 — NestJS SaaS Backend

Create the backend repository:

```text
optionia-api
```

Recommended module structure:

```text
src/
├── auth/
├── users/
├── tenants/
├── stores/
├── subscriptions/
├── plans/
├── products/
├── option-groups/
├── options/
├── rules/
├── pricing/
├── integrations/
├── webhooks/
├── analytics/
└── common/
```

Do not create every module at once. Build them according to milestones.

---

# PHASE 11 — Multi-Tenant SaaS Architecture

This is one of the most important parts.

Example:

```text
Merchant A
 └── Store A
      └── Options A

Merchant B
 └── Store B
      └── Options B
```

Merchant A must NEVER be able to access Merchant B's data.

Recommended ownership chain:

```text
User
 ↓
Tenant
 ↓
Store
 ↓
OptionGroup
 ↓
Option
```

Every API query must enforce tenant/store ownership.

---

# PHASE 12 — MySQL Architecture

Initial logical entities:

```text
users
tenants
stores
plans
subscriptions

woocommerce_connections

products
option_groups
options
option_rules
option_values

store_option_assignments

orders
order_options

webhooks
api_keys

usage_records
audit_logs
```

Do not build all tables immediately.

Create tables as modules are implemented.

Use migrations.

---

# PHASE 13 — SaaS Authentication

Merchant journey:

```text
Optionia
 ↓
Sign Up
 ↓
Email verification
 ↓
Login
 ↓
Dashboard
```

Implement:

- Registration
- Login
- Password hashing
- Email verification
- Password reset
- Session/token handling
- Logout
- Authorization

---

# PHASE 14 — WooCommerce Store Connection

Merchant installs the Optionia plugin.

Plugin displays:

```text
Connect Optionia
```

Connection flow:

```text
WooCommerce
 ↓
Optionia connection flow
 ↓
Merchant authenticates
 ↓
Authorize store
 ↓
Optionia creates store connection
```

Optionia stores:

```text
User
Store
Connection
Secure credential/token reference
```

Do not expose private SaaS secrets in frontend/plugin code.

---

# PHASE 15 — SaaS ↔ Plugin Synchronization

Architecture:

```text
Optionia Dashboard
       ↓
NestJS API
       ↓
WooCommerce Plugin
       ↓
WooCommerce
```

The plugin should retrieve/synchronize:

- Store configuration
- Option groups
- Options
- Rules
- Pricing configuration
- Product assignments

Use caching where appropriate.

---

# PHASE 16 — Product Synchronization

WooCommerce products should be available to the Optionia dashboard.

Possible flow:

```text
WooCommerce
     │
Product created/updated
     │
     ▼
Webhook
     │
     ▼
Optionia API
     │
     ▼
MySQL
```

Dashboard:

```text
Products

✓ T-Shirt
✓ Hoodie
✓ Shoes
```

Merchant can assign Option Sets.

---

# PHASE 17 — Next.js SaaS Dashboard

Create:

```text
optionia-dashboard
```

Recommended navigation:

```text
Dashboard
Products
Option Groups
Options
Rules
Pricing
Analytics
Stores
Subscription
Settings
```

---

# PHASE 18 — Option Builder UI

Build a visual option builder.

Example:

```text
Create Option Group

Name:
Customization

┌──────────────────────────┐
│ Color                    │
│ ○ Black                  │
│ ○ White                  │
│ ○ Red                    │
└──────────────────────────┘

[ + Add Option ]
```

Then provide:

```text
Rules
Pricing
Display
Validation
```

The UI should eventually feel like a real SaaS builder, not a collection of unrelated CRUD screens.

---

# PHASE 19 — Preview System

Merchant can preview:

```text
Desktop
Mobile
```

Example:

```text
Product
$50

Color
○ Black
○ White

Custom text
[____________]

[Add to cart]
```

Preview should reflect the merchant's current configuration as closely as practical.

---

# PHASE 20 — WooCommerce Frontend Renderer

Connect SaaS configuration to the real product page.

```text
Optionia Dashboard
       ↓
Save configuration
       ↓
Optionia API
       ↓
WooCommerce Plugin
       ↓
Product Page
       ↓
Render Options
```

Support the required WooCommerce product types and document unsupported cases.

---

# PHASE 21 — Cart / Checkout / Order Integration

Complete:

```text
Product
 ↓
Option selection
 ↓
Cart
 ↓
Checkout
 ↓
Order
```

Order data should contain enough information for the merchant to understand exactly what the customer selected.

Example:

```text
Order #1025

T-Shirt             $50

Customization:
Color = Black
Print = Front
Gift wrap = Yes

Option total         $15
Product total        $50
--------------------------
Order total          $65
```

---

# PHASE 22 — SaaS Billing

Create subscription plans.

Example:

```text
FREE
PRO
BUSINESS
```

Possible limits:

```text
Free:
10 products

Pro:
100 products

Business:
Higher/unlimited limits
```

Exact pricing and limits should be determined separately based on business research.

Subscription flow:

```text
Merchant
 ↓
Choose plan
 ↓
Billing checkout
 ↓
Payment provider
 ↓
Subscription created
 ↓
Webhook
 ↓
Optionia API
 ↓
Subscription ACTIVE
```

---

# PHASE 23 — Billing Webhooks

Never rely only on browser/frontend payment success.

Handle provider webhooks for events such as:

```text
subscription.created
subscription.updated
subscription.cancelled
payment.failed
invoice.paid
```

Update the `subscriptions` table based on verified webhook events.

---

# PHASE 24 — Subscription Enforcement

Example lifecycle:

```text
ACTIVE
 ↓
PAYMENT FAILED
 ↓
GRACE PERIOD
 ↓
CANCELLED
```

Define exact behavior.

Recommended principle:

Do not unexpectedly break an existing merchant storefront.

For example:

```text
Subscription expired
        ↓
Existing configuration may continue
        ↓
Dashboard becomes limited/read-only
        ↓
New configuration changes blocked
```

The final policy should be defined before production.

---

# PHASE 25 — Analytics

Potential analytics:

```text
Option views
Option selections
Conversion
Option revenue
Popular options
```

Example:

```text
Most selected colors

Black    72%
White    18%
Red      10%
```

Analytics should be designed around actual useful merchant decisions.

---

# PHASE 26 — Security

Before production, implement and verify:

```text
Authentication
Authorization
Tenant isolation
Input validation
Output escaping
SQL injection prevention
XSS prevention
CSRF protection
WordPress nonce verification
WordPress capability checks
Webhook verification
API permissions
Rate limiting
Secure credential storage
```

WooCommerce plugin security is especially important because the plugin will run on independent merchant sites.

---

# PHASE 27 — Performance

Avoid making every product-page load depend on a slow remote request.

Bad:

```text
Customer opens product
 ↓
Plugin
 ↓
Remote API
 ↓
Wait
 ↓
Render
```

Prefer appropriate synchronization/caching:

```text
Optionia API
 ↓
Plugin cache/local configuration
 ↓
Product page
```

Design cache invalidation carefully.

---

# PHASE 28 — Compatibility

Define an official compatibility matrix.

Test:

- Supported WordPress versions
- Supported WooCommerce versions
- Supported PHP versions
- Classic themes
- Block themes
- Mobile
- Desktop
- Common page builders
- Caching
- CDN
- Minification
- Security plugins
- Other product-option plugins

Do not promise compatibility with everything on the first release.

---

# PHASE 29 — Testing

## NestJS

Test:

- Unit tests
- Integration tests
- API tests
- Authentication
- Authorization
- Tenant isolation
- Pricing
- Subscription
- Webhooks

## Next.js

Test:

- Components
- Forms
- Validation
- API state
- Authentication flows
- Option builder

## WooCommerce Plugin

Test:

- Plugin activation
- Dependency checks
- Product rendering
- Option selection
- Pricing
- Cart
- Checkout
- Order metadata
- Security
- API communication

Critical end-to-end test:

```text
Merchant creates option
        ↓
Assigns option to product
        ↓
Customer opens product
        ↓
Customer selects option
        ↓
Price is calculated
        ↓
Cart
        ↓
Checkout
        ↓
Order
        ↓
Merchant sees correct option/order data
```

---

# PHASE 30 — Monitoring & Error Handling

Monitor:

- NestJS errors
- Next.js errors
- Plugin errors
- API failures
- Webhook failures
- Store connection failures
- Synchronization failures
- Subscription failures

Create an admin area for operational problems:

```text
Failed webhook
Failed store connection
Failed synchronization
Failed billing event
```

---

# PHASE 31 — Documentation

Create:

```text
docs/
├── installation.md
├── getting-started.md
├── merchant-guide.md
├── option-builder.md
├── pricing.md
├── conditional-logic.md
├── troubleshooting.md
├── api.md
└── developer.md
```

Also maintain:

```text
ARCHITECTURE.md
DATABASE.md
SECURITY.md
CHANGELOG.md
```

---

# PHASE 32 — Beta

Do not launch publicly immediately.

Recruit approximately:

```text
5–10 WooCommerce merchants
```

Test:

```text
Plugin installation
Store connection
Option creation
Product assignment
Customer selection
Cart
Checkout
Orders
Subscription
```

Collect real-world issues.

Prioritize:

```text
Blocker
Critical
High
Medium
Low
```

---

# PHASE 33 — Production

Potential production architecture:

```text
                    Cloud
                      │
          ┌───────────┴───────────┐
          │                       │
       Next.js                 NestJS
          │                       │
          │                       ▼
          │                     MySQL
          │
          └──────────────┐
                         │
                      HTTPS
                         │
                         ▼
                WooCommerce Stores
                         │
                  Optionia Plugin
```

Deploy:

```text
Next.js
NestJS
MySQL
Background workers if needed
Monitoring
Backups
HTTPS
```

Use managed infrastructure where practical.

---

# PHASE 34 — Plugin Distribution

Prepare the WooCommerce/WordPress plugin for distribution.

Possible model:

```text
Free Optionia Plugin
        +
Optionia SaaS Account
        +
Paid SaaS Subscription
```

Prepare:

- Plugin metadata
- Readme
- Licensing
- Security review
- WordPress coding standards
- Assets
- Installation documentation
- Privacy policy
- Terms
- SaaS documentation

If submitting to WordPress.org, follow the current WordPress plugin review requirements.

---

# 35. Master Milestone Checklist

```text
OPTIONIA WOOCOMMERCE
══════════════════════════════════════

[✓] PHASE 1 — Environment

[ ] PHASE 2 — WooCommerce Fundamentals
[ ] PHASE 3 — Plugin Fundamentals
[ ] PHASE 4 — Product Option Prototype
[ ] PHASE 5 — Option Engine
[ ] PHASE 6 — Pricing Engine
[ ] PHASE 7 — Conditional Logic
[ ] PHASE 8 — Option Groups
[ ] PHASE 9 — Product Assignment

[ ] PHASE 10 — NestJS SaaS Backend
[ ] PHASE 11 — Multi-Tenant Architecture
[ ] PHASE 12 — MySQL Architecture
[ ] PHASE 13 — Authentication
[ ] PHASE 14 — WooCommerce Connection

[ ] PHASE 15 — Plugin ↔ SaaS Sync
[ ] PHASE 16 — Product Synchronization

[ ] PHASE 17 — Next.js Dashboard
[ ] PHASE 18 — Option Builder
[ ] PHASE 19 — Preview
[ ] PHASE 20 — Storefront Renderer

[ ] PHASE 21 — Cart/Checkout/Orders

[ ] PHASE 22 — SaaS Billing
[ ] PHASE 23 — Billing Webhooks
[ ] PHASE 24 — Subscription Enforcement

[ ] PHASE 25 — Analytics
[ ] PHASE 26 — Security
[ ] PHASE 27 — Performance
[ ] PHASE 28 — Compatibility
[ ] PHASE 29 — Testing
[ ] PHASE 30 — Monitoring
[ ] PHASE 31 — Documentation

[ ] PHASE 32 — Beta
[ ] PHASE 33 — Production
[ ] PHASE 34 — Plugin Distribution
```

---

# 36. Claude AI Development Workflow

Do NOT give Claude the entire roadmap and ask:

> Build the complete Optionia WooCommerce SaaS.

Instead, treat this file as the master specification.

Work like this:

```text
README
  ↓
Current Phase
  ↓
Current Milestone
  ↓
Inspect repository
  ↓
Plan
  ↓
Implement
  ↓
Test
  ↓
Fix
  ↓
Git commit
  ↓
Next milestone
```

## Bad prompt

```text
Build the complete Optionia WooCommerce plugin.
```

## Better prompt

```text
We are building Optionia WooCommerce SaaS.

Read OptioniaStartRoadmap.md first.

We are currently working on:
PHASE 4 — Product Option Prototype
Milestone 4.1 — Render a test option on a WooCommerce product page.

First inspect the existing repository and explain:
1. Current plugin structure.
2. Relevant WooCommerce integration points.
3. Proposed implementation.
4. Files that need to change.
5. How the feature will be tested.

Do not modify code yet.
```

After reviewing the plan:

```text
Implement the approved approach.

Requirements:
- Do not modify unrelated files.
- Follow the existing project structure.
- Use WordPress/WooCommerce best practices.
- Add validation/security where required.
- Do not hardcode production secrets.
- Explain all changed files.
- Provide exact local testing steps.
```

After testing:

```text
The milestone is working.

Update the relevant project documentation if necessary.
Give me a concise milestone completion summary.
Do not start the next milestone.
```

---

# 37. Development Loop

Every milestone follows:

```text
┌───────────────────────────────┐
│ 1. Read roadmap milestone     │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 2. Inspect current code       │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 3. Plan implementation        │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 4. Implement                   │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 5. Run tests                   │
└───────────────┬───────────────┘
                ↓
        Works correctly?
           /       \
         NO         YES
         │           │
         ▼           ▼
      Debug       Git commit
                     │
                     ▼
               Next milestone
```

---

# 38. Git Strategy

Use Git from the beginning.

Suggested branches:

```text
main
develop
feature/...
fix/...
```

Example:

```text
feature/product-option-renderer
feature/pricing-engine
feature/store-connection
feature/subscription
```

Each completed milestone should result in a meaningful commit.

Example:

```text
feat(plugin): render product options
feat(plugin): persist option data in cart
feat(plugin): store option metadata in orders
feat(api): add tenant module
feat(api): add WooCommerce store connection
feat(dashboard): add option builder
```

---

# 39. Definition of Done

A milestone is NOT complete just because Claude says it is complete.

A milestone is complete when:

```text
[ ] Code implemented
[ ] Application runs
[ ] No unexpected errors
[ ] Feature manually tested
[ ] Relevant automated tests pass
[ ] Security considered
[ ] Existing features still work
[ ] Documentation updated if needed
[ ] Git commit created
```

---

# 40. Important Architectural Decisions

## Decision 1 — Optionia remains SaaS

The WooCommerce plugin is the integration layer.

```text
Optionia Cloud = SaaS
WooCommerce Plugin = Connector/Integration
```

## Decision 2 — Multi-tenancy is mandatory

Every merchant/store's data must be isolated.

## Decision 3 — Centralized configuration

Optionia Cloud should be the main source of truth for merchant configuration where practical.

## Decision 4 — WooCommerce owns the customer's commerce transaction

Optionia enhances the product experience but should not unnecessarily replace:

- WooCommerce cart
- WooCommerce checkout
- WooCommerce order system
- Merchant payment gateway

## Decision 5 — Security over convenience

Never trust:

- Frontend prices
- Frontend option IDs
- Client-side permissions
- Unsigned webhooks
- Unvalidated plugin requests

## Decision 6 — Compatibility must be explicit

Do not promise universal WordPress/WooCommerce compatibility without testing.

---

# 41. Final Product Flow

## Merchant

```text
Merchant
   ↓
Create Optionia account
   ↓
Choose SaaS plan
   ↓
Install Optionia WooCommerce plugin
   ↓
Connect WooCommerce store
   ↓
Optionia detects/synchronizes products
   ↓
Merchant creates Option Group
   ↓
Merchant creates Options
   ↓
Merchant configures pricing/rules
   ↓
Merchant assigns Option Group to product
   ↓
Save / publish
```

## Customer

```text
Customer
   ↓
WooCommerce product page
   ↓
Optionia options appear
   ↓
Customer selects options
   ↓
Optionia validates selections
   ↓
Price calculated
   ↓
Add to cart
   ↓
WooCommerce cart
   ↓
WooCommerce checkout
   ↓
Merchant's payment gateway
   ↓
WooCommerce order
```

## Optionia SaaS

```text
Merchant
   ↓
Optionia Dashboard
   ↓
Next.js
   ↓
NestJS API
   ↓
MySQL
   ↓
WooCommerce Connection
   ↓
Plugin
```

---

# 42. Ultimate Goal

The completed Optionia WooCommerce product should allow a merchant to:

```text
1. Create Optionia account
2. Subscribe to a plan
3. Install plugin
4. Connect WooCommerce store
5. Import/sync products
6. Create option groups
7. Create options
8. Configure pricing
9. Configure conditions
10. Assign options to products
11. Publish
12. Customer selects options
13. Customer adds to cart
14. Customer checks out
15. WooCommerce creates order
16. Merchant sees all selected options
17. Optionia tracks useful analytics
18. Merchant manages everything from SaaS dashboard
19. Subscription renews automatically
20. Optionia securely manages the entire SaaS relationship
```

The end result is:

```text
                    OPTIONIA

             SaaS Product Platform
                     │
        ┌────────────┴────────────┐
        │                         │
   Merchant SaaS            WooCommerce Plugin
     Dashboard                    │
        │                         │
     Next.js                      │
        │                         │
     NestJS ◄─────────────────────┘
        │
      MySQL
        │
   Subscriptions
   Tenants
   Stores
   Options
   Rules
   Pricing
   Analytics
```

---

# 43. Current Status

```text
PHASE 1
Environment
████████████████████ 100%

PHASE 2
WooCommerce Fundamentals
░░░░░░░░░░░░░░░░░░░░ 0%

PHASE 3+
Plugin + SaaS Development
░░░░░░░░░░░░░░░░░░░░ 0%
```

**Current next milestone:**

```text
PHASE 2 — WooCommerce Fundamentals
```

Start by learning WooCommerce products, variations, cart, checkout, orders, hooks, APIs, and webhooks.

Do not start the full SaaS architecture until the basic WooCommerce integration is understood.
