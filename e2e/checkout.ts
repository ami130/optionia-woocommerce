import { type Page } from '@playwright/test';

/**
 * Fill WooCommerce's checkout with a plausible customer.
 *
 * ## Two checkouts, not one
 *
 * 🔴 **A block theme serves a different checkout, and the difference is
 * structural rather than cosmetic.** Storefront renders the classic shortcode
 * with every address field on the page; Twenty Twenty-Five renders the *block*
 * checkout, which shows an email box and hides the address behind an **Edit
 * shipping address** button. Filling by label alone therefore filled almost
 * nothing there, and **Place Order** failed validation on fields that were never
 * visible — which looked exactly like a broken product.
 *
 * That is precisely the split Gate 1's *"works on classic AND block themes"*
 * exists to catch, and it was invisible while only one theme was ever tested.
 *
 * Fields are still addressed by **label**: it is what a customer sees, and the
 * most stable thing across WooCommerce versions. Missing fields are skipped
 * rather than failed — the address a store asks for depends on its selling
 * locations, and this flow is not testing WooCommerce's address rules.
 */
export async function fillCheckout(page: Page): Promise<void> {
  /*
   * Reveal the address first. The block checkout collapses it once it believes
   * it has one, so this is a no-op on the classic form and on a repeat visit.
   */
  const edit = page.getByRole('button', { name: /edit (shipping|billing) address/i }).first();

  if (await edit.isVisible().catch(() => false)) {
    await edit.click().catch(() => undefined);
  }

  const fields: Array<[RegExp, string]> = [
    [/first name/i, 'Ada'],
    [/last name/i, 'Lovelace'],
    [/street address|address line 1|^address$/i, '1 Test Street'],
    [/town|city/i, 'Dhaka'],
    /*
     * 🔴 **A postcode is validated against the selected country.** This store's
     * base is `BD`, and a UK postcode (`SW1A 1AA`) is rejected there — the block
     * checkout shows a field alert and disables **Place Order**, which reads as a
     * broken checkout rather than a fixture whose address contradicts its
     * country. Four digits are what `BD` accepts.
     *
     * Matching the store's own locale rather than forcing the country: the
     * country control differs between the two checkouts, and a test that fights
     * it is testing WooCommerce's address UI instead of Optionia's options.
     */
    [/postcode|postal code|zip/i, '1000'],
    [/phone/i, '01700000000'],
    [/email/i, 'ada@optionia.test'],
  ];

  for (const [label, value] of fields) {
    const field = page.getByLabel(label).first();

    if (await field.isVisible().catch(() => false)) {
      await field.fill(value).catch(() => undefined);
    }
  }

  /*
   * The block checkout validates on blur and disables **Place Order** until it
   * is satisfied. Committing the last field is what releases it; without this the
   * click lands on a disabled button and the failure names the confirmation
   * rather than the form.
   */
  await page.keyboard.press('Tab').catch(() => undefined);
}
