/* 🔴 See BillingModule: a default import of `stripe` is `undefined` at runtime. */
import Stripe = require('stripe');

import { InvoiceStatus } from '../common/database/enums';
import { mapInvoice } from './invoice.mapper';

/**
 * Ties the mapper to the library's own types, so drift fails to compile.
 *
 * 🔴 **`invoice.mapper.spec.ts` alone cannot catch a wrong assumption.** Its
 * fixtures are hand-written `Record<string, unknown>`, so they encode what I
 * *believe* Stripe sends — and I was wrong about four fields until the compiler
 * said so. A fixture typed as `Stripe.Invoice` cannot drift silently: when the
 * pinned API version moves and a field is renamed, **this file stops
 * compiling**, which is the failure the version pin exists to produce.
 *
 * ⚠️ These are type assertions first and assertions second. The value of the
 * suite is in `tsc`, not only in the expectations below.
 */
describe('mapInvoice against the library types', () => {
  /*
   * A paid invoice, typed. `as` only fills the many fields this mapper ignores;
   * every field it *reads* is spelled out and therefore checked.
   */
  const invoice = {
    id: 'in_typed',
    object: 'invoice',
    status: 'paid',
    currency: 'usd',
    subtotal: 2500,
    total: 3000,
    total_taxes: [{ amount: 500 } as Stripe.Invoice.TotalTax],
    created: 1_700_000_000,
    status_transitions: { paid_at: 1_700_000_600 } as Stripe.Invoice.StatusTransitions,
    hosted_invoice_url: 'https://invoice.stripe.com/i/typed',
    customer: 'cus_typed',
    customer_address: { country: 'FR' } as Stripe.Address,
    parent: {
      subscription_details: { subscription: 'sub_typed' },
    } as Stripe.Invoice.Parent,
  } as Stripe.Invoice;

  it('maps an invoice typed as the library declares it', () => {
    const result = mapInvoice(invoice);

    expect(result).toEqual({
      ok: true,
      invoice: {
        providerInvoiceId: 'in_typed',
        status: InvoiceStatus.PAID,
        currency: 'USD',
        subtotalMinor: 2500,
        taxMinor: 500,
        totalMinor: 3000,
        taxCountry: 'FR',
        issuedAt: new Date(1_700_000_000_000),
        paidAt: new Date(1_700_000_600_000),
        hostedUrl: 'https://invoice.stripe.com/i/typed',
        providerCustomerId: 'cus_typed',
        providerSubscriptionId: 'sub_typed',
      },
    });
  });

  /**
   * 🔴 **Every status the library declares is one this system stores.** If a
   * future API version adds a sixth state, this fails once the list below is
   * updated to match it — and the enum's docblock
   * explains the stakes: the tax report filters `status = 'paid'`, so an
   * unmapped state silently drops rows from a tax total.
   *
   * ⚠️ **`satisfies Stripe.Invoice.Status[]` checks nothing here, and saying it
   * did was wrong.** Stripe's union is open (`'draft' | ... | OtherString`), so
   * it accepts *any* string — a mutation adding `'refunded'` to this list
   * compiled without complaint. The guard is the runtime comparison below,
   * which does fail, and the list is maintained by hand against the library's
   * declaration.
   *
   * 📌 The annotation is kept only to document intent; it is not load-bearing.
   */
  it('stores every invoice status the library declares', () => {
    const declared: readonly Stripe.Invoice.Status[] = [
      'draft',
      'open',
      'paid',
      'uncollectible',
      'void',
    ];

    expect([...declared].sort()).toEqual([...Object.values(InvoiceStatus)].sort());
  });
});
