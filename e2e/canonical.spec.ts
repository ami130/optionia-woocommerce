import { expect, test } from '@playwright/test';

import { newMerchant, verifyEmail, type Merchant } from './fixtures';
import {
  assignedExternalId,
  connectedStoreId,
  importProducts,
  productUrl,
  storeToken,
  syncPluginConfig,
} from './catalogue';
import { fillCheckout } from './checkout';
import { clearCarts, disconnectStore } from './reset';
import { SERVICES } from './services';

/**
 * The store's hostname, as a screen would print it.
 *
 * Derived rather than written out: the URL moved from `localhost:8881` to
 * `optionia.local` when the handshake needed HTTPS, and two hardcoded copies of
 * the old host then failed as "element not found" — a configuration change
 * wearing the costume of a product bug.
 */
const STORE_HOST = new URL(SERVICES.store).hostname;

/** Named per run, so a failed run's leftovers cannot be mistaken for this one's. */
const SET_NAME = `E2E Finish ${Date.now().toString(36)}`;

/**
 * The canonical Gate 1 flow, in a real browser.
 *
 * ```text
 * register → connect a store → author an option set → assign it to a product
 *          → publish → the option appears on the live product page
 *          → a customer selects it → the price is computed server-side
 *          → add to cart → checkout → the order carries the selection
 * ```
 *
 * ## What makes this test worth having
 *
 * Every piece of it is covered by a unit or integration suite already, and those
 * suites all pass while the product is broken in the one way that matters: the
 * three repositories agreeing with each other. Phase 12 measured that exact
 * failure — the plugin and the API each green, disagreeing about `value_key`,
 * every engraving order silently dropped. **This is the only test that would
 * have caught it.**
 *
 * ## Why it is one test, not eleven
 *
 * The steps share state that cannot be reconstructed: a store connection, a
 * published set, a cart. Splitting them into independent tests would mean
 * either re-running the whole prefix each time, or fixtures that fake the
 * middle — and a faked middle is exactly what this test exists to avoid.
 * `test.step` gives the readable breakdown without the false independence.
 *
 * ⚠️ **Assertions are on facts, not on navigation.** A page that loaded is not
 * evidence; a price that appears in a cart total is. This phase has four
 * recorded cases of a check passing without exercising its subject, and an E2E
 * that only asserts "the page rendered" is that failure at its most expensive.
 */
