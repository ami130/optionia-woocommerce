import { expect, test } from '@playwright/test';

import {
  type Merchant,
  newMerchant,
  seedConnectedStore,
  seedProductWithPhoto,
  verifyEmail,
} from './fixtures';

/**
 * The Design Lab, driven by a real pointer.
 *
 * 🔴 **Everything in M26d.1 and M26d.4 was verified structurally until now.**
 * This project has no JSX test runner, so the canvas was checked by gates and by
 * reading: `getBoundingClientRect`, the drag loop, the handle hit-testing and
 * the add-layer image load had never once been executed. 2161 unit tests and 33
 * gates all passed while nothing had clicked anything.
 *
 * ⚠️ **The specific thing this was written to find**: the add-layer control
 * loads the merchant's URL with `crossOrigin = 'anonymous'`, and a host that
 * sends no CORS headers fires `onerror` — which would mean a merchant can add
 * no layers at all. That is a complete blocker and it is invisible to every
 * other check in the repository.
 *
 * 📌 **A data: URL is used for the layer image.** A real CDN would make this
 * suite depend on a third party being up, and the point is to exercise the
 * canvas rather than the network. The URL validator refuses `data:` — correctly,
 * since it can carry SVG — so the image is served from the dashboard's own
 * origin instead, which also makes the CORS path honest rather than bypassed.
 */
