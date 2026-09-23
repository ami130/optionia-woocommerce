import { expect, test } from '@playwright/test';

import { newMerchant, verifyEmail, type Merchant } from './fixtures';
import {
  assignProductCategory,
  assignedExternalId,
  connectedStoreId,
  productUrl,
  isMirrored,
  mirroredCount,
  plantPhantomProduct,
  pushCatalogue,
  reconcileCatalogue,
  restoreProduct,
  removeProductCategory,
  storeToken,
  syncPluginConfig,
  trashProduct,
  unassignedExternalId,
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
 * The category the taxonomy step authors, creates and cleans up.
 *
 * One constant because three places must agree: the reference typed into the
 * dashboard, the term created on the store, and the term removed afterwards. A
 * literal repeated three times resolves to nothing the moment one of them is
 * edited, and resolving to nothing is exactly the passing-for-the-wrong-reason
 * this step exists to rule out.
 */
const CATEGORY_SLUG = 'summer';

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

    await test.step('the first run leads with templates, and offers a blank canvas', async () => {
      await page.goto('/option-sets');

      /*
       * 🔴 **The only behavioural cover for the first-run screen.**
       *
       * Everything else about this screen is asserted from source, which can say
       * what the code contains and never what a merchant sees. Two defects found
       * in Step 0 lived exactly here: the template picker was rendered without a
       * store and every card failed on click, and the header's "New option set"
       * button re-offered the blank canvas above the templates.
       *
       * ⚠️ **This step also catches the rename.** ADR-087 replaced "Create your
       * first option set" with "Start from scratch" and hid the header button
       * until a set exists — so the selector this step used to carry matched
       * nothing on a first run, and the canonical flow would have failed here.
       */
      await expect(page.getByText(/start from a template/i)).toBeVisible();

      /*
       * The store is connected by this point, so the picker must be offering
       * real cards rather than the "connect a store first" refusal.
       */
      await expect(page.getByRole('button', { name: /t-shirt printing/i })).toBeVisible();
      await expect(page.getByText(/connect a store first/i)).toHaveCount(0);

      /* Templates lead; the blank canvas is present but secondary (ADR-087). */
      await expect(page.getByRole('button', { name: /start from scratch/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /^new option set$/i })).toHaveCount(0);
    });

    await test.step('the merchant creates an option set', async () => {
      /*
       * Gate 1's script authors a set by hand, so it takes the blank canvas
       * deliberately — the template path is asserted above rather than used
       * here, because adapting a template would test M20b.4 in the middle of a
       * flow that is about publishing.
       */
      await page.getByRole('button', { name: /start from scratch/i }).click();
      await page.locator('input[name="name"]').fill(SET_NAME);
      await page.getByRole('button', { name: /^create$/i }).click();

      await expect(page.getByText(SET_NAME).first()).toBeVisible();
    });

    await test.step('with a radio option worth +£10', async () => {
      await page.getByText(SET_NAME).first().click();
      await page.waitForURL(/\/option-sets\/[0-9a-f-]{36}/, { timeout: 30_000 });

      /*
       * A group holds related options — Gate 1's script says one radio.
       *
       * `#new-group-label` rather than the placeholder: the input gained that
       * id at M19.1' when its `<label>` was bound to it, which it had never
       * been. `.first()` is gone with it — an id is unique, so there is nothing
       * to disambiguate.
       */
      await page.locator('#new-group-label').fill('Finish');
      await page.getByRole('button', { name: /add group/i }).click();

      await expect(page.getByRole('button', { name: /add option/i })).toBeVisible();

      /*
       * Label, then key: the key is what the plugin indexes by.
       *
       * 🔴 **Addressed by `id`, not by placeholder — the previous locators
       * could never match.** This block used to wait for
       * `getByPlaceholder('finish')`, explaining that the group and option
       * inputs "share the placeholder `Finish`". They never did: the group's is
       * `Finish`, the option's are `Colour` and `colour`, and `git log -S` puts
       * those in the very commit that wrote this spec. The suite has therefore
       * **never got past this line** — it timed out here for five stages while
       * the authoring page was rewritten three times (18-6, 18-6a, 18-6b).
       *
       * ⚠️ **A placeholder is example copy, not an address.** It changes when a
       * writer picks a friendlier word, and nothing fails until someone runs the
       * suite.
       *
       * ⚠️ **A PREFIX selector, because the ids carry the group id** since
       * 20-2d — `option-label-<groupId>`. `AddOption` renders once per group,
       * so fixed ids collided as soon as a set had two; scoping them made the
       * markup valid and the exact id unknowable from here. This flow creates
       * one group, so the prefix resolves to one element — and would fail
       * loudly rather than silently pick a side if that ever changed.
       *
       * `[id^="option-label-"]` and `[id^="option-key-"]` are the ids
       * the page already
       * sets for its own `<label for=…>`, so they are load-bearing markup: a
       * rename breaks the form's own accessibility, which is a failure the
       * dashboard's own guards catch.
       */
      await page.locator('[id^="option-label-"]').fill('Finish');

      /*
       * The key auto-derives from the label, so it already reads `finish`.
       * Filled explicitly anyway: the derivation stops the moment a merchant
       * edits the key by hand, and this asserts the value the plugin indexes by
       * rather than trusting a convenience to have run.
       */
      await page.locator('[id^="option-key-"]').fill('finish');

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
      /*
       * 🔴 **A button grid, not a `<select>`** — and it always was. This line
       * read `getByLabel('Type').selectOption('dropdown')`, a control the page
       * has never rendered: `git log -S` puts "What kind of option?" in the very
       * commit that wrote this spec. Addressed by `data-option-type`, the value
       * the API stores, rather than the button's visible label.
       */
      await page.locator('[data-option-type="dropdown"]').click();

      await page.getByRole('button', { name: /add option/i }).click();

      /*
       * The value carries the price. £10.50 rather than a round £10: a decimal
       * that is not representable in binary floating point is the one that
       * catches an engine multiplying instead of scaling as text.
       */
      /*
       * 🔴 **Addressed by `id`, like the option fields above.** These used to be
       * `getByPlaceholder('Luxury' | 'lux' | '10.50', { exact: true })`, which
       * matched only because nobody had changed that example copy yet — the same
       * fragility that left the option fields unreachable for five stages. The
       * value form renders once per option, so its ids are scoped by option id;
       * `^=` anchors on that prefix, and there is exactly one option here.
       */
      const valueLabel = page.locator('[id^="value-label-"]');

      await expect(valueLabel).toBeVisible();
      await valueLabel.fill('Luxury');
      await page.locator('[id^="value-key-"]').fill('lux');
      await page.locator('[id^="value-price-"]').fill('10.50');
      await page.getByRole('button', { name: /add value/i }).click();

      /*
       * The price rendered back is the proof the amount survived the round trip.
       *
       * ⚠️ **`Luxury (lux)` — the value row, not the bare word.** Plain
       * `getByText('Luxury')` now matches three elements: this row and two
       * `<option>`s in the rule builder's selects, which did not exist when this
       * line was written. Strict mode refused it rather than silently asserting
       * on a dropdown entry, which would have "passed" without ever proving the
       * value rendered.
       */
      await expect(page.getByText('Luxury (lux)')).toBeVisible();
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
      /*
       * 🔴 **No "open the form" click — there is no such control.** This step
       * began by clicking `Add option`, but that button is the form's *submit*
       * and is `disabled` until the draft validates, so the click waited three
       * minutes on a permanently disabled element. The group renders an empty
       * option form continuously; authoring a second option means filling the
       * one already on screen.
       *
       * The same `id` addressing as the dropdown above — this block carried an
       * identical copy of the placeholder locators that could never match, so
       * fixing only the first would have moved the timeout here rather than
       * removed it.
       */
      await page.locator('[id^="option-label-"]').fill('Engraving');
      await page.locator('[id^="option-key-"]').fill('engraving');
      await page.locator('[data-option-type="text_field"]').click();
      await page.getByRole('button', { name: /add option/i }).click();

      /*
       * `.first()` for the same reason as `Luxury (lux)` above: an option's name
       * also appears in the rule builder's selects, so a bare `getByText` is a
       * strict-mode violation the moment rules exist on the page.
       */
      await expect(page.getByText('Engraving').first()).toBeVisible();

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

    /**
     * A second group, and the pane switch between them (20-2d).
     *
     * 🔴 **The only browser test of selection.** Unit tests cover it — breaking
     * the click handler fails four of them — but `jsdom` has no layout and no
     * viewport, and 20-2d changed the editor from *"every group's fields are on
     * screen"* to *"one group's are"*. That is an interaction change, and the
     * suite that exercises a real browser never created a second group.
     *
     * ⚠️ **It also guards the defect 2d-a found.** `AddOption` used fixed ids
     * rendered once per group, so two groups put duplicate `#option-label` in
     * one document — invalid HTML, and a `<label>` binding to the wrong field.
     * The prefix locator below would resolve to two elements and fail rather
     * than silently pick one, which is exactly what should happen.
     */
    await test.step('a second group, and switching between them', async () => {
      await page.locator('#new-group-label').fill('Size');
      await page.getByRole('button', { name: /add group/i }).click();

      /* Both groups stay listed, whichever is being edited. */
      await expect(page.getByRole('button', { name: 'Size', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();

      /*
       * 🔴 **Exactly one add-option form, however many groups exist.** The
       * assertion 20-2d exists to satisfy: before it each group rendered its
       * own, and at twenty groups of thirty options the page mounted six
       * hundred option blocks.
       */
      await expect(page.locator('[id^="option-label-"]')).toHaveCount(1);

      /* Choosing the first group again moves the editor back to it. */
      await page.getByRole('button', { name: 'Finish', exact: true }).click();

      await expect(page.locator('[id^="option-label-"]')).toHaveCount(1);
      await expect(page.getByText('Engraving').first()).toBeVisible();
    });

    await test.step('the store pushes its catalogue to the cloud', async () => {
      /*
       * 🔴 **The real push, not the stand-in.** This step used to call
       * `importProducts()`, which writes `store_products` with **raw SQL** —
       * so the flow passed whether or not an ingest endpoint existed at all.
       * M19.1 replaced it: the plugin reads its own catalogue with
       * `wc_get_products()` and posts to `POST /v1/store/products`, which is
       * the path a merchant's store uses. ADR-067: the store pushes, because
       * the cloud holds no WooCommerce credentials and AC8 forbids it.
       */
      const storeId = connectedStoreId();
      expect(storeId, 'the store should be connected by now').not.toBeNull();

      pushCatalogue();

      /*
       * 🔴 **Asserted through the dashboard, which reads the cloud.** A count
       * taken from the database would pass for rows the stand-in could have
       * written with SQL — the very distinction this step exists to draw. The
       * picker renders `GET /v1/products` against the merchant's own session,
       * so a product visible there travelled the whole path: WooCommerce →
       * plugin → `POST /v1/store/products` → the mirror → the dashboard.
       */
      await page.goto('/products');

      await expect(
        page.getByText(/no products have arrived from your store/i),
        'the empty state must be gone once a real push has landed',
      ).toHaveCount(0);

      /*
       * ⚠️ **Back to the set before the next step.** That step calls
       * `page.reload()`, which reloads wherever the browser happens to be —
       * so leaving it on `/products` pointed the reload at a page with no
       * picker, and the assign step failed looking for a button that was never
       * on it. Navigating away in a test is a side effect on the steps after.
       */
      await page.goto('/option-sets');
      await page.getByText(SET_NAME).first().click();
      await page.waitForURL(/\/option-sets\/[0-9a-f-]{36}/, { timeout: 30_000 });
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

    /**
     * 🔴 **Edit an existing value, THEN publish — the sequence no gate covered.**
     *
     * M20.10 stopped refetching the tree after an edit and patched the cache
     * instead, which saved a request and left the set's `rowVersion` stale: the
     * backend advances it on every child edit (`ParentSetService`), but an edit
     * response carries only the entity. `publishSet` sends that token and the
     * API answered **409 "This option set was changed by someone else."** — a
     * conflict the merchant caused themselves one second earlier.
     *
     * ⚠️ **Every suite stayed green** because this file created values and
     * published, and never *edited* one first. The defect needed exactly this
     * order to appear, so the fix is worth nothing without a step that proves it.
     */
    await test.step('an edited value still publishes', async () => {
      const row = page.locator('[data-value-row]');

      /*
       * ⚠️ **Edited, then edited back.** Five later steps assert on `Luxury` —
       * the storefront render, the price calculation and the order line. This
       * step exists to exercise the *edit → publish* sequence, not to change
       * what the rest of the flow sees, so it restores the label before moving
       * on. The `rowVersion` the defect turned stale advances on **both**
       * writes, so the 409 would still fire if it came back.
       */
      await page.getByRole('button', { name: /^Edit /i }).first().click();
      await expect(row).toBeVisible();

      await row.locator('[id^="label-"]').fill('Matte black');

      /*
       * Autosave commits when focus leaves the row — there is no Save button.
       *
       * 🔴 **Clicking a heading is the real interaction, and it found a bug.**
       * A heading is not focusable, so the browser reports `relatedTarget:
       * null` — indistinguishable from a window switch by that field alone.
       * The first implementation skipped the save for both and lost the edit.
       * `document.hasFocus()` separates them; this step is what proved it.
       */
      await page.getByRole('heading', { name: 'Finish', exact: true }).click();

      await expect(row).toBeHidden();

      /*
       * 📌 **Scoped to the value list**, because the edited label also reaches
       * the rule builder's target pickers — rendered from the same cached tree.
       * That is itself the patch working: nothing refetched, and three places
       * show the new label.
       */
      await expect(page.getByText('Matte black (lux)')).toBeVisible();

      /* Back to what the rest of the flow expects — a second patched edit. */
      await page.getByRole('button', { name: /^Edit /i }).first().click();
      await expect(row).toBeVisible();
      await row.locator('[id^="label-"]').fill('Luxury');
      await page.getByRole('heading', { name: 'Finish', exact: true }).click();

      await expect(row).toBeHidden();
      await expect(page.getByText('Luxury (lux)')).toBeVisible();
    });

    /*
     * 🔴 **The preview, in a real browser.** Every other test of it runs in
     * `jsdom`, which has no layout — and this repository has already shipped a
     * crushed layout for exactly that reason. The canonical flow already renders
     * the preview (it is on this page), so asserting it costs one step and no
     * setup.
     *
     * ⚠️ **Scoped to the preview's own section**, because the value's label also
     * appears in the editor above it — a page-level check would pass on the
     * editor and prove nothing about the preview.
     */
    await test.step('the preview shows the customer what they will get', async () => {
      const preview = page.getByRole('region', { name: 'What your customer sees' });

      await expect(preview).toBeVisible();
      await expect(preview.getByText('Luxury')).toBeVisible();

      /*
       * The base is stated, never implied (ADR-107). A number a merchant could
       * mistake for "what my customer pays" is worse than no number.
       */
      await expect(preview.getByText(/priced against/)).toBeVisible();

      /* Three widths, and the frame narrows (M21.2, ADR-108). */
      await preview.getByRole('button', { name: 'Phone' }).click();
      await expect(preview.getByRole('button', { name: 'Phone' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    await test.step('the merchant publishes', async () => {
      /*
       * 🔴 **The button is in the header now, and the label is shorter.** It
       * read *"Publish to storefront"* and sat below the groups, the rules, the
       * preview and the product picker — several screens down on a real set,
       * while the unpublished notice at the top told the merchant to publish
       * and offered no way to. Beside the set's own name the destination is
       * implied, so the label is just *"Publish"*.
       *
       * ⚠️ **`exact` matters here.** The panel below still owns the findings
       * and the history under a *"Publishing"* heading, and a loose match would
       * also find the button's own *"Publishing…"* pending state.
       */
      const publish = page.getByRole('button', { name: 'Publish', exact: true });

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

    await test.step('the dashboard checklist reflects what the merchant just did', async () => {
      /*
       * 🔴 **The only proof the checklist tracks reality (M20b.1, M20b.2).**
       *
       * Everything else about it is unit-tested against a fixture, which can
       * show the component renders a given state correctly and never that the
       * state *arrives*. This walks the real funnel: by now the merchant has
       * verified, connected, synced, created, assigned and published — so the
       * setup list must be complete, and it is complete only if every one of
       * those steps was derived correctly from the domain tables.
       *
       * ⚠️ **This step does NOT prove the cache invalidation, and it was written
       * believing it did.** Two mutations were needed to establish that:
       * removing the publish path's `invalidateActivation` left it green with
       * `page.goto` (a full page load discards the cache), and *still* green
       * after switching to the nav link — because roughly eighty seconds of
       * test elapse between the dashboard's first load and this assertion, far
       * past the 30-second `staleTime`, so the query refetches on mount whatever
       * invalidated it.
       *
       * What it *does* prove is the part no unit test can: that the funnel's
       * eight steps derive correctly from the real domain tables after a real
       * merchant journey. The invalidation is covered by
       * `lib/activation/cache.test.ts`, which enumerates every screen that must
       * call it.
       *
       * The nav link is kept anyway — it is how a merchant actually returns here.
       */
      await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
      await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });

      await expect(page.getByText(/8 of 8 complete/)).toBeVisible();

      /* Complete, so the dismiss control is offered (ADR-093). */
      await expect(page.getByRole('button', { name: /hide this checklist/i })).toBeVisible();

      /* And the value-realized section appears once published. */
      await expect(page.getByText(/Since you published/)).toBeVisible();
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
       * £10.50 as the customer sees it. Scoped to the cart's own container so a
       * sidebar total cannot satisfy it by coincidence, and given a longer wait
       * because WooCommerce recalculates totals over AJAX after the page loads.
       *
       * 🔴 **The surface is named, not guessed.**
       *
       * ✏️ **This read `.woocommerce-cart-form, .wc-block-cart` until 21b's
       * analysis** — an either/or that passes on whichever surface the store
       * happens to render, and never records which. Measured against the live
       * store: it serves `wc-block-cart`, so the classic branch had **never**
       * matched. A locator that reads as covering two surfaces while proving one
       * is worse than a locator that covers one: it hides the gap it creates.
       *
       * ⚠️ **Asserting the container first is deliberate.** If the store is
       * reconfigured to the classic cart, this fails with *"cart surface not
       * found"* rather than silently proving nothing — which is the failure mode
       * the either/or had.
       */
      const cart = page.locator('.wc-block-cart');

      await expect(cart, 'the Cart block should be the surface under test').toBeVisible({
        timeout: 30_000,
      });
      await expect(cart.getByText(/10\.50/).first()).toBeVisible({ timeout: 30_000 });

      /*
       * 🔴 **The breakdown, in a real browser** (M21b.1, M21b.2).
       *
       * Unit tests prove the rows are built; only this proves WooCommerce
       * renders them. The base row is the one M21b.1 added, so it is the row
       * with no history of appearing on any surface — and
       * `CartItemSchema::get_item_data()` discards a whole element **silently**
       * if any value is not scalar, which is a failure no unit test of ours
       * would see.
       *
       * ⚠️ **Scoped to the cart, not the page.** The product page shows the same
       * option and price, so a page-level check would pass on markup the
       * customer left behind two steps ago.
       */
      await expect(
        cart.getByText('Base price'),
        'the base row should reach the cart a customer actually sees',
      ).toBeVisible({ timeout: 30_000 });

      /*
       * 🔴 **A second surface, because one is not four** (M21b.2).
       *
       * The mini-cart widget renders the same rows through the same filter —
       * `mini-cart.php:80` calls `wc_get_formatted_cart_item_data()`, which
       * applies `woocommerce_get_item_data`. Asserting it here proves the shared
       * filter *in a browser* rather than only from reading WooCommerce's
       * source, and it costs one navigation because the widget is on the home
       * page.
       *
       * ⚠️ **The classic cart and the Checkout block summary remain unasserted**
       * — this store renders neither, so proving them needs a differently
       * configured store rather than another locator.
       */
      await page.goto(`${SERVICES.store}/`);

      const miniCart = page.locator('.widget_shopping_cart_content');

      await expect(
        miniCart.getByText('Luxury'),
        'the mini-cart widget should render the same breakdown',
      ).toBeVisible({ timeout: 30_000 });
      await expect(miniCart.getByText('Base price')).toBeVisible({ timeout: 30_000 });

      /*
       * 🔴 **The customised UNIT price, which nothing else asserts** (M21b.2).
       *
       * `mini-cart.php:81` renders `quantity × product_price`, and
       * `WC()->cart->get_product_price()` reads the price **after**
       * `CartTotals::set_price()` — so this is base £80.00 plus the £10.50
       * option, and it is one of the four figures the milestone names.
       *
       * ⚠️ **The rest of the flow proves the DELTA (£10.50) and the line total;
       * neither is this number.** A per-unit price that silently stayed at the
       * base would leave every other assertion passing — which is the
       * double-multiplication family of bug, seen from the display side.
       */
      await expect(
        miniCart.getByText(/90\.50/),
        'the mini-cart should price the unit at base plus the option',
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
      /*
       * ⚠️ **`.first()` — the selectors nest, and all three now match.**
       * `.woocommerce-order` wraps `.woocommerce-order-details`, which wraps the
       * details table, so this list resolved to three elements and strict mode
       * refused every assertion built on it. The outermost is the right one:
       * every assertion below asks whether something is *somewhere in the
       * order*, and the widest container is what makes that true regardless of
       * which theme rendered it.
       */
      const order = page
        .locator(
          '.woocommerce-order-details, .woocommerce-table--order-details, ' +
            '.wc-block-order-confirmation-totals, .woocommerce-order',
        )
        .first();

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

    /**
     * A category assignment, authored in the dashboard and **resolved** by the
     * plugin (M19.4).
     *
     * ✏️ **This step asserted the opposite until M19.4, and was right to.**
     * While taxonomy was deferred, `skipped_count()` **rose** when a merchant
     * authored a category, and the acceptance was that the target arrived
     * *visibly deferred* rather than silently dropped. M19.4 resolves those
     * targets, so the count now falls to zero — the handover signal that
     * `ProductIndex::skipped_count()`'s own docblock names.
     *
     * 🔴 **Zero is NOT the assertion, because zero is also the state before.**
     * Measured on the live store: with the category assignment removed the
     * index reads `skipped=0 terms=0`, and with it `skipped=0 terms=1` —
     * `entry_count()` is `1` either way. Both counters the admin screen prints
     * are **identical before and after this step**, so asserting the row would
     * pass against an assignment that never arrived. `terms` is what changed,
     * and no status row reports it.
     *
     * So the acceptance is the **render**, which is what a merchant sees and
     * the only non-vacuous signal available: a product the set is *not*
     * assigned to shows its options once it joins the category. The control
     * matters — run against the directly-assigned product this would pass
     * through the manual path and prove nothing about taxonomy.
     *
     * ⚠️ **The category must be real.** Taxonomy targets are carried, not
     * expanded (ADR-068): `build()` stores the slug without checking that the
     * term exists, and `has_term()` decides at render. So the term is created
     * and the product put in it here — an assignment to a category no product
     * is in resolves to nothing, correctly, and would read as a defect.
     *
     * ⚠️ **No resync after the category changes.** The document already
     * carries the target; resolution happens against the *live* product at
     * render, which is the property ADR-068 chose this design for. Verified on
     * the store: the product went from 0 option groups to 4 on the category
     * alone, with no new config fetch.
     */
    await test.step('a category assignment resolves on the storefront', async () => {
      await page.goto(`/option-sets`);
      await page.getByText(SET_NAME).first().click();

      /*
       * The type defaults to Category, so only the reference is typed. The
       * button is "Assign target", not "Assign": the catalogue rows above use
       * the latter, and two buttons sharing one accessible name would leave
       * this resolving by render order.
       */
      await page.getByLabel(/^reference to assign$/i).fill(CATEGORY_SLUG);
      await page.getByRole('button', { name: /^assign target$/i }).click();

      /* The row appears named by its type, so a merchant can tell it from a tag. */
      await expect(page.getByText(CATEGORY_SLUG).first()).toBeVisible();

      /*
       * 🔴 **No republish, deliberately.** `ConfigDocumentBuilder` joins
       * assignments **live** and overwrites whatever the snapshot holds — that
       * is why assignments can change without a new version, and why step 4
       * needed no serializer change. The set was published earlier in this
       * flow; this assignment reaches the document on the plugin's next sync.
       */

      /*
       * ⚠️ **The plugin has no manual sync control** — config arrives on
       * `optionia_cron_sync_config`. `syncPluginConfig()` runs that event
       * through WP-CLI, which is how the rest of this suite advances the
       * plugin's view rather than waiting on a schedule it does not control.
       */
      syncPluginConfig();

      /*
       * A product the set is NOT assigned to — the control. Read from the
       * mirror rather than hardcoded, so a rebuilt fixture store cannot leave
       * this pointing at an id that no longer exists.
       *
       * ⚠️ **The store is named, not inferred.** `reset.ts` leaves the
       * backend's `stores` row behind by design, so several rows for this URL
       * read `connected` at once and "the connected store" is not a question
       * `storeUrl` alone can answer. `connectedStoreId()` is the one place
       * that resolves it — passing its result keeps a second selector from
       * existing here and drifting away from it.
       */
      const controlStore = connectedStoreId();

      expect(controlStore, 'the store should still be connected').not.toBeNull();

      const controlProduct = unassignedExternalId(String(controlStore), SET_NAME);

      expect(controlProduct, 'the store should hold an unassigned product').not.toBe('');

      /*
       * 🔴 **The negative first.** Without this the positive below proves
       * nothing: a product that already rendered the set would satisfy it
       * whether or not the category resolved. Asserting the "before" is what
       * makes the "after" evidence.
       */
      await page.goto(productUrl(controlProduct));
      await expect(page.locator('.optionia-group')).toHaveCount(0);

      const termId = assignProductCategory(Number(controlProduct), CATEGORY_SLUG);

      try {
        /*
         * Deliberately no `syncPluginConfig()` — see the step docblock. The
         * target is already in the document; only the product's terms changed,
         * and resolution reads those live.
         */
        await page.goto(productUrl(controlProduct));

        /*
         * The set renders now, and it did not a moment ago. That difference is
         * the whole acceptance for M19.4.
         */
        await expect(page.locator('.optionia-group').first()).toBeVisible();
      } finally {
        /*
         * ⚠️ **Cleanup in `finally`, and it matters.** The category outlives
         * the run otherwise, and the *next* run's negative assertion above
         * would fail — a green suite turning red on a second run, blaming the
         * renderer for a fixture this step left behind.
         */
        removeProductCategory(Number(controlProduct), CATEGORY_SLUG, termId);
      }
    });

    /**
     * A deleted product does not break anything (M19.6).
     *
     * 🔴 **The assignment survives the product, and that is by design.** There
     * is no foreign key from `option_set_assignments.targetRef` to
     * `store_products` — the product lives on the merchant's site, not in the
     * cloud — so removing the mirror row leaves the assignment live and
     * pointing at nothing. Proven in a rolled-back transaction while planning
     * this: deleting the row left the assignment count unchanged and orphaned.
     *
     * The milestone's acceptance is *"no orphan errors on the storefront"*, and
     * both halves are asserted here:
     *
     * - the **dashboard** names it — `readAssignments()` uses a `LEFT JOIN`
     *   *specifically* so an orphan stays visible, because *"an inner join
     *   would hide exactly the rows that need attention"*;
     * - the **storefront** keeps serving — the plugin indexes the dead id, and
     *   since no such product exists nothing ever asks for it.
     *
     * ⚠️ **Trashed, not force-deleted.** `ProductWatcher` listens on
     * `trashed_post` because the admin's own *Move to Trash* fires only that
     * (ADR-074); forcing a permanent delete would exercise a different hook
     * than a merchant does.
     */
    await test.step('a deleted product leaves the storefront working', async () => {
      /*
       * The product this flow assigned earlier — deleting the *control* would
       * prove nothing, since it has no assignment to orphan.
       */
      const storefront = productUrl(assignedProduct);

      /* It renders now; the point is that it still behaves after the delete. */
      await page.goto(storefront);
      await expect(page.locator('.optionia-group').first()).toBeVisible();

      trashProduct(assignedProduct);

      try {
        /* The plugin queues the removal and the drain rides the push cron. */
        pushCatalogue();

        /*
         * The dashboard names the orphan rather than hiding it or erroring.
         */
        await page.goto(`/option-sets`);
        await page.getByText(SET_NAME).first().click();

        await expect(page.getByText(/No longer in your catalogue/i).first()).toBeVisible();

        /*
         * 🔴 **The storefront still answers.** A trashed product's own page is
         * gone, so this checks a page that still exists — the shop — and that
         * it renders rather than fataling on an assignment pointing at nothing.
         */
        const shop = await page.goto(`${SERVICES.store}/?post_type=product`);

        expect(shop?.status()).toBeLessThan(500);
      } finally {
        /*
         * ⚠️ Restore inside `finally`, or every later run starts a product
         * short. `wp_untrash_post()` restores the previous status on its own —
         * measured, rather than the `draft` an earlier draft of this assumed.
         */
        restoreProduct(assignedProduct);
        pushCatalogue();
      }
    });

    /**
     * The mirror repairs its own drift (M19.3).
     *
     * 🔴 **The one operation in this phase that can DESTROY merchant data**,
     * and until now the least proven end to end. Both halves are covered in
     * isolation — twelve API tests and thirteen plugin tests — but nothing
     * showed the plugin's manifest and the cloud's comparison agreeing against
     * a real store. A sweep that deleted too much would pass every one of those
     * suites and still empty a merchant's catalogue.
     *
     * ⚠️ **A phantom is planted rather than produced.** WordPress hooks are
     * best-effort by design: a deletion while the site is offline, or a queue
     * entry dropped by `ProductQueue::MAX_ENTRIES`, is what leaves the mirror
     * holding a product the store no longer sells. Nothing in the normal flow
     * creates that on demand, so the row is written directly — it is the
     * precondition, not the behaviour under test.
     *
     * 📌 **The real products are the assertion that matters.** "The phantom is
     * gone" alone would pass for a sweep that deleted *everything*, which is
     * precisely the failure ADR-075 exists to prevent. So the count is checked
     * on both sides of it.
     */
    await test.step('reconciliation removes drift and keeps everything real', async () => {
      const storeId = connectedStoreId();

      expect(storeId, 'the store should still be connected').not.toBeNull();

      const before = mirroredCount(String(storeId));

      expect(before, 'the catalogue push should have mirrored products').toBeGreaterThan(0);

      /*
       * An id far above anything WooCommerce has issued, so it sorts last and
       * falls inside a final manifest's unbounded upper range. A low id would
       * also work today; this one cannot collide with a real product.
       */
      const PHANTOM = '999999';

      plantPhantomProduct(String(storeId), PHANTOM);

      expect(isMirrored(String(storeId), PHANTOM), 'the phantom should be planted').toBe(true);
      expect(mirroredCount(String(storeId))).toBe(before + 1);

      reconcileCatalogue();

      /*
       * 🔴 Both assertions, in this order. The phantom going proves the sweep
       * acted; the count returning to exactly `before` proves it acted only on
       * the drift — a sweep that took the real products with it would satisfy
       * the first assertion and fail this one.
       */
      expect(isMirrored(String(storeId), PHANTOM), 'the phantom should be gone').toBe(false);
      expect(mirroredCount(String(storeId)), 'every real product should survive').toBe(before);
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
