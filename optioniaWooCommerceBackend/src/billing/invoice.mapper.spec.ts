import { InvoiceStatus } from '../common/database/enums';
import { mapInvoice } from './invoice.mapper';

/**
 * The mapper F94/E5 found missing.
 *
 * 🔴 **Five of these tests exist because the compiler contradicted me.** I wrote
 * the mapper from memory of Stripe's payload and was wrong about the tax field,
 * the paid-at path, the subscription path, and two nullabilities. Each is now a
 * named test rather than a docblock claim.
 */
describe('mapInvoice', () => {
  /** A minimal payload in the shape this API version actually sends. */
  function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'in_123',
      status: 'paid',
      currency: 'usd',
      subtotal: 5000,
      total_taxes: [{ amount: 1000 }],
      total: 6000,
      created: 1_700_000_000,
      status_transitions: { paid_at: 1_700_000_500 },
      hosted_invoice_url: 'https://invoice.stripe.com/i/abc',
      customer: 'cus_123',
      customer_address: { country: 'de' },
      parent: { subscription_details: { subscription: 'sub_123' } },
      ...overrides,
    };
  }

  function mapped(overrides: Record<string, unknown> = {}) {
    const result = mapInvoice(payload(overrides));

    if (!result.ok) {
      throw new Error(`expected a mapped invoice, got: ${result.reason}`);
    }

    return result.invoice;
  }

  it('maps a complete invoice', () => {
    expect(mapped()).toEqual({
      providerInvoiceId: 'in_123',
      status: InvoiceStatus.PAID,
      currency: 'USD',
      subtotalMinor: 5000,
      taxMinor: 1000,
      totalMinor: 6000,
      taxCountry: 'DE',
      issuedAt: new Date(1_700_000_000_000),
      paidAt: new Date(1_700_000_500_000),
      hostedUrl: 'https://invoice.stripe.com/i/abc',
      providerCustomerId: 'cus_123',
      providerSubscriptionId: 'sub_123',
    });
  });

  /** 🔴 Seconds, not milliseconds. A missing `* 1000` puts 1970 in the ledger. */
  it('converts epoch seconds to dates', () => {
    expect(mapped({ created: 1_600_000_000 }).issuedAt).toEqual(new Date(1_600_000_000_000));
  });

  describe('tax', () => {
    /** 🔴 There is no `invoice.tax`; tax is the sum of `total_taxes[].amount`. */
    it('sums every tax entry', () => {
      expect(
        mapped({ total_taxes: [{ amount: 600 }, { amount: 400 }], total: 6000 }).taxMinor,
      ).toBe(1000);
    });

    it('treats an absent tax list as zero', () => {
      expect(mapped({ total_taxes: null, total: 5000 }).taxMinor).toBe(0);
    });

    /** ⚠️ Skipping a malformed entry would understate a figure the tax report sums. */
    it('refuses a malformed tax entry rather than dropping it', () => {
      const result = mapInvoice(payload({ total_taxes: [{ amount: 'lots' }] }));

      expect(result).toEqual({ ok: false, reason: 'total_taxes must be integer minor amounts' });
    });
  });

  describe('paths that moved between API versions', () => {
    /** 🔴 `status_transitions.paid_at` is nested; a flat key yields null forever. */
    it('reads paid_at from status_transitions', () => {
      expect(mapped({ status_transitions: { paid_at: 1_700_000_900 } }).paidAt).toEqual(
        new Date(1_700_000_900_000),
      );
    });

    /** ⚠️ Only a paid invoice has a payment time, whatever the payload carries. */
    it('ignores paid_at on an unpaid invoice', () => {
      expect(mapped({ status: 'open', status_transitions: { paid_at: 1_700_000_900 } }).paidAt)
        .toBeNull();
    });

    /** 🔴 `invoice.subscription` no longer exists; it is under `parent`. */
    it('reads the subscription from parent.subscription_details', () => {
      expect(mapped().providerSubscriptionId).toBe('sub_123');
    });

    it('tolerates an invoice with no subscription parent', () => {
      expect(mapped({ parent: null }).providerSubscriptionId).toBeNull();
    });

    /** ⚠️ Stripe sends an id, or the whole object when a request expanded it. */
    it('reads an expanded customer object as well as an id', () => {
      expect(mapped({ customer: { id: 'cus_expanded', object: 'customer' } }).providerCustomerId)
        .toBe('cus_expanded');
    });
  });

  describe('the totals invariant', () => {
    /**
     * 🔴 **The total is read and checked, never computed.** The database holds
     * the same rule in `ck_invoices_totals` (F92/D2); a mapper that derived the
     * total could not violate it, which would make the constraint untestable and
     * would hide a provider disagreeing with us about what a merchant owes.
     */
    it('refuses an invoice whose parts do not sum to its total', () => {
      const result = mapInvoice(payload({ total: 9999 }));

      expect(result).toEqual({ ok: false, reason: 'totals disagree: 5000 + 1000 ≠ 9999' });
    });

    it('accepts a zero invoice', () => {
      expect(mapped({ subtotal: 0, total_taxes: null, total: 0 })).toMatchObject({
        subtotalMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
      });
    });

    /** ⚠️ Credit notes are negative; refusing them would drop real ledger rows. */
    it('accepts negative amounts', () => {
      expect(mapped({ subtotal: -5000, total_taxes: [{ amount: -1000 }], total: -6000 }))
        .toMatchObject({ totalMinor: -6000 });
    });

    /** 🔴 Minor units are integers; rounding a fraction would invent money. */
    it('refuses fractional minor units', () => {
      expect(mapInvoice(payload({ subtotal: 50.5 }))).toEqual({
        ok: false,
        reason: 'subtotal and total must be integer minor units',
      });
    });
  });

  describe('rejections', () => {
    it.each([
      ['a non-object', 42, 'payload is not an object'],
      ['null', null, 'payload is not an object'],
    ])('refuses %s', (_label, input, reason) => {
      expect(mapInvoice(input)).toEqual({ ok: false, reason });
    });

    it('refuses a payload with no invoice id', () => {
      expect(mapInvoice(payload({ id: undefined }))).toEqual({
        ok: false,
        reason: 'missing invoice id',
      });
    });

    /**
     * 🔴 **An unknown status is refused, not stored.** `InvoiceStatus`'s own
     * docblock records why: the tax report filters `status = 'paid'`, so an
     * unrecognised spelling silently drops rows from a tax total.
     */
    it('refuses a status outside the five known states', () => {
      expect(mapInvoice(payload({ status: 'partially_refunded' }))).toEqual({
        ok: false,
        reason: 'unknown invoice status: partially_refunded',
      });
    });

    it('refuses a currency that is not three letters', () => {
      expect(mapInvoice(payload({ currency: 'dollars' }))).toEqual({
        ok: false,
        reason: 'invalid currency: dollars',
      });
    });
  });

  describe('fields the columns constrain', () => {
    /** ⚠️ `taxCountry` is `char(2)`; a longer value is a different country after MySQL truncates. */
    it('drops a country that is not two letters', () => {
      expect(mapped({ customer_address: { country: 'Germany' } }).taxCountry).toBeNull();
    });

    it('tolerates an invoice with no customer address', () => {
      expect(mapped({ customer_address: null }).taxCountry).toBeNull();
    });

    it('uppercases the currency, as the rest of the system stores it', () => {
      expect(mapped({ currency: 'eur' }).currency).toBe('EUR');
    });
  });
});
