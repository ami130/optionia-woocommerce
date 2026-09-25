import { describe, expect, it } from 'vitest';

import { formatDate, formatMoney } from './format';

/**
 * Money a merchant reconciles against a card statement (M22.5).
 *
 * 🔴 **Billing amounts carry a currency and option prices do not**, which is
 * why this exists beside `formatAmount`. An invoice total without a currency is
 * a number nobody can check against their bank.
 */
describe('formatMoney', () => {
  it('renders minor units as a major amount with its currency', () => {
    /*
     * ⚠️ Asserted loosely on purpose: `Intl` picks the symbol, its position and
     * the separators from the runtime's locale, and pinning "$29.00" would make
     * this test a statement about the machine it ran on.
     */
    const formatted = formatMoney(2900, 'USD');

    expect(formatted).toMatch(/29/);
    expect(formatted).not.toMatch(/2900/);
  });

  it('keeps the minor units of a fractional amount', () => {
    expect(formatMoney(2950, 'USD')).toMatch(/29[.,]50/);
  });

  it('renders zero rather than nothing', () => {
    expect(formatMoney(0, 'USD')).toMatch(/0/);
  });

  /** ⚠️ Credit notes are negative; a refund must not render as a positive charge. */
  it('renders a negative amount as negative', () => {
    expect(formatMoney(-2900, 'USD')).toMatch(/-|\(/);
  });

  /**
   * 🔴 **A bad currency code must not blank the screen.** `Intl` throws on a
   * code it does not know, and an invoice list that renders nothing is worse
   * than one showing "29.00 XYZZY" — the merchant can still read the figure and
   * tell support what is wrong.
   */
  it('falls back to a plain amount when the currency is unknown', () => {
    expect(formatMoney(2900, 'XYZZY')).toBe('29.00 XYZZY');
  });
});

describe('formatDate', () => {
  it('renders an ISO date readably', () => {
    expect(formatDate('2026-10-25T00:00:00.000Z')).toMatch(/2026/);
  });

  /** 📌 Null is "not set", and the caller decides what to say instead. */
  it('returns null for a missing date', () => {
    expect(formatDate(null)).toBeNull();
  });

  /**
   * ⚠️ **A malformed date returns null rather than "Invalid Date".** The string
   * comes from an API response, and rendering the words "Invalid Date" into a
   * billing screen is the kind of thing a merchant screenshots.
   */
  it('returns null for a malformed date', () => {
    expect(formatDate('the tuesday after next')).toBeNull();
  });
});
