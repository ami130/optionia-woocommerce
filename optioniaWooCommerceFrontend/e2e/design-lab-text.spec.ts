import { expect, test } from '@playwright/test';

import {
  type Merchant,
  newMerchant,
  seedConnectedStore,
  verifyEmail,
} from './fixtures';

/**
 * The TEXT Design Lab, driven by a real pointer (M26d.3).
 *
 * 🔴 **Every part of M26d.3 was verified structurally until now, and that was
 * not enough twice.** The milestone shipped four commits deep — model, canvas,
 * panel, alpha — and was both UNREACHABLE and UNSAVED: the Design button hangs
 * off a value row, a text option has no values, and `onApply` sent the layers
 * alone so the merchant's text was discarded in silence. 2400 unit tests and 33
 * gates passed through all of it.
 *
 * ⚠️ **What this spec exists to answer, which nothing else can**: does the text
 * actually DRAW? `placeText` is pinned against the shared geometry by unit
 * tests, but no browser had ever resolved a `<textPath href="#…">`, measured a
 * real glyph advance, or loaded a curated font. A path that renders nothing
 * leaves every one of those tests green.
 *
 * 📌 **No WooCommerce needed.** The lab is dashboard-only; the store row is
 * seeded straight into the database with a URL nothing dials. The API and the
 * dashboard are enough, and both were confirmed healthy when this was written.
 *
 * ⚠️ **NOT YET EXECUTED, as of 2026-10-02 — this file is a specification, not
 * evidence.** `global-setup` refuses to start while `SMTP_HOST` is set, because
 * every run registers a merchant at a domain that does not resolve and the
 * bounce lands in the mailbox `SMTP_USER` signs in as. Disabling that needs an
 * edit to a gitignored `.env` holding live credentials and an API restart —
 * the owner's call, and they chose to run it themselves later.
 *
 * 🔴 **So M26d.3 remains structurally verified only.** Everything above is
 * written from the code it exercises, which is exactly how a test can be wrong
 * and green at once; the selectors, the Apply label and the reload behaviour
 * are all unconfirmed guesses until this runs. Expect to fix this file on its
 * first execution, and treat a failure here as a defect in the test before
 * assuming one in the product.
 *
 * **To run it:** empty `SMTP_HOST` in `optioniaWooCommerceBackend/.env`,
 * restart the API (a rebuild is not enough — `nest start --watch` keeps the
 * environment it booted with), then `npx playwright test design-lab-text`.
 * Mail then goes to the ops log; `verifyEmail()` marks the address verified in
 * the database directly, which is all these tests need.
 */
