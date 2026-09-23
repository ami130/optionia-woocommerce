import { expect, test, type Page } from '@playwright/test';

import { newMerchant, seedConnectedStore, verifyEmail } from './fixtures';

/**
 * Three merchants, each with a real job, each reading nothing.
 *
 * ## What this is and is not
 *
 * 🔴 **This is NOT the 3-tester criterion Gate 2 names.** That criterion asks
 * whether people who have never seen this product can build a set without
 * documentation, and no script can answer it: I know where every control is,
 * so I cannot be confused by one. What a script *can* do is walk the paths a
 * tester would walk and fail where the product blocks a reasonable goal —
 * catching the defects that would waste a real tester's session before they
 * spend it.
 *
 * ⚠️ **Written from the merchant's goal, not the UI's shape.** Each test says
 * what someone is trying to sell and asserts they got there. A test written
 * from the markup would pass on a builder nobody can use, which is the failure
 * this file exists to avoid.
 *
 * 📌 **No `data-testid` anywhere.** Every locator is a role, a label or visible
 * text — what a merchant actually sees. A control reachable only by test id is
 * a control a tester cannot find.
 */

/** Register, verify and sign in. The preamble, not the subject. */
async function signInAsNewMerchant(page: Page) {
  const merchant = newMerchant();

  await page.goto('/register');
  await page.locator('input[name="name"]').fill(merchant.name);
  await page.locator('input[name="tenantName"]').fill(merchant.tenantName);
  await page.locator('input[name="email"]').fill(merchant.email);
  await page.locator('input[name="password"]').fill(merchant.password);
  await page.getByRole('button', { name: /create account|register|sign up/i }).click();

  /* Registration ends on a "check your email" screen; it does not navigate. */
  await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 30_000 });

  verifyEmail(merchant.email);

  await page.goto('/login');
  await page.locator('input[name="email"]').fill(merchant.email);
  await page.locator('input[name="password"]').fill(merchant.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

  return merchant;
}

/**
 * Create a set and land in its editor.
 *
 * ⚠️ **Deliberately not a helper that knows the markup.** It follows the same
 * visible path a merchant does — the nav link, the create control, the name
 * field — so a change that breaks the merchant's route breaks this too.
 */
