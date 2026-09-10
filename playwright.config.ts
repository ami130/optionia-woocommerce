import { defineConfig, devices } from '@playwright/test';

/**
 * The canonical Gate 1 flow, driven in a real browser.
 *
 * ## Why the services are asserted, not started
 *
 * This suite needs three: the API (4000), the dashboard (3001), and a real
 * WordPress install with WooCommerce and the plugin (8881). Playwright's
 * `webServer` could start the first two — and deliberately does not.
 *
 * Starting a backend implicitly means starting it against **whatever database
 * `.env` points at**, from a test run that may have been launched by anyone. A
 * suite that silently boots a server against a developer's working data, or
 * worse against something shared, is a worse failure than one that refuses to
 * run: the refusal is visible, and the damage is not. `global-setup.ts` checks
 * all three and fails with what to start.
 *
 * WordPress is managed by Studio and outside any Node process's lifecycle
 * regardless, so two of the three would have to be asserted in any case.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',

  /*
   * Serial, and one worker. The flow mutates a single WordPress install and a
   * single store connection; two workers would race over the same site and
   * produce failures that are about the harness rather than the product.
   */
  fullyParallel: false,
  workers: 1,

  /* No retries. A flow this stateful that passes only on retry is telling you
   * something, and swallowing it here is how a flaky E2E becomes a trusted one. */
  retries: 0,

  /* Long: the flow spans a publish, a plugin sync, and a checkout. */
  timeout: 180_000,
  expect: { timeout: 15_000 },

  reporter: [['list']],

  use: {
    baseURL: process.env.E2E_DASHBOARD_URL ?? 'http://localhost:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',

    /*
     * ⚠️ **Studio's certificate is self-signed, and this flow crosses two
     * origins in one browser context.**
     *
     * The handshake goes dashboard → WordPress → dashboard → WordPress, so the
     * page cannot be split into a strict context and a lenient one without
     * losing the session that makes it a single flow. The tolerance therefore
     * applies to the context.
     *
     * That is a real trade: a bad certificate from the *API* would also be
     * accepted here. It is acceptable only because every origin in this suite is
     * localhost — asserted by `global-setup`, which refuses to run against
     * anything else — so there is no network path for a certificate to be
     * substituted on. If this suite is ever pointed at a remote stack, this
     * setting must go first.
     */
    ignoreHTTPSErrors: true,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
