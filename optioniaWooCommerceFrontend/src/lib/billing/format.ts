import { formatAmount } from '@/lib/money/money';

/**
 * A billing figure, with its currency (M22.5).
 *
 * 🔴 **Billing amounts carry a currency and option prices do not**, which is
 * why this exists beside `formatAmount` rather than replacing it. A store's
 * option surcharges are always in the store's own currency, so showing a symbol
 * there would be noise; an invoice is a charge in a stated currency, and an
 * amount without one is a number a merchant cannot reconcile against a card
 * statement.
 *
 * ⚠️ **`Intl.NumberFormat` and not a symbol table.** A hand-rolled map is wrong
 * the first time someone is billed in a currency nobody thought of, and it puts
 * the symbol on the wrong side for half of Europe.
 */
export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(minor / 100);
  } catch {
    /*
     * 📌 **A bad currency code must not blank the screen.** `Intl` throws on a
     * code it does not know, and an invoice list that renders nothing is worse
     * than one showing "29.00 XYZ" — the merchant can still read the figure and
     * tell support what is wrong.
     */
    return `${formatAmount(minor)} ${currency}`;
  }
}

/** A date a merchant reads, or nothing. */
export function formatDate(iso: string | null): string | null {
  if (iso === null) {
    return null;
  }

  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
