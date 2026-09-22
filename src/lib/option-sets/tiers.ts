import { formatAmount, parseAmount } from '@/lib/money/money';
import { tieredPricing } from '@/lib/money/pricing-schema';

/**
 * Quantity brackets, between the form and the API.
 *
 * ## Why the API's schema validates this, rather than rules written here
 *
 * 🔴 **Six of the rules are about the SET, not a row.** A gap between brackets,
 * an overlap, an unbounded tier in the middle, a set that does not start at 1, a
 * last tier that is bounded, a tier ending before it starts — each is a **wrong
 * charge** rather than a malformed document, and none is visible from the row a
 * merchant is typing into.
 *
 * ⚠️ **So `tieredPricing` is copied from the API, not restated** — ADR-083's
 * discipline applied to a schema. `pricing.schema.ts` imports only `zod`, so it
 * ports exactly; rules written again here would be a second opinion about what
 * the API accepts, and the two would disagree the first time either changed.
 *
 * 🔴 **The zod MAJOR differs — backend 4.4.3, dashboard 3.25.76 — and that was
 * checked before the copy, not after.** `code: 'custom'`, `.strict()`,
 * `discriminatedUnion` and `.default()` were each probed under zod 3, then all
 * eleven tier cases were run on **both** sides and every answer matched.
 */

/** One bracket, as the form holds it: all strings, all possibly half-typed. */
export interface TierRow {
  min: string;
  max: string;
  amount: string;
}

export type TierParse =
  | { ok: true; pricing: { type: 'tiered'; tiers: TierBracket[] } | null }
  | { ok: false; problems: string[] };

interface TierBracket {
  minQuantity: number;
  maxQuantity: number | null;
  amountMinor: number;
}

/** A whole number, as the schema requires. Not `Number()`, for the usual reason. */
const wholeNumber = (input: string): number | null =>
  /^\d+$/.test(input.trim()) ? Number(input.trim()) : null;

/**
 * Turn the form's rows into stored pricing, or into every reason it cannot be.
 *
 * 📌 **Rows that are entirely blank are dropped**, so a merchant who adds a row
 * and changes their mind is not blocked by it. All rows blank means "not
 * tier-priced", which clears rather than fails.
 */
export function parseTiers(rows: readonly TierRow[]): TierParse {
  const filled = rows.filter(
    (row) => row.min.trim() !== '' || row.max.trim() !== '' || row.amount.trim() !== '',
  );

  if (filled.length === 0) {
    return { ok: true, pricing: null };
  }

  const problems: string[] = [];
  const tiers: TierBracket[] = [];

  filled.forEach((row, index) => {
    const line = index + 1;
    const min = wholeNumber(row.min);
    const money = parseAmount(row.amount);

    if (min === null || min < 1) {
      problems.push(`Bracket ${line}: the starting quantity must be a whole number from 1.`);
    }

    /*
     * Blank means open-ended, which the last bracket must be.
     *
     * ⚠️ **`wholeNumber('')` is already `null`**, because `/^\d+$/` fails on an
     * empty string — so an explicit blank check here was redundant, and a mutant
     * removing it survived (M205). Verified rather than assumed: both forms
     * agree on every input shape. The comment carries the intent that the
     * expression no longer states.
     */
    const max = wholeNumber(row.max);

    if (row.max.trim() !== '' && max === null) {
      problems.push(`Bracket ${line}: the ending quantity must be a whole number, or blank.`);
    }

    if (!money.ok) {
      problems.push(`Bracket ${line}: the amount must look like 5.00.`);
    }

    if (min !== null && min >= 1 && money.ok) {
      tiers.push({ minQuantity: min, maxQuantity: max, amountMinor: money.minor });
    }
  });

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  /*
   * 🔴 **The API's own schema decides whether the SET is valid**, and its
   * messages are what the merchant reads — so the form and the wire can never
   * disagree about which bracket sets are acceptable.
   */
  const checked = tieredPricing.safeParse({ type: 'tiered', tiers });

  if (!checked.success) {
    return { ok: false, problems: checked.error.issues.map((issue) => issue.message) };
  }

  return { ok: true, pricing: { type: 'tiered', tiers } };
}

/**
 * Read stored brackets back into form rows.
 *
 * 📌 **One empty row when nothing is stored**, rather than none: a merchant
 * opening the editor should have somewhere to type.
 */
export function readTiers(pricing: Record<string, unknown> | null | undefined): TierRow[] {
  const stored = Array.isArray(pricing?.tiers) ? (pricing.tiers as Record<string, unknown>[]) : [];

  if (stored.length === 0) {
    return [{ min: '', max: '', amount: '' }];
  }

  return stored.map((tier) => ({
    min: typeof tier.minQuantity === 'number' ? String(tier.minQuantity) : '',
    max: typeof tier.maxQuantity === 'number' ? String(tier.maxQuantity) : '',
    amount: typeof tier.amountMinor === 'number' ? formatAmount(tier.amountMinor) : '',
  }));
}