test.describe('Design Lab', () => {
  test('a merchant composes a design on a swatch and it survives a reload', async ({
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

    await test.step('a colour swatch is authored', async () => {
      /*
       * 📌 **Built through the API, not the UI.** Authoring an option set by
       * hand is the canonical suite's job and takes a dozen interactions; this
       * spec is about the canvas, and reaching it through the editor's own
       * forms would make a failure here ambiguous.
       *
       * ⚠️ **A fresh login rather than the page's token.** The dashboard keeps
       * its access token in module memory and never writes it to storage — a
       * deliberate choice its own docblock explains ("never written to disk,
       * gone on reload, unreadable from storage"). Reading it out of
       * localStorage returns null, as this spec discovered.
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
        data: { name: 'Design Lab E2E', storeId },
      });

      setId = (await set.json()).data.id;

      const group = await request.post(
        `http://localhost:4000/v1/option-sets/${setId}/groups`,
        { headers: auth, data: { label: 'Artwork' } },
      );
      const groupId = (await group.json()).data.id;

      const option = await request.post(
        `http://localhost:4000/v1/groups/${groupId}/options`,
        {
          headers: auth,
          data: { key: 'colour', label: 'Colour', presentation: 'color_swatch' },
        },
      );
      const optionId = (await option.json()).data.id;

      await request.post(`http://localhost:4000/v1/options/${optionId}/values`, {
        headers: auth,
        data: { valueKey: 'red', label: 'Red', colorHex: '#ff0000' },
      });
    });

    await test.step('the Design Lab opens from the choice', async () => {
      await page.goto(`/option-sets/${setId}`);

      /*
       * 🔴 The button only appears on a type whose carrier is `value` — the
       * dashboard mirror of the API's registry. Its absence would mean the
       * mirror disagrees with the API, which is what gate 27 pins.
       */
      await page.getByRole('button', { name: /^Design Red$/ }).click();

      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByText(/Compose the artwork/i)).toBeVisible();
    });

    await test.step('a layer is added, and the image actually loads', async () => {
      /*
       * 🔴 **The CORS question this spec exists to answer.** The image is served
       * from the dashboard's own origin — `/e2e-test-image.png` — so
       * `crossOrigin = 'anonymous'` has a same-origin response to accept. If the
       * add-layer flow is broken, `onerror` fires and no row appears.
       */
      const origin = new URL(page.url()).origin;

      await page.getByLabel('Image URL').fill(`${origin}/e2e-test-image.png`);
      await page.getByRole('button', { name: /^Add layer$/ }).click();

      /* The row is the proof: addLayer ran, which means the image loaded. */
      await expect(page.locator('.optionia-designlab-layer-row')).toHaveCount(1, {
        timeout: 15_000,
      });

      /* And it reached the canvas, not just the list. */
      await expect(page.locator('.optionia-designlab-layer')).toHaveCount(1);
    });

    await test.step('the canvas opens without a backdrop when no product has a photo', async () => {
      /*
       * 🔴 **The fallback, asserted rather than assumed.** This tenant's
       * catalogue is empty, so `canBeBackground` refuses and the lab composes on
       * a blank canvas — exactly as it did before backdrops existed. A crash or
       * an empty dialog here would mean the no-photo path was never handled.
       *
       * ⚠️ **The background layer is the thing to count.** A backdrop adds a
       * locked `bg-layer`; without one there is none, and the single layer on
       * the canvas is the merchant's own.
       */
      await expect(page.locator('.optionia-designlab-bg-layer')).toHaveCount(0);
      await expect(page.locator('.optionia-designlab-canvas')).toBeVisible();
    });

    await test.step('the layer can be selected and dragged', async () => {
      const layer = page.locator('.optionia-designlab-layer').first();
      const before = await layer.boundingBox();

      expect(before, 'the layer has a box on screen').not.toBeNull();

      /*
       * 🔴 **The drag loop, executed.** mousedown → mousemove → mouseup is the
       * path through `dragIntentFor`, `moveTo` and the document listeners —
       * none of which had ever run.
       */
      await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
      await page.mouse.down();
      await page.mouse.move(before!.x + before!.width / 2 + 60, before!.y + before!.height / 2 + 40, {
        steps: 10,
      });
      await page.mouse.up();

      const after = await layer.boundingBox();

      expect(after!.x, 'the layer moved horizontally').toBeGreaterThan(before!.x);
      expect(after!.y, 'the layer moved vertically').toBeGreaterThan(before!.y);
    });

    await test.step('the selection box and its grips are drawn', async () => {
      /*
       * ⚠️ Without the stylesheet these exist in the DOM and are unclickable —
       * the defect that shipped once already. `toBeVisible` asserts a non-zero
       * box, which is exactly what was missing.
       */
      await expect(page.locator('.optionia-designlab-sel-box')).toBeVisible();
      await expect(
        page.locator('.optionia-designlab-handle-pt[data-h="se"]'),
      ).toBeVisible();
      await expect(page.locator('.optionia-designlab-rotate-pt')).toBeVisible();
    });

    await test.step('the design is applied and survives a reload', async () => {
      await page.getByRole('button', { name: /^Apply$/ }).click();

      await expect(page.getByRole('dialog')).toBeHidden();

      /*
       * 🔴 **The round trip, through a reload.** The dialog hydrates from what
       * the API returns, so a design absent from the authoring projection would
       * reopen on an empty canvas — a feature that appears to save and does not.
       */
      await page.reload();

      await page.getByRole('button', { name: /^Edit design for Red$/ }).click();

      await expect(page.locator('.optionia-designlab-layer-row')).toHaveCount(1, {
        timeout: 15_000,
      });
    });
  });

  test('the canvas composes over the product photo', async ({ page, request }) => {
    const merchant: Merchant = newMerchant();
    let setId = '';

    await test.step('a merchant with a photographed product exists', async () => {
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

    await test.step('a colour swatch is authored', async () => {
      const login = await request.post('http://localhost:4000/v1/auth/login', {
        data: { email: merchant.email, password: merchant.password },
      });
      const token = (await login.json()).data.accessToken;
      const auth = { Authorization: `Bearer ${token}` };

      const stores = await request.get('http://localhost:4000/v1/stores', { headers: auth });
      const storeId = (await stores.json()).data[0].id;

      /*
       * 📌 Seeded against THIS store, now that its id is known. Same-origin, so
       * `crossOrigin = 'anonymous'` has a response it can accept.
       */
      seedProductWithPhoto(storeId, 'http://localhost:3001/e2e-test-image.png');

      const set = await request.post('http://localhost:4000/v1/option-sets', {
        headers: auth,
        data: { name: 'Design Lab Backdrop', storeId },
      });

      setId = (await set.json()).data.id;

      const group = await request.post(
        `http://localhost:4000/v1/option-sets/${setId}/groups`,
        { headers: auth, data: { label: 'Artwork' } },
      );
      const groupId = (await group.json()).data.id;

      const option = await request.post(
        `http://localhost:4000/v1/groups/${groupId}/options`,
        {
          headers: auth,
          data: { key: 'colour', label: 'Colour', presentation: 'color_swatch' },
        },
      );
      const optionId = (await option.json()).data.id;

      await request.post(`http://localhost:4000/v1/options/${optionId}/values`, {
        headers: auth,
        data: { valueKey: 'red', label: 'Red', colorHex: '#ff0000' },
      });
    });

    await test.step('the product photo is the backdrop', async () => {
      await page.goto(`/option-sets/${setId}`);
      await page.getByRole('button', { name: /^Design Red$/ }).click();

      await expect(page.getByRole('dialog')).toBeVisible();

      /*
       * 🔴 **The whole point of this change.** A backdrop is a locked
       * `bg-layer`, added by `importDesign` only when a measured `DesignImage`
       * reaches it — which requires the product's photo to have loaded and
       * `backgroundFor` to have built one. Its absence means the merchant is
       * composing over nothing, which is what this milestone fixed.
       */
      await expect(page.locator('.optionia-designlab-bg-layer')).toHaveCount(1, {
        timeout: 15_000,
      });

      /*
       * ⚠️ **And the canvas adopted the photo's aspect.** The fixture PNG is
       * 40x24 — deliberately landscape,
       * so a canvas still at the default 392x464 would be TALLER than it is
       * wide — proving the measurement reached `setCanvasSize` rather than the
       * backdrop merely being drawn on an unchanged canvas.
       */
      const canvas = await page.locator('.optionia-designlab-canvas').boundingBox();

      expect(canvas).not.toBeNull();
      expect(canvas!.width, 'the canvas is wider than tall, like the photo').toBeGreaterThan(
        canvas!.height,
      );
    });
  });
});