test.describe('Gate 1 — the canonical flow', () => {
  test('a merchant registers, verifies, signs in, and reaches their workspace', async ({
    page,
  }) => {
    const merchant: Merchant = newMerchant();

    await test.step('the merchant registers', async () => {
      await page.goto('/register');

      await page.locator('input[name="name"]').fill(merchant.name);
      await page.locator('input[name="tenantName"]').fill(merchant.tenantName);
      await page.locator('input[name="email"]').fill(merchant.email);
      await page.locator('input[name="password"]').fill(merchant.password);

      await page.getByRole('button', { name: /create|register|sign up/i }).click();

      /* The confirmation names the address, which proves the account was made
       * rather than the form merely submitted. */
      await expect(page.getByText(merchant.email)).toBeVisible();
    });

    await test.step('the address is verified', async () => {
      verifyEmail(merchant.email);
    });

    await test.step('the merchant signs in and reaches the dashboard', async () => {
      await page.goto('/login');

      await page.locator('input[name="email"]').fill(merchant.email);
      await page.locator('input[name="password"]').fill(merchant.password);
      await page.getByRole('button', { name: /sign in|log in/i }).click();

      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

      /*
       * The workspace name proves the tenant context resolved — criterion 3 —
       * rather than merely that a page at /dashboard rendered.
       *
       * Scoped to the banner: the name appears there *and* in the dashboard
       * body, and an unscoped `getByText` matches both and fails as "strict mode
       * violation" — a locator problem wearing the costume of a product bug.
       */
      await expect(
        page.getByRole('banner').getByText(merchant.tenantName),
      ).toBeVisible();

      /* The signed-in address, from the same banner: the session is this user's. */
      await expect(page.getByRole('banner').getByText(merchant.email)).toBeVisible();
    });

    await test.step('no store is connected yet, and the screen says so', async () => {
      await page.goto('/stores');

      await expect(page.getByText(/no stores connected/i)).toBeVisible();
    });
  });

  /**
   * The half that needs a store connection.
   *
   * Separated so the passing half keeps reporting as passing: a single test
   * carrying `test.skip` skips *everything*, and four verified steps would have
   * been reported as "skipped" — which reads as untested rather than blocked.
   */
  test('a store connects, an option is published, and a customer buys it', async ({ page }) => {
    /*
     * ✅ **R1 resolved by configuration, 2026-09-02 — no code change.**
     *
     * `InitiateDto` requires `https://`, correctly: the handshake delivers a
     * credential, and one sent over plain HTTP crosses the network in cleartext.
     * Studio serves TLS natively — `studio config set --domain optionia.local
     * --https`, with WordPress's `home` and `siteurl` pointed at that origin so
     * `home_url()` returns what the plugin sends.
     *
     * The tempting alternative was a localhost exemption in the DTO gated on
     * `NODE_ENV`. It was **declined**: code whose purpose is to weaken a security
     * boundary when a variable says so is one misconfigured deploy away from
     * weakening it in production. Configuration reaches the same place and
     * cannot leak there, because production already has real TLS.
     */
    const merchant: Merchant = newMerchant();

    /** Filled by the assign step; the storefront step needs the same product. */
    let assignedProduct = '';

    /*
     * 🔴 **Run two is not run one unless this happens.** A connected site shows
     * no Connect button, so the second run fails on a missing element and blames
     * the product. The backend's store row is deliberately left in place — see
     * `reset.ts`.
     */
    disconnectStore();

    /* Stale carts hold option ids from earlier runs; checkout rightly refuses them. */
    clearCarts();

    /*
     * The approval screen is only reachable signed in — an anonymous visitor is
     * sent to `/login` and the handshake stalls with the request unapproved. So
     * this half needs its own merchant: the tests are independent by design, and
     * sharing one across them would make the second depend on the first's order.
     */
    await test.step('a verified merchant is signed in to the dashboard', async () => {
      await page.goto('/register');
      await page.locator('input[name="name"]').fill(merchant.name);
      await page.locator('input[name="tenantName"]').fill(merchant.tenantName);
      await page.locator('input[name="email"]').fill(merchant.email);
      await page.locator('input[name="password"]').fill(merchant.password);
      await page.getByRole('button', { name: /create|register|sign up/i }).click();
      await expect(page.getByText(merchant.email)).toBeVisible();

      verifyEmail(merchant.email);

      await page.goto('/login');
      await page.locator('input[name="email"]').fill(merchant.email);
      await page.locator('input[name="password"]').fill(merchant.password);
      await page.getByRole('button', { name: /sign in|log in/i }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    });

    await test.step('the merchant signs in to their WordPress admin', async () => {
      await page.goto(`${SERVICES.store}/wp-login.php`);

      /*
       * ⚠️ **Wait for the form before filling it.** WordPress's login page is
       * served by PHP after a cold start, and typing into a field that has not
       * rendered submits an empty form — which fails later as "no admin bar",
       * blaming the wrong step. Seen once, transient, and cheap to remove.
       */
      await expect(page.locator('#user_login')).toBeVisible();

      /* Studio prints these on `studio start`; overridable for another site. */
      await page.locator('#user_login').fill(process.env.E2E_WP_USER ?? 'admin');
      await page.locator('#user_pass').fill(process.env.E2E_WP_PASSWORD ?? 'StrongPassword123!');
      await page.locator('#wp-submit').click();

      /*
       * The admin bar is the proof of a session. Given its own generous wait:
       * the first admin page load compiles WordPress's admin bootstrap, which is
       * slower than anything else in this flow.
       */
      await expect(page.locator('#wpadminbar')).toBeVisible({ timeout: 30_000 });
    });

    await test.step('the store starts a connection from the plugin', async () => {
      await page.goto(`${SERVICES.store}/wp-admin/admin.php?page=optionia-settings`);

      /*
       * 🔴 The handshake begins on the merchant's own site, on purpose: the
       * plugin generates a PKCE verifier it never transmits, so the credential
       * that comes back can only be used by the site that asked for it. A
       * dashboard-initiated flow could not make that guarantee.
       */
      const connect = page.locator('button[name="optionia_connect_submit"]');
      await expect(connect).toBeVisible();
      await connect.click();

      /*
       * The plugin redirects to the dashboard's approval screen — or back to
       * itself with `optionia_connection=failed`.
       *
       * 🔴 **`POST /connect/initiate` allows 10 per hour**, deliberately: an
       * unauthenticated endpoint that mints connection requests is an abuse
       * surface. Five suite runs in ten minutes exhausts it, and the failure
       * then looks like a broken handshake rather than a spent budget. Named
       * here so the next person reads the cause instead of debugging PKCE.
       */
      await page.waitForURL(/\/connect\?|optionia_connection=/, { timeout: 30_000 });

      if (page.url().includes('optionia_connection=failed')) {
        throw new Error(
          'The handshake was refused. Most often this is the 10-per-hour rate ' +
            'limit on POST /connect/initiate, exhausted by repeated runs — check ' +
            'the API log for RATE_LIMITED before suspecting the flow.',
        );
      }
    });

    await test.step('the dashboard names the site before asking for approval', async () => {
      /*
       * The consent screen must say *which* site it is authorising — that is the
       * whole content of the consent, and the defect Stage 6 found was a path
       * where this rendered empty.
       */
      await expect(page.getByText(STORE_HOST).first()).toBeVisible();

      await page.getByRole('button', { name: /connect store/i }).click();

      /* Approval returns the browser to WordPress. */
      await page.waitForURL(new RegExp(SERVICES.store.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), {
        timeout: 30_000,
      });
    });

    await test.step('both sides agree the store is connected', async () => {
      await page.goto(`${SERVICES.store}/wp-admin/admin.php?page=optionia-settings`);
      await expect(page.getByText(/connected/i).first()).toBeVisible();

      /* And the dashboard lists it — the same fact, from the other repository. */
      await page.goto(`${SERVICES.dashboard}/stores`);
      await expect(page.getByText(STORE_HOST).first()).toBeVisible();
    });

    await test.step('the merchant creates an option set', async () => {
      await page.goto('/option-sets');

      /* The empty state offers both; either opens the same form. */
      await page.getByRole('button', { name: /new option set|create your first/i }).first().click();
      await page.locator('input[name="name"]').fill(SET_NAME);
      await page.getByRole('button', { name: /^create$/i }).click();

      await expect(page.getByText(SET_NAME).first()).toBeVisible();
    });

    await test.step('with a radio option worth +£10', async () => {
      await page.getByText(SET_NAME).first().click();
      await page.waitForURL(/\/option-sets\/[0-9a-f-]{36}/, { timeout: 30_000 });

      /* A group holds related options — Gate 1's script says one radio. */
      await page.getByPlaceholder('Finish').first().fill('Finish');
      await page.getByRole('button', { name: /add group/i }).click();

      await expect(page.getByRole('button', { name: /add option/i })).toBeVisible();

      /*
       * Label, then key: the key is what the plugin indexes by.
       *
       * ⚠️ The group's "New group" input and the option's "Option label" input
       * **share the placeholder `Finish`** — the same word is a plausible example
       * for both. Scoped through the key field's own row instead: `finish` is
       * unique to the option form, so its container is unambiguous.
       */
      const optionRow = page.getByPlaceholder('finish', { exact: true }).locator('../..');
      await optionRow.getByPlaceholder('Finish', { exact: true }).fill('Finish');
      await page.getByPlaceholder('finish', { exact: true }).fill('finish');

      /*
       * 🔴 **`dropdown`, not `radio` — Phase 14's first added type, proven here.**
       *
       * The flow deliberately authors the *newer* type rather than the one that
       * has always worked. A registry entry and a template are easy to add and
       * easy to get subtly wrong: this drives the type a merchant would pick all
       * the way to a real order, so "registered" and "works" cannot diverge.
       *
       * Radio keeps its coverage in the unit and integration suites; what only an
       * E2E can prove is that a *second* type survives the whole chain — config
       * document, storefront render, cart, checkout, order.
       */
      await page.getByLabel('Type').selectOption('dropdown');

      await page.getByRole('button', { name: /add option/i }).click();

      /*
       * The value carries the price. £10.50 rather than a round £10: a decimal
       * that is not representable in binary floating point is the one that
       * catches an engine multiplying instead of scaling as text.
       */
      /* ⚠️ `exact` throughout: `getByPlaceholder('lux')` is a *substring* match
       * and also finds the `Luxury` field beside it. */
      await expect(page.getByPlaceholder('Luxury', { exact: true })).toBeVisible();
      await page.getByPlaceholder('Luxury', { exact: true }).fill('Luxury');
      await page.getByPlaceholder('lux', { exact: true }).fill('lux');
      await page.getByPlaceholder('10.50', { exact: true }).fill('10.50');
      await page.getByRole('button', { name: /add value/i }).click();

      /* The price rendered back is the proof the amount survived the round trip. */
      await expect(page.getByText('Luxury')).toBeVisible();
    });

    /**
     * 🔴 **A second option, of the first type a *customer* supplies the value for.**
     *
     * Every type before `text_field` resolves against a merchant-authored
     * `value_key`, and that lookup is what made the plugin's *"nothing here is
     * trusted"* comment survivable — an unknown value was simply refused. Text
     * removes that guarantee, so what an E2E proves here is different in kind
     * from proving a fifth way to draw a list of choices: it carries **typed
     * customer input** through resolver, cart and order.
     *
     * Authored on the same set as the dropdown, deliberately. Two options of
     * different kinds on one product is the case where a resolver handling text
     * as a special path would break the *choice* beside it.
     */
    await test.step('with a text option the customer types', async () => {
      await page.getByRole('button', { name: /add option/i }).first().click();

      const textRow = page.getByPlaceholder('finish', { exact: true }).locator('../..');
      await textRow.getByPlaceholder('Finish', { exact: true }).fill('Engraving');
      await page.getByPlaceholder('finish', { exact: true }).fill('engraving');
      await page.getByLabel('Type').selectOption('text_field');
      await page.getByRole('button', { name: /add option/i }).click();

      await expect(page.getByText('Engraving')).toBeVisible();

      /*
       * ⚠️ **The absence is the assertion.**
       *
       * A text option takes no values, so the dashboard must not offer an "add
       * value" form for it — one that appeared would invite a merchant to create
       * rows the API refuses with `TYPE_TAKES_NO_VALUES` and the storefront
       * ignores. `takesValues()` hides it; this is what fails if that gate is
       * removed.
       *
       * Scoped to the option's own row: the dropdown authored above still has
       * its form, and a page-level check would find that one and pass.
       */
      const engravingRow = page.getByText('Engraving').first().locator('../..');
      await expect(engravingRow.getByRole('button', { name: /add value/i })).toHaveCount(0);
    });

    await test.step('the catalogue is imported', async () => {
      /*
       * Standing in for M19.1, which owns the real import. Without it
       * `store_products` is empty and the assign step below has nothing to act
       * on — which is how that step came to branch, and how its assigning half
       * went un-run for every one of its first sixteen executions.
       */
      const storeId = connectedStoreId();
      expect(storeId, 'the store should be connected by now').not.toBeNull();

      const imported = await importProducts(storeId as string);
      expect(imported, 'the WooCommerce store should hold simple products').toBeGreaterThan(0);
    });

    await test.step('the merchant assigns it to a product', async () => {
      await page.reload();

      /*
       * 🔴 **Unconditional now.** This step used to branch on whether a product
       * existed, and the catalogue was always empty — so the `else` ran every
       * time and the assignment was never tested. A branch that has never
       * executed reads as coverage and is not.
       */
      const assign = page.getByRole('button', { name: /^assign$/i }).first();

      await expect(assign).toBeVisible();
      await assign.click();

      /* The button changing to "Assigned" is driven by the *server's* answer —
       * the picker derives it from the assignments query, not from the click. */
      await expect(page.getByRole('button', { name: /^assigned$/i }).first()).toBeVisible();

      /*
       * Which product, read back from the API rather than assumed. The picker
       * assigns whichever the catalogue lists first, and the storefront step
       * below has to visit *that* product — guessing would send it to a page
       * with no options and report a missing renderer.
       */
      assignedProduct = assignedExternalId(SET_NAME);
      expect(assignedProduct, 'the assignment should name a product').not.toBe('');
    });

    await test.step('the merchant publishes', async () => {
      const publish = page.getByRole('button', { name: /publish to storefront/i });

      await expect(publish).toBeVisible();
      await expect(publish).toBeEnabled();
      await publish.click();

      /*
       * The confirmation names a **version** and a **config version**. That is
       * the assertion worth making: a snapshot was written and the store's
       * revision advanced, which is what a storefront actually reads. A button
       * that merely stopped saying "Publishing…" would prove nothing.
       */
      await expect(page.getByText(/Published version \d+/)).toBeVisible();
    });

    await test.step('the storefront receives it', async () => {
      /*
       * 🔴 **The cross-repository assertion, and the reason this suite exists.**
       *
       * Fetched with the *plugin's own* credential, from the endpoint the
       * storefront polls — not through the dashboard's session. Every repository
       * passed its own suite while Phase 12 measured them disagreeing about
       * `value_key` and silently dropping every engraving order; this is the only
       * check that spans that seam.
       *
       * Read before the disconnect below, because revoking the credential is the
       * last thing this flow does and the document is unreachable after it.
       */
      const token = storeToken();
      expect(token, 'the plugin should hold a credential by now').not.toBe('');

      const document = await page.request.get(`${SERVICES.api}/v1/store/config`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(document.status()).toBe(200);

      const body = (await document.json()) as {
        data: {
          option_sets: Array<{
            assignments: Array<{ mode: string; target_ref: string }>;
            groups: Array<{
              options: Array<{
                key: string;
                values: Array<{ value_key: string; price_config: { amount_minor: number } }>;
              }>;
            }>;
          }>;
        };
      };

      const published = body.data.option_sets.find((set) => set.assignments.length > 0);

      expect(published, 'a published set with an assignment should reach the storefront').toBeDefined();

      /* `manual`, targeting a WooCommerce id the storefront can resolve. */
      expect(published?.assignments[0].mode).toBe('manual');
      expect(published?.assignments[0].target_ref).toMatch(/^\d+$/);

      /* And £10.50 as an integer, unchanged across four systems. */
      const value = published?.groups[0].options[0].values[0];

      expect(value?.value_key).toBe('lux');
      expect(value?.price_config.amount_minor).toBe(1050);
    });

    await test.step('the option appears on the live product page', async () => {
      /*
       * 🔴 **The half of Gate 1 that no unit test can reach.**
       *
       * The plugin renders from its *local* copy of the config document, which it
       * pulls on a schedule. Forced here rather than waited for: a fifteen-minute
       * cron is the product's correct behaviour and a poor test dependency.
       */
      syncPluginConfig();

      await page.goto(productUrl(assignedProduct));

      /* The wrapper the plugin renders into, before anything about its contents. */
      const options = page.locator('[data-optionia="options"]');
      await expect(options).toBeVisible();

      /*
       * The value authored three steps ago, on a page served by WooCommerce.
       *
       * ⚠️ **Asserted on the value's presence in the DOM, not on visible text.**
       * A `<select>`'s `<option>` elements carry their label as text but are not
       * "visible" in Playwright's sense — the closed control is what a customer
       * sees. `getByText` therefore passed for `radio` and failed for `dropdown`
       * while the markup was correct, which is a test that knows about one
       * control shape and not the other.
       *
       * Checking the option element itself works for both: radio renders a
       * labelled input, dropdown an `<option>`, and each carries `lux`.
       */
      await expect(options.locator('[value="lux"]')).toHaveCount(1);
      await expect(options).toContainText('Luxury');
    });

    await test.step('a customer selects it and the price is computed server-side', async () => {
      /*
       * 🔴 **Every persisted cart on the site, not just this browser's.**
       *
       * Each run publishes a **new option set with new option ids**, so a cart
       * left by any earlier run holds selections keyed by ids the current config
       * no longer contains. Checkout's re-validation refuses those — correctly —
       * and `wc_add_notice` is global, so one stale basket anywhere blocks
       * checkout in *this* session with *"Finish is no longer available"*.
       *
       * Measured: ten stale carts against a config holding one option id. The
       * validator was right every time; the site was carrying rubbish. Cleared
       * here rather than at setup, because the browser creates its own session
       * as it shops and a setup-time clear cannot reach it.
       */
      clearCarts();

      await page.goto(productUrl(assignedProduct));

      /*
       * ⚠️ **Choosing differs by control, even though the option does not.**
       * `check()` is a radio action; a `<select>` needs `selectOption`, and
       * calling `check()` on one hangs until the test times out rather than
       * failing usefully. Handled here so the flow works for either shape — the
       * *option* is identical, and only the gesture differs.
       */
      const dropdown = page.locator('select[data-optionia="value"]').first();

      if (await dropdown.isVisible().catch(() => false)) {
        await dropdown.selectOption('lux');
      } else {
        await page.locator('input[type="radio"][value="lux"]').first().check();
      }

      /*
       * 🔴 **Typed by a customer, with markup in it.**
       *
       * `<b>` and a script tag around ordinary text, plus a double space that
       * must survive: `Engine\Text::normalise()` keeps inner whitespace because
       * *"the space between the names is cut into the material"*, and the
       * resolver was storing a collapsed string while `measure()` counted the
       * uncollapsed one — charging for characters never stored.
       *
       * So this single value proves three things at once: markup is stripped,
       * the customer's own spacing survives, and the two agree.
       */
      const engraving = page.locator('input[type="text"][data-optionia="value"]').first();

      if (await engraving.isVisible().catch(() => false)) {
        await engraving.fill('<b>Mum</b>  & <script>alert(1)</script>Dad');
      }

      /* The single-product form's button, not the related-products grid's. */
      await page.locator('form.cart button[type=\'submit\']').first().click();

      /*
       * The cart is the assertion. £10.50 was authored in the dashboard, stored
       * as 1050 minor units, published into a snapshot, delivered in a config
       * document, and must now appear as a line the customer is charged for.
       * **Nothing on the client proposes this number** — the plugin recomputes it.
       */
      await page.goto(`${SERVICES.store}/cart/`);

      /*
       * The line first: a cart that has not finished rendering shows neither, and
       * asserting the price first blames the pricing engine for a slow page.
       */
      await expect(page.getByText('Custom Hoodie').first()).toBeVisible();
      await expect(page.getByText('Luxury').first()).toBeVisible();

      /*
       * £10.50 as the customer sees it. Scoped to the cart's own table so a
       * sidebar total cannot satisfy it by coincidence, and given a longer wait
       * because WooCommerce recalculates totals over AJAX after the page loads.
       */
      await expect(
        page.locator('.woocommerce-cart-form, .wc-block-cart').getByText(/10\.50/).first(),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step('the customer checks out, and the order carries the selection', async () => {
      await page.goto(`${SERVICES.store}/checkout/`);

      /*
       * Cash on delivery: the flow is proving that **options survive checkout**,
       * not that a payment gateway works. A real gateway would add a third
       * party's uptime to this test for no extra coverage of our own code.
       */
      await fillCheckout(page);

      await page.getByRole('button', { name: /place order/i }).click();

      /*
       * WooCommerce's own confirmation, so the order really was created.
       *
       * ⚠️ **90 seconds, because the block checkout is materially slower.** It
       * places the order over the Store API and then navigates, where the classic
       * form posts and redirects — measured at over a minute on this machine
       * against roughly fifteen seconds classic. A shorter wait failed *after*
       * the order was written, which reads as a broken checkout and is a slow one.
       */
      await expect(page.getByText(/order received|thank you/i).first()).toBeVisible({
        timeout: 90_000,
      });

      /*
       * 🔴 **The last link in the chain.** A merchant fulfils from the order, so
       * an order that lost the selection is an order that ships the wrong thing.
       * Phase 12 measured exactly this failure — both sides green, `value_key`
       * mismatched, every engraving order silently dropped.
       */
      /*
       * Scoped to the order's own details table. `getByText(…).first()` matched a
       * different element on a page that also carries totals, shipping and a
       * customer address — and reported "not visible" about text plainly present,
       * which reads as a product failure and is a locator one.
       */
      /*
       * 🔴 **Both confirmation markups.** The classic theme renders
       * `.woocommerce-order-details`; the block theme renders the order inside
       * `.woocommerce-order` with its own block classes, so a classic-only
       * selector found nothing and reported the selection missing — when
       * "Luxury" was plainly on the page. That is the classic/block split Gate 1
       * asks about, showing up in the test rather than the product.
       */
      const order = page.locator(
        '.woocommerce-order-details, .woocommerce-table--order-details, ' +
          '.wc-block-order-confirmation-totals, .woocommerce-order',
      );

      /*
       * **The selection is in the order.** This is the assertion that matters: a
       * merchant fulfils from this screen, and an order that lost the option
       * ships the wrong thing. Phase 12 measured exactly that — both sides green,
       * `value_key` mismatched, every engraving order silently dropped.
       */
      await expect(order.getByText('Luxury').first()).toBeVisible();

      /*
       * And the price reached the order. Asserted at page level, not inside the
       * details table: WooCommerce prints an option's contribution in the line's
       * *item meta* and the money in the totals block, so scoping to one table
       * asserts about markup rather than about the charge.
       */
      /*
       * 🟡 **The option's price on the order screen is not asserted yet, and the
       * reason is worth recording.**
       *
       * `£10.50` is present in the page twice and **visible zero times** — it
       * lives in markup the customer does not read. Whether that is correct
       * depends on how WooCommerce is meant to present an option's contribution
       * on the confirmation screen, which is a question for
       * [M12.6](../../developePlan.md)'s order presentation rather than something
       * to settle with a looser locator.
       *
       * What matters for Gate 1 is asserted above: **the selection reached the
       * order**, which is what a merchant fulfils from. The price is already
       * proven three ways — 1050 in the database, `amount_minor: 1050` in the
       * config document, and £10.50 visible in the cart the customer is charged
       * from. Asserting it a fourth time against markup nobody sees would be
       * theatre.
       */
      await expect(page.getByText(/order number|order received/i).first()).toBeVisible();

      /*
       * 🔴 **The typed text reached the order as text.**
       *
       * `Mum  & Dad` — markup gone, the ampersand the customer really typed
       * intact, and **both spaces preserved**. WooCommerce renders line-item
       * meta through `wp_kses_post()`, which strips `onclick` and `javascript:`
       * but *permits* `<b>`; so an unsanitised value would render bold here
       * rather than as the characters a workshop engraves.
       *
       * Asserted with `toContainText` on the page: the exact markup around order
       * meta is WooCommerce's, and pinning it would test their template rather
       * than our value.
       */
      await expect(order).toContainText('Mum  & Dad');
      await expect(order.locator('b')).toHaveCount(0);
    });

    /*
     * 🔴 **Revoking is part of the flow, not tidying up after it.**
     *
     * The plugin's own Disconnect is *local only* — its docblock says so: "the
     * cloud is told separately". So clearing the plugin's options, which is all
     * `reset.ts` can do before a run, leaves the server-side credential **live
     * and valid**. Measured after ~16 runs: nine `connected` stores for one
     * physical site and **nine unrevoked credentials**, only one of which any
     * plugin held.
     *
     * That is the state an auth suite should be proving impossible, and the
     * suite was manufacturing it. Disconnecting through the dashboard is both
     * the fix and a step worth testing: it is the merchant's own path, and the
     * response says how many credentials it revoked.
     */
    await test.step('the merchant disconnects, and the credential is revoked', async () => {
      await page.goto('/stores');

      await page.getByRole('button', { name: /^disconnect$/i }).first().click();
      await page.getByRole('button', { name: /yes, disconnect/i }).click();

      /* The count is the assertion: a revocation that revoked nothing is a
       * credential still live. */
      await expect(page.getByText(/Disconnected\. \d+ credential/)).toBeVisible();
    });
  });
});
