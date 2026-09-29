# Changelog

All notable changes to Optionia for WooCommerce are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `Money::from_decimal()` is now strict and throws on malformed input;
  `try_from_decimal()` added for values that may legitimately be unparseable.
  A European decimal comma previously parsed as a thousands separator.
- API requests are bounded by a 20-second total budget covering every retry and
  sleep, so a slow endpoint can no longer exceed PHP's execution limit.
- Settings save now redirects (post/redirect/get) so a refresh cannot resubmit.
- `Container` reports circular dependencies by name instead of exhausting the
  stack.
- System Status gained a Scheduling section: next sync, WP-Cron state, and
  circuit-breaker state.

### Added
- Plugin scaffold with PSR-4 autoloading and a lazy service container (M3.1).
- Activation, deactivation and upgrade lifecycle with reversible schema
  handling (M3.2).
- Graceful WooCommerce dependency guard — the site stays fully functional when
  requirements are unmet (M3.3).
- Admin menu with Dashboard and Settings, gated on `manage_woocommerce` (M3.4).
- Conditional asset pipeline; a product page without options loads no plugin
  assets (M3.5).
- Centralised API client with hard timeouts, jittered retry, circuit breaker and
  response validation (M3.5b).
- Token-redacting logger and a System Status report sufficient for support
  diagnosis (M3.6).
- Architecture guards enforced in CI: engine purity, single-owner rules, no
  float money, direct-access guards, version consistency (M3.0).

## [0.4.0] — 2026-09-29

### Added
- **Option view counts (M25.1).** The storefront now reports which options a
  customer saw, so the dashboard can show *conversion* — of the people who saw
  an option, how many bought it. Until this release that figure could not be
  computed at all, and the dashboard showed average order value instead.

### How it works, and what it does not do
- **Nothing is sent while a page is loading.** The browser hands one small
  message to the operating system as the customer leaves, and WordPress counts
  it. The counts travel to Optionia on the existing quarter-hourly schedule,
  alongside orders — no extra cron, no extra wake-up.
- **Nothing about a customer is recorded.** No session, no address, no time of
  day: a day's looking is one number per option, and one visitor is
  indistinguishable from another inside it.
- **Conversion starts from this release.** Options viewed before it were never
  counted and cannot be, so the figure covers traffic from the upgrade onward.

## [0.3.0] — 2026-09-29

### Added
- Order reports now carry the **product** each option was chosen against
  (F151, M25.4), so the dashboard can answer "which of my products sell better
  with options?". A variable product reports its **variation** id rather than
  the parent's, because that is what the customer bought and what a merchant
  prices differently.

### Note for merchants upgrading
- **Per-product revenue starts from this release.** Orders placed before it
  carry no product reference and nothing can infer one, so the dashboard shows
  how many earlier selections sit outside the comparison rather than reporting
  them as belonging to no product. The same applies to revenue per option set,
  which began one release earlier.