test.describe('Design Lab — text', () => {
  test('a merchant composes a text design, saves it, and reopens it unchanged', async ({
    page,
    request,
  }) => {
    const merchant: Merchant = newMerchant();
    let setId = '';

    await test.step('a merchant with a connected store exists', async () => {
      await page.goto('/register');

      await page.locator('input[name="name"]').fill(merchant.name);
      await page.locator('input[name="tenantName"]').fill(merchant.tenantName);
      await page.locator('input[name="email"]').fill(merchant.email);
      await page.locator('input[name="password"]').fill(merchant.password);
      await page.getByRole('button', { name: /create|register|sign up/i }).click();

      await expect(page.getByText(merchant.email)).toBeVisible();

      verifyEmail(merchant.email);
      seedConnectedStore(merchant.email);

      await page.goto('/login');
      await page.locator('input[name="email"]').fill(merchant.email);
      await page.locator('input[name="password"]').fill(merchant.password);
      await page.getByRole('button', { name: /sign in|log in/i }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    });

    await test.step('a text option is authored', async () => {
      /*
       * 📌 **Through the API**, for the reason the sibling spec records: this
       * spec is about the lab, and building a set through the editor's forms
       * would make a failure here ambiguous.
       *
       * 🔴 **`text_field`, whose carrier is `option_text`.** That is the whole
       * point: a text option has NO VALUES, which is why the per-value Design
       * button could never appear for one.
       */
      const login = await request.post('http://localhost:4000/v1/auth/login', {
        data: { email: merchant.email, password: merchant.password },
      });
      const token = (await login.json()).data.accessToken;

      expect(token, 'the API issues an access token').toBeTruthy();

      const auth = { Authorization: `Bearer ${token ?? ''}` };
      const stores = await request.get('http://localhost:4000/v1/stores', { headers: auth });
      const storeId = (await stores.json()).data[0].id;

      const set = await request.post('http://localhost:4000/v1/option-sets', {
        headers: auth,
        data: { name: 'Text Lab E2E', storeId },
      });

      setId = (await set.json()).data.id;

      const group = await request.post(
        `http://localhost:4000/v1/option-sets/${setId}/groups`,
        { headers: auth, data: { label: 'Engraving' } },
      );
      const groupId = (await group.json()).data.id;

      const option = await request.post(`http://localhost:4000/v1/groups/${groupId}/options`, {
        headers: auth,
        data: { key: 'message', label: 'Message', presentation: 'text_field' },
      });

      expect(option.ok(), 'the API accepts a text option').toBe(true);

      await page.goto(`/option-sets/${setId}`);
    });

    await test.step('the text lab opens from the OPTION, not a value', async () => {
      /*
       * 🔴 **The defect this step would have caught on day one.** A text option
       * has no values, so this button cannot live on a value row — and for four
       * commits it did not exist at all, leaving every text control
       * unreachable.
       */
      await page.getByRole('button', { name: /^Design text$/ }).click();

      await expect(page.getByRole('dialog')).toBeVisible();
    });

    await test.step('a text is added and actually drawn', async () => {
      await page.getByRole('button', { name: /^Add text$/ }).click();

      /*
       * 🔴 **The SVG the canvas emits, in a real browser.** `placeText` is
       * pinned to the renderer by unit tests; whether a browser draws anything
       * from it had never been executed.
       */
      const drawn = page.locator('.optionia-designlab-text');

      await expect(drawn).toHaveCount(1);

      /* ⚠️ Present is not drawn: a mis-placed text has a zero box. */
      const box = await drawn.locator('text').first().boundingBox();

      expect(box, 'the text has a box on screen').not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    });

    await test.step('the merchant restyles it', async () => {
      await page.locator('.optionia-designlab-textarea').fill('Happy Birthday');

      /* 📌 The panel's own select — proof `isCuratedFont` accepted the value. */
      await page.locator('.optionia-designlab-select').selectOption('Pacifico');
      await page.getByRole('button', { name: /^Bold$/ }).click();

      await expect(page.locator('.optionia-designlab-text text').first()).toHaveText(
        'Happy Birthday',
      );
    });

    await test.step('the curve slider bends the text onto an arc', async () => {
      /*
       * 🔴 **`<textPath>`, resolved by a browser.** The flat branch draws
       * `<tspan>`s; the curved branch needs a `<defs><path>` and an href that
       * actually resolves. A broken id renders NOTHING, and every unit test
       * stays green.
       */
      const curve = page.locator('.optionia-designlab-props-section', {
        hasText: /^Curve/,
      }).locator('input[type="range"]');

      await curve.fill('60');

      const textPath = page.locator('.optionia-designlab-text textPath');

      await expect(textPath).toHaveCount(1);

      /* The href must point at a def that exists in THIS document. */
      const resolves = await textPath.evaluate((el) => {
        const href = el.getAttribute('href') ?? '';

        return href.startsWith('#') && el.ownerDocument.getElementById(href.slice(1)) !== null;
      });

      expect(resolves, 'the textPath href resolves to a path in this document').toBe(true);

      /* And the arc draws: a zero-width run would mean the path is empty. */
      const arc = await page.locator('.optionia-designlab-text text').first().boundingBox();

      expect(arc, 'the curved text has a box on screen').not.toBeNull();
      expect(arc!.width).toBeGreaterThan(0);
    });

    await test.step('the design is applied and survives a reload', async () => {
      /*
       * 🔴 **The failure this whole audit chain was about.** `onApply` sent
       * `exportDesign()` alone, so a composed text was discarded in silence.
       * Nothing short of saving and reopening could see it.
       */
      await page.getByRole('button', { name: /^Apply$/ }).click();
      await expect(page.getByRole('dialog')).toBeHidden();

      /* The label flips once the option carries a design. */
      await expect(page.getByRole('button', { name: /^Edit text design$/ })).toBeVisible({
        timeout: 15_000,
      });

      await page.reload();
      await page.getByRole('button', { name: /^Edit text design$/ }).click();

      await expect(page.getByRole('dialog')).toBeVisible();

      /* ⚠️ The merchant's own wording, not the sample — so it round-tripped. */
      await expect(page.locator('.optionia-designlab-textarea')).toHaveValue('Happy Birthday');
      await expect(page.locator('.optionia-designlab-select')).toHaveValue('Pacifico');

      /* And the curve survived, which means the whole geometry did. */
      const curve = page.locator('.optionia-designlab-props-section', {
        hasText: /^Curve/,
      }).locator('input[type="range"]');

      await expect(curve).toHaveValue('60');
    });
  });
});
