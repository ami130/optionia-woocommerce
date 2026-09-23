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

  /*
   * 📌 **Typed rather than `fill()`ed, because a merchant types.**
   *
   * ✏️ **An earlier version of this comment claimed `fill()` leaves the form
   * invalid. That was wrong, and the correction is kept because the mistake is
   * easy to repeat.** A probe read the submit button *immediately* after
   * `fill()` and saw `disabled: true`, then read it after typing and saw
   * `false` — which looked like a validation difference and was really React
   * not having re-rendered yet. Measured properly: `fill()` passes this test
   * three runs out of three. `pressSequentially` is kept for fidelity, not
   * because the other is broken.
   */
  const labelBox = page.getByRole('textbox', { name: 'Label', exact: true }).first();

  await labelBox.click();
  await labelBox.pressSequentially(label, { delay: 15 });

  const submit = page.getByRole('button', { name: 'Add option', exact: true }).first();

  await expect(submit).toBeEnabled();
  await submit.click();

  /*
   * ⚠️ **The group must stop saying it is empty.** A page-wide `getByText`
   * matched the label still sitting in the input *and* the form's own live
   * preview — so the first version of this passed while nothing was created
   * at all, which is how the `fill()` problem above stayed hidden.
   */
  await expect(page.getByText('Nothing in this group yet')).toHaveCount(0);
}

/**
 * Add a choice to an option, the way a merchant does.
 *
 * ⚠️ **Scoped to the value form, not the page.** Several inputs are labelled
 * "Label" — the option's own, and every value row's — so an unscoped locator
 * picks whichever renders first and edits the wrong thing.
 */