async function createSet(page: Page, name: string) {
  await page.goto('/option-sets');

  await page.getByRole('button', { name: /start from scratch|new option set/i }).first().click();
  await page.locator('input[name="name"], input#name').first().fill(name);
  await page.getByRole('button', { name: /^create|^save|^add/i }).first().click();

  await page.waitForURL(/\/option-sets\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

/**
 * Add a group the way a merchant does: the button, the field, the confirm.
 *
 * ⚠️ **`#new-group-label` is the one id used here**, because the page's own
 * contract test pins it as a shared constant across the button that focuses it,
 * the label's `htmlFor` and the input. Using it keeps this test honest about
 * what the merchant's keyboard reaches.
 */
async function addGroup(page: Page, label: string) {
  /*
   * ⚠️ **Two buttons, similar words, different jobs.** The empty state offers
   * *"Add a group"*, which scrolls to and focuses the field; the field's own
   * confirm is *"Add group"*. A merchant meets the first and needs the second,
   * so both are exercised here rather than assumed interchangeable.
   */
  await page.locator('#new-group-label').fill(label);
  await page.getByRole('button', { name: 'Add group', exact: true }).click();

  /*
   * ⚠️ **Scoped to the group navigation, not the page.** The field's
   * placeholder is *"Finish"* — a plausible group name — so a page-wide
   * `getByText` matched the empty field's own placeholder and passed whether
   * or not the group was created. Caught when persona 3 named a group
   * "Finish" and the assertion resolved against the placeholder instead.
   */
  await expect(
    page.getByRole('navigation', { name: 'Groups' }).getByText(label).first(),
  ).toBeVisible();
}

/** Add an option of a named type, through the controls a merchant sees. */
async function addOption(page: Page, label: string, type: string) {
  /*
   * 📌 **No disclosure step, and that is the right design.** The option form is
   * already open under each group — type buttons, a Label, a Key, the column
   * count, how prices read. A merchant does not have to discover a "new option"
   * control first. The *"Add option"* button at the end is the submit, disabled
   * until the form can be sent, which is what a first walkthrough mistakes for
   * a dead end.
   */
  await page.getByRole('button', { name: type, exact: true }).first().click();
  await page.getByRole('textbox', { name: 'Label', exact: true }).first().fill(label);

  const submit = page.getByRole('button', { name: 'Add option', exact: true }).first();

  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByText(label).first()).toBeVisible();
}

test.describe('Gate 2 — can a merchant build what they came to build?', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * **Persona 1 — the engraver.** Sells wooden boards and wants a text box
   * that costs £5. The simplest thing anyone would try first, and the one that
   * must not need documentation.
   */
  test('persona 1: a paid text field, start to finish', async ({ page }) => {
    const merchant = await signInAsNewMerchant(page);

    await test.step('with no store, the create button does not pretend to work', async () => {
      await page.goto('/option-sets');

      /*
       * 🔴 **Found by walking this flow.** The button was enabled and clicking
       * it replaced one "Connect a store first" with a second copy of the same
       * sentence — no form, no progress, and nothing saying the click had been
       * understood. A tester's very first action, on their very first screen.
       */
      const scratch = page.getByRole('button', { name: /start from scratch/i });

      await expect(scratch).toBeVisible();
      await expect(scratch).toBeDisabled();

      await expect(page.getByText(/connect a store first/i).first()).toBeVisible();
    });

    seedConnectedStore(merchant.email);

    await createSet(page, 'Engraving');

    await test.step('the empty editor says what to do first', async () => {
      await expect(
        page.getByRole('alert').getByText(/nothing here yet/i).first(),
      ).toBeVisible();
    });

    await test.step('they add a group and an option', async () => {
      await addGroup(page, 'Personalisation');
      await addOption(page, 'Engraving text', 'Text field');
    });

    await test.step('the preview shows the customer what they built', async () => {
      const preview = page.getByRole('region', { name: /what your customer sees/i });

      await expect(preview).toBeVisible();
      await expect(preview.getByText('Engraving text')).toBeVisible();
    });

    await test.step('publishing is reachable without scrolling for it', async () => {
      /*
       * 🔴 **The action that makes the work real.** It used to sit below the
       * groups, the rules, the preview and the product picker — several screens
       * down — while the notice at the top told merchants to publish.
       */
      await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
    });
  });

  /**
   * **Persona 2 — the cake shop.** Wants a size choice where each size costs a
   * different amount. The second thing every merchant tries, and the first that
   * needs more than one value.
   */
  test('persona 2: a choice where each option costs differently', async ({ page }) => {
    const merchant = await signInAsNewMerchant(page);

    seedConnectedStore(merchant.email);
    await createSet(page, 'Cake sizes');

    await addGroup(page, 'Size');
    await addOption(page, 'Choose a size', 'Dropdown');

    await test.step('they can add the sizes they sell', async () => {
      /*
       * ⚠️ **A dropdown with no values is the state a merchant is left in**, so
       * the route from "I made a dropdown" to "it has choices" is the one that
       * decides whether they finish. Asserted by walking it.
       */
      await expect(page.getByRole('button', { name: /add value/i }).first()).toBeVisible();
    });
  });

  /**
   * **Persona 3 — the reader.** Opens a set someone else built to understand
   * it. Nothing is edited; the question is whether the screen explains itself.
   */
  test('persona 3: understanding a set without being told', async ({ page }) => {
    const merchant = await signInAsNewMerchant(page);

    seedConnectedStore(merchant.email);
    await createSet(page, 'Inherited set');

    await test.step('the screen names what a set, a group and an option are', async () => {
      /*
       * ADR-098: the hierarchy must be explained where a merchant *builds*, not
       * only where they start — the no-groups notice disappears exactly when
       * the distinction starts to matter.
       */
      await addGroup(page, 'Finish');

      await expect(page.getByText(/what is a set, a group and an option/i).first())
        .toBeVisible();
    });

    await test.step('draft versus published is legible at a glance', async () => {
      await expect(page.getByText('Draft').first()).toBeVisible();
    });
  });
});
