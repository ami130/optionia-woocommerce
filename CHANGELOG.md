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
