import {
  BILLING_INTERVALS,
  DEFAULT_SELLABLE_INTERVAL,
  SELLABLE_INTERVALS,
  isBillingInterval,
  isSellableInterval,
} from './billing-interval';

describe('billing intervals', () => {
  it('sells yearly only — the WooCommerce product decision', () => {
    expect([...SELLABLE_INTERVALS]).toEqual(['year']);
  });

  it('still RECOGNISES monthly, so historical rows keep resolving', () => {
    // 🔴 A subscription pinned to a monthly price must keep rendering its
    // invoices. What changed is what may be BOUGHT, not what may be read.
    expect(isBillingInterval('month')).toBe(true);
    expect(isSellableInterval('month')).toBe(false);
  });

  it('accepts yearly on both the read and sell side', () => {
    expect(isBillingInterval('year')).toBe(true);
    expect(isSellableInterval('year')).toBe(true);
  });

  it('refuses anything outside the vocabulary', () => {
    for (const bad of ['week', 'annual', 'YEAR', '', 'yearly']) {
      expect(isBillingInterval(bad)).toBe(false);
      expect(isSellableInterval(bad)).toBe(false);
    }
  });

  it('refuses non-strings rather than coercing them', () => {
    for (const bad of [null, undefined, 1, {}, ['year']]) {
      expect(isBillingInterval(bad)).toBe(false);
      expect(isSellableInterval(bad)).toBe(false);
    }
  });

  it('derives the default from the sellable list rather than restating it', () => {
    expect(SELLABLE_INTERVALS).toContain(DEFAULT_SELLABLE_INTERVAL);
    expect(isSellableInterval(DEFAULT_SELLABLE_INTERVAL)).toBe(true);
  });

  it('keeps every sellable interval inside the recognised vocabulary', () => {
    // A sellable interval the database cannot store would be unbuyable in a way
    // no error message would explain.
    for (const i of SELLABLE_INTERVALS) {
      expect(BILLING_INTERVALS as readonly string[]).toContain(i);
    }
  });
});