async function addValue(page: Page, label: string, price?: string) {
  /*
   * 📌 **No disclosure step here either.** The value form is already open under
   * the option — *"Value label"*, *"Key"*, *"Price"*, *"Group (optional)"* —
   * and *"Add value"* at the end is the submit, disabled until a label exists.
   * A first draft clicked that button expecting it to *open* the form and
   * waited three minutes for a control that was never going to enable.
   *
   * ⚠️ **`Value label`, not `Label`.** The option's own field is *"Label"*, so
   * a loose match edits the option instead of the value.
   */
  const box = page.getByRole('textbox', { name: 'Value label', exact: true }).last();

  await box.click();
  await box.pressSequentially(label, { delay: 15 });

  if (price !== undefined) {
    const priceBox = page.getByRole('textbox', { name: 'Price', exact: true }).last();

    await priceBox.click();
    await priceBox.pressSequentially(price, { delay: 15 });
  }

  const submit = page.getByRole('button', { name: 'Add value', exact: true }).last();

  await expect(submit).toBeEnabled();
  await submit.click();

  /* The field clears on success, so an empty box is the signal it landed. */
  await expect(box).toHaveValue('');
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

    await test.step('the option is described in the merchant\'s words', async () => {
      /*
       * 🔴 **It printed the wire value.** Under the option's label sat
       * `text_field` — the string that travels to the storefront — while the
       * type picker two inches above called the same thing *"Text field"*. One
       * option, named twice, once in merchant language and once in the
       * database's.
       */
      await expect(page.getByText('Text field').first()).toBeVisible();
      await expect(page.getByText('text_field')).toHaveCount(0);
    });

    await test.step('publishing is reachable without scrolling for it', async () => {
      /*
       * 🔴 **The action that makes the work real.** It used to sit below the
       * groups, the rules, the preview and the product picker — several screens
       * down — while the notice at the top told merchants to publish.
       */
      await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
    });

    await test.step('a blocked publish says what to fix, not merely that it cannot', async () => {
      /*
       * 🔴 **A disabled button with no reason is a dead end**, and this is where
       * a tester without documentation stops. The count beside it is the whole
       * difference between "why is this grey?" and a next action.
       */
      const publish = page.getByRole('button', { name: 'Publish', exact: true });

      if (await publish.isDisabled()) {
        await expect(page.getByText(/thing(s)? to fix/).first()).toBeVisible();
      }
    });

    await test.step('the blocker list agrees with what is on screen', async () => {
      /*
       * 🔴 **It said the set was empty while the option was visible above it.**
       * *"has no enabled options or content, so there is nothing to publish"* —
       * about a set whose option the merchant had just added and could see. The
       * check is right; the answer was **stale**. `invalidateAfterEdit` skips
       * `publish-check` on purpose, and its comment explains why: *"the
       * publish-check is re-run when the publish panel is opened"*. Since the
       * publish button moved into the header (F58) nothing is ever *opened*,
       * so the check keeps the answer it got when the set was empty.
       *
       * ⚠️ **This is the message that decides whether a tester finishes.** A
       * merchant who has done the work and is told they have not will look for
       * what they did wrong, and there is nothing to find.
       */
      await expect(
        page.getByText(/has no enabled options or content/),
      ).toHaveCount(0);
    });

    await test.step('disabling the only option brings the blocker back', async () => {
      /*
       * 🔴 **The mirror of the stale blocker, and it was the other half of the
       * same bug.** In-place edits go through `patchTree`, which patches the
       * cached tree and — before this — left `publish-check` alone. So a
       * merchant could disable their only option and the header would still
       * offer to publish a set with nothing in it.
       *
       * ⚠️ **This is the direction that ships a broken set**, not merely an
       * annoying one: the publish would be refused server-side, so the merchant
       * is invited to do something the API will reject.
       */
      await page.getByRole('button', { name: /^Disable Engraving text$/ }).click();

      await expect(page.getByText(/has no enabled options or content/).first()).toBeVisible();
    });

    await test.step('re-enabling clears it again, so the state is reversible', async () => {
      /*
       * ⚠️ **A blocker that appears and never leaves is its own dead end.** A
       * merchant who disables something to see what happens must be able to
       * undo that and find the editor as they left it.
       */
      await page.getByRole('button', { name: /^Enable Engraving text$/ }).click();

      await expect(page.getByText(/has no enabled options or content/)).toHaveCount(0);
    });

    await test.step('assignment explains itself, including when nothing has synced', async () => {
      /*
       * 🔴 **A draft that assigns nothing reaches no customer**, and a merchant
       * who does not know that publishes into silence. The panel says both
       * halves: assignments *"are saved now and reach your storefront when you
       * publish"*, and right now *"not assigned to anything yet, so it will not
       * appear on your storefront"*.
       *
       * ⚠️ **And an empty catalogue is explained, not merely empty.** A store
       * whose products have not synced yet gets the reason and a place to look
       * — *Optionia → System Status*, the Catalogue sync row — rather than a
       * blank list that reads as a broken integration.
       */
      await expect(page.getByText(/Assignments are saved now/).first()).toBeVisible();
      await expect(page.getByText(/not appear on your storefront/i).first()).toBeVisible();
      await expect(page.getByText(/No products have arrived from your store yet/).first())
        .toBeVisible();
    });

    await test.step('she publishes, and her storefront is named', async () => {
      /*
       * 🔴 **The finish line, and no persona reached it until now.** Everything
       * before this is preparation; a merchant who cannot publish has built
       * nothing a customer will ever see.
       *
       * ⚠️ **The confirmation must name a version and a configuration**, not
       * merely say "done": those are what a merchant checks their storefront
       * against when they go looking for their change.
       */
      const publish = page.getByRole('button', { name: 'Publish', exact: true });

      await expect(publish).toBeEnabled();
      await publish.click();

      await expect(page.getByText(/Published version \d+/)).toBeVisible();
      await expect(page.getByText(/reaches configuration v\d+/)).toBeVisible();
    });

    await test.step('the merchant can reach the reason and act on it', async () => {
      /*
       * ⚠️ **The findings live in the panel below, not in the header.** A
       * merchant told "1 thing to fix" must be able to find *what* — so the
       * list has to exist on the same screen, not behind a navigation.
       */
      await expect(
        page.getByText(/fix these first|worth knowing|publishing/i).first(),
      ).toBeVisible();
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

      await addValue(page, 'Small', '5.00');
      await addValue(page, 'Large', '12.50');

    });

    await test.step('an unassigned set warns rather than blocks', async () => {
      /*
       * 📌 **The right call, and worth pinning so it stays that way.** A set
       * assigned to no product publishes to nothing — but that is a merchant's
       * decision to make, not a reason to refuse. The panel says *"publishing
       * it will not change any storefront"*, which is the fact they need, and
       * the button stays live.
       */
      await expect(
        page.getByText(/is not assigned to any product/).first(),
      ).toBeVisible();

      await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    });

    await test.step('she publishes, and is told what her storefront will do', async () => {
      /*
       * 🔴 **The moment the work becomes real**, and no persona had reached it.
       * A confirmation that merely said "done" would prove nothing: what a
       * merchant needs is the version their storefront will serve and when.
       */
      await page.getByRole('button', { name: 'Publish', exact: true }).click();

      await expect(page.getByText(/Published version \d+/)).toBeVisible();
    });

    await test.step('the header stops calling it a draft', async () => {
      /*
       * ⚠️ **The badge is the one fact deciding whether a merchant believes
       * they are live.** It read as a sentence until F58 made it a state; this
       * asserts the state actually changes when they publish.
       */
      await expect(page.getByText(/Published · v\d+/).first()).toBeVisible();
    });

    await test.step('the customer preview shows both sizes and their prices', async () => {
      /*
       * 🔴 **The whole reason the preview exists.** A merchant who has added
       * two priced sizes needs to see two priced sizes — anything else means
       * the work did not land where the customer will meet it.
       */
      const preview = page.getByRole('region', { name: /what your customer sees/i });

      await expect(preview.getByText('Small')).toBeVisible();
      await expect(preview.getByText('Large')).toBeVisible();
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

  /**
   * **Persona 4 — the hurried merchant.** Wants something working now and
   * reaches for the template, which the empty state offers *before* "Start
   * from scratch". The first control a real tester is likely to press, and
   * until now walked by nothing.
   */
  test('persona 4: a starter template, from empty to editing', async ({ page }) => {
    const merchant = await signInAsNewMerchant(page);

    seedConnectedStore(merchant.email);

    await test.step('the templates say what they are for, not merely their names', async () => {
      await page.goto('/option-sets');

      /*
       * 📌 **A name alone makes a merchant guess.** *"Engraving"* could be a
       * text box or a swatch; the line beneath it — *"Text priced per
       * character, with a free allowance and a length limit"* — is what lets
       * someone choose without opening all four.
       */
      await expect(page.getByText(/Start from a template and adapt it/)).toBeVisible();
      await expect(
        page.getByText(/Text priced per character, with a free allowance/),
      ).toBeVisible();
    });

    await test.step('choosing one lands her in the editor, already populated', async () => {
      await page.getByRole('button', { name: /^Engraving/ }).click();

      await page.waitForURL(/\/option-sets\/[0-9a-f-]{36}/, { timeout: 30_000 });

      /*
       * 🔴 **The whole promise of a template.** Landing in an *empty* editor
       * would be worse than starting from scratch — the merchant would have
       * paid a click to arrive exactly where the other button leads.
       */
      await expect(page.getByText(/Nothing here yet/)).toHaveCount(0);
    });

    await test.step('she inherits a real group and a real option, not a shell', async () => {
      /*
       * ⚠️ **Waited for the tree, not read mid-render.** A first probe called
       * `innerText()` the instant the URL changed and got an empty string —
       * which looked like a blank editor and was really the fetch in flight.
       * The lesson is the assertion, not the incident: wait for the thing.
       */
      await expect(page.getByRole('heading', { name: 'Engraving', level: 2 })).toBeVisible();
      await expect(page.getByText('Engraving text').first()).toBeVisible();
    });

    await test.step('and it is publishable as it arrives', async () => {
      /*
       * 🔴 **A template a merchant must repair before using is not a starting
       * point.** It should have everything a publish needs, and the only thing
       * the panel says is the one fact no template can know — that nothing is
       * assigned to a product yet.
       */
      await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();

      await expect(page.getByText(/has no enabled options or content/)).toHaveCount(0);
      await expect(page.getByText(/is not assigned to any product/).first()).toBeVisible();
    });

    await test.step('she publishes it unchanged', async () => {
      await page.getByRole('button', { name: 'Publish', exact: true }).click();

      await expect(page.getByText(/Published version \d+/)).toBeVisible();
      await expect(page.getByText(/Published · v\d+/).first()).toBeVisible();
    });
  });

  /**
   * **Persona 5 — the shirt printer.** Sells shirts where *"Print colour"*
   * only applies if the customer chose a printed style. That is conditional
   * logic — the headline feature — and nothing has ever created a rule through
   * the UI.
   */
  test('persona 5: a rule, written without documentation', async ({ page }) => {
    const merchant = await signInAsNewMerchant(page);

    seedConnectedStore(merchant.email);
    await createSet(page, 'Shirt options');

    await addGroup(page, 'Style');
    await addOption(page, 'Choose a style', 'Dropdown');
    await addValue(page, 'Plain');
    await addValue(page, 'Printed');

    await addOption(page, 'Print colour', 'Dropdown');

    await test.step('the rule builder reads as a sentence, not a schema', async () => {
      /*
       * 📌 **"Do this / To this / When" is the whole reason a merchant can
       * write one.** The API's vocabulary is `action`, `targetType`,
       * `operator`, `matchType`; none of that appears on screen. Pinned
       * because a later refactor that leaked those words would be a
       * regression no type checker could see.
       */
      await expect(page.getByText(/Show, hide or require an option depending on/)).toBeVisible();
      await expect(page.getByText(/A rule needs at least one condition/)).toBeVisible();
    });

    await test.step('every operator is plain English, none of the wire vocabulary', async () => {
      await page.getByRole('button', { name: /add condition/i }).click();

      /*
       * 🔴 **The API says `eq`, `neq`, `in`, `contains`, `gt`, `lt`.** A
       * merchant reads *"is", "is not", "is one of", "contains", "is more
       * than", "is less than"* — plus *"is empty"* and *"is answered"*, which
       * are the two nobody guesses the spelling of. Pinned because leaking
       * one of the wire words is a regression no type checker can see.
       */
      /*
       * ⚠️ **Asserted as the select's own options, not as visible text.** They
       * live inside a closed `<select>`, so `toBeVisible()` reports `hidden`
       * for every one of them — a first draft failed on correct markup.
       */
      const operators = page.locator('select').filter({ hasText: 'is one of' }).first();

      await expect(operators).toContainText('is one of');
      await expect(operators).toContainText('is empty');
      await expect(operators).toContainText('is answered');
      await expect(operators).toContainText('is more than');

      /* And none of the wire spellings a refactor might leak. */
      const html = await operators.innerHTML();

      expect(html).not.toMatch(/>(eq|neq|gt|lt|in|nin)</);

      await expect(page.getByText(/Give something to compare against/)).toBeVisible();
    });

    await test.step('a value target names its option, so two "Plain"s cannot be confused', async () => {
      /*
       * 📌 **`Choose a style: Plain`, not `Plain`.** Two options in one set can
       * both offer a value called *Plain*; a bare label would make the merchant
       * guess which they were acting on, and guess wrong half the time.
       */
      const targets = page.locator('select').filter({ hasText: 'Choose a style: Plain' });

      await expect(targets.first()).toContainText('Choose a style: Plain');
    });

    await test.step('she writes it: hide Print colour unless the style is Printed', async () => {
      /*
       * 📌 **Addressed by accessible name, not by content.** Every control here
       * has one — *"To this"*, *"Which answer"*, *"Comparison"*, *"Value"* — and
       * a first draft matched on option text instead, which picked the target
       * select when it meant the comparison value and left the rule incomplete.
       * The form was right: it said *"Give something to compare against."*
       */
      await page.getByRole('combobox', { name: 'To this' }).selectOption({ label: 'Print colour' });

      await page
        .getByRole('combobox', { name: 'Which answer' })
        .selectOption({ label: 'Choose a style' });

      await page.getByRole('combobox', { name: 'Comparison' }).selectOption({ label: 'is' });
      await page.getByRole('combobox', { name: 'Value' }).selectOption({ label: 'Plain' });

      await page.getByRole('button', { name: /^add rule$/i }).click();

      /*
       * 🔴 **The rule must appear in the list, not merely leave the form.** A
       * form that clears itself and creates nothing is the same defect F77
       * recorded one level up.
       */
      await expect(page.getByText(/No rules yet/)).toHaveCount(0);
    });

    await test.step('the saved rule reads back as the sentence she wrote', async () => {
      /*
       * 🔴 **A rule a merchant cannot re-read is a rule they cannot trust.**
       * Weeks later they must be able to look at the list and know what it
       * does without reconstructing it from the builder's controls.
       */
      await expect(page.getByText(/Hide/).first()).toBeVisible();
      await expect(page.getByText(/Print colour/).first()).toBeVisible();
    });

    await test.step('and it survives a reload, so it was really saved', async () => {
      /*
       * ⚠️ **The assertion that catches a form which clears and creates
       * nothing** — the defect class F77 recorded for options and values. A
       * reload reads from the API, so nothing cached can fake it.
       */
      await page.reload();

      await expect(page.getByText(/No rules yet/)).toHaveCount(0);
    });
  });


  /**
   * **Persona 6 — the merchant who makes a mistake.** Every persona so far has
   * walked the happy path. A real tester mistypes, changes their mind, and
   * deletes the wrong thing — and what a builder does *then* decides whether
   * they trust it.
   */
  test('persona 6: undoing a mistake, and deleting on purpose', async ({ page }) => {
    const merchant = await signInAsNewMerchant(page);

    seedConnectedStore(merchant.email);
    await createSet(page, 'Mistakes');

    await addGroup(page, 'Finish');
    await addOption(page, 'Choose a finish', 'Dropdown');
    await addValue(page, 'Matte');

    await test.step('undo is honest about what it cannot reverse', async () => {
      /*
       * 📌 **Disabled after a create, deliberately — and this pins the
       * decision rather than the accident.** `history.ts` records why: every
       * shape change clears the log, because an undo that recreated a group
       * and silently lost its options, or left rules targeting it disabled,
       * would be *worse than no undo* — the merchant would believe the delete
       * had been reversed.
       *
       * ⚠️ **A disabled control still has to say why.** The title reads
       * *"Nothing to undo"*, and when there *is* something it names the
       * action. A merchant who hovers gets an answer either way.
       */
      const undo = page.getByRole('button', { name: /Undo/ });

      await expect(undo).toBeDisabled();
      await expect(undo).toHaveAttribute('title', 'Nothing to undo');
    });

    await test.step('editing a value in place IS undoable, and the button says so', async () => {
      /*
       * 🔴 **The other half of the same decision.** Field edits keep their
       * inverse — the previous values the form already held — so a merchant
       * who mistypes a label can take it back. If this were disabled too,
       * undo would be decorative.
       */
      await page.getByRole('button', { name: /^Edit Matte$/ }).click();

      const label = page.locator('[data-value-row] [id^="label-"]');

      await label.fill('Matt');
      await page.getByRole('heading', { name: 'Finish', exact: true }).click();

      const undo = page.getByRole('button', { name: /Undo/ });

      await expect(undo).toBeEnabled();
      await expect(undo).not.toHaveAttribute('title', 'Nothing to undo');
    });

    await test.step('and undoing restores what was there', async () => {
      await page.getByRole('button', { name: /Undo/ }).click();

      await expect(page.getByText('Matte').first()).toBeVisible();
    });

    await test.step('deleting a group counts what it takes with it', async () => {
      /*
       * 🔴 **Delete is the one thing undo cannot reverse** (`history.ts`: the
       * endpoints return `void`, and the cascade — the options, values, items
       * and rules a group delete disables — never reaches the dashboard). So
       * the confirmation has to carry the fact that a merchant would otherwise
       * learn by losing the work: **how much goes with it**.
       *
       * ⚠️ **A count, not a warning.** *"Delete 'Finish' and its 1 entry?"*
       * lets a merchant tell a stray empty group from one holding a morning's
       * work, which a generic *"are you sure?"* cannot.
       */
      await page.getByRole('button', { name: /^Delete group$/ }).click();

      await expect(page.getByText(/Delete "Finish" and its 1 entry\?/)).toBeVisible();
      await expect(page.getByRole('button', { name: /Yes, delete/ })).toBeVisible();
    });

    await test.step('and she can change her mind', async () => {
      /*
       * ⚠️ **The escape matters more than the confirmation.** A merchant who
       * clicked Delete to see what it said must be able to leave without
       * losing anything.
       */
      const cancel = page.getByRole('button', { name: /^Cancel$|^No,|Keep/ }).first();

      await cancel.click();

      await expect(page.getByText(/Delete "Finish"/)).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Finish', level: 2 })).toBeVisible();
    });

    await test.step('a label typed and then navigated away from is not lost', async () => {
      /*
       * 🔴 **Phase 20's own exit criterion — "No data loss on navigation" —
       * and nothing walked it.** Autosave commits when focus leaves the row;
       * a merchant who types and immediately clicks away to another page is
       * the case where that promise is either kept or quietly broken.
       *
       * ⚠️ **Asserted after a round trip through the API**, not against the
       * cache: the test navigates away and comes back, so a value held only
       * in memory would be gone.
       */
      await page.getByRole('button', { name: /^Edit Matte$/ }).click();

      const label = page.locator('[data-value-row] [id^="label-"]');

      await label.fill('Satin');

      /* Away mid-edit, exactly as a merchant checking another page would. */
      await page.getByRole('link', { name: 'Products' }).click();
      await page.waitForURL(/\/products/, { timeout: 30_000 });

      await page.goBack();
      await page.waitForURL(/\/option-sets\/[0-9a-f-]{36}/, { timeout: 30_000 });

      await expect(page.getByText('Satin').first()).toBeVisible();
    });

    await test.step('deleting on purpose actually removes it', async () => {
      await page.getByRole('button', { name: /^Delete group$/ }).click();
      await page.getByRole('button', { name: /Yes, delete/ }).click();

      await expect(page.getByRole('heading', { name: 'Finish', level: 2 })).toHaveCount(0);
      await expect(page.getByText(/Nothing here yet/).first()).toBeVisible();
    });
  });
});
