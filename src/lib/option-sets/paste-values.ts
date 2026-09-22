import { parseAmount } from '@/lib/money/money';
import { keyFromLabel } from '@/lib/schemas/option-sets';

/**
 * Bulk paste (M20.4) — "merchants have existing lists".
 *
 * ## Why every rule is checked before a single request goes out
 *
 * 🔴 **The API enforces its limits PER CREATE, so a bad paste writes half an
 * option.** `valuesPerOption` is counted on each insert and a duplicate
 * `valueKey` is refused the same way — so a 300-row paste that crosses either
 * line fails partway through, leaving values written that the merchant never
 * sees confirmed and **cannot undo**: a create is a shape change, and shape
 * changes clear the undo log (M20.10).
 *
 * So the whole list is parsed and validated first, and a paste with any problem
 * writes **nothing**. Refusing costs a merchant one correction; part-writing
 * costs them a manual cleanup against a limit they cannot see.
 *
 * ⚠️ **Existing values count toward the limit.** An option holding 480 accepts
 * twenty more, not five hundred — the count the API compares against is the
 * option's, not the paste's.
 */

/**
 * The most values one option may hold.
 *
 * ⚠️ **Mirrors `AUTHORING_LIMITS.valuesPerOption` in the API.** Duplicated
 * rather than fetched because the check must happen before any request, and a
 * client that guessed lower would refuse pastes the server would accept. The
 * cost of it drifting is a refusal message that disagrees with a 400 — visible,
 * unlike a silent part-write.
 */
export const MAX_PASTED_VALUES = 500;

/** Mirrors `MAX_VALUE_LABEL` in the schema module. */
const MAX_LABEL = 200;

/** One value a paste would create. */
export interface PastedValue {
  readonly label: string;
  readonly valueKey: string;
  readonly priceAmountMinor: number;
}

/** Why one line cannot be used. */
export interface PasteProblem {
  /** 1-based, as a merchant counts the lines they pasted. */
  readonly line: number;
  readonly message: string;
}

export type PasteResult =
  | { readonly ok: true; readonly values: PastedValue[] }
  | { readonly ok: false; readonly problems: PasteProblem[] };

/**
 * A label and an optional price, separated by a tab or a comma.
 *
 * 🔴 **A TAB wins over a comma, and this was measured wrong first.** Searching
 * for whichever separator came first refused `"Medium, wide\t2.50"` — a label
 * containing a comma, tab-separated from its price, which is what a spreadsheet
 * actually pastes for a label like "Medium, wide". The comma inside the label
 * split the line and *"wide\t2.50"* was reported as a malformed amount.
 *
 * ⚠️ **The first version's comment claimed tab priority; the code searched for
 * either.** A docblock describing intent rather than behaviour.
 *
 * 📌 **With no tab, the first comma splits.** A hand-typed list has no tabs,
 * and a label with a comma in it then has no way to carry a price — refused
 * with a message rather than guessed at.
 */
function splitLine(line: string): { label: string; amount: string } {
  const at = line.includes('\t') ? line.indexOf('\t') : line.indexOf(',');

  return at === -1
    ? { label: line.trim(), amount: '' }
    : { label: line.slice(0, at).trim(), amount: line.slice(at + 1).trim() };
}

/**
 * Parse a pasted block into values, or into every reason it cannot be used.
 *
 * 📌 **Every problem is reported, not only the first.** A merchant fixing a
 * hundred-line paste one error at a time would paste a hundred times.
 */
export function parsePastedValues(text: string, existingKeys: readonly string[]): PasteResult {
  const lines = text.split('\n');
  const problems: PasteProblem[] = [];
  const values: PastedValue[] = [];

  /* Case-insensitively, because `keyFromLabel` lowercases — "Small" and "small"
   * produce one key, and the API would refuse the second. */
  const taken = new Set(existingKeys.map((key) => key.toLowerCase()));

  lines.forEach((raw, index) => {
    const line = index + 1;

    if (raw.trim() === '') {
      /* A trailing newline is normal, not an error. */
      return;
    }

    const { label, amount } = splitLine(raw);

    if (label === '') {
      problems.push({ line, message: 'This line has no label.' });

      return;
    }

    if (label.length > MAX_LABEL) {
      problems.push({ line, message: `That label is longer than ${MAX_LABEL} characters.` });

      return;
    }

    const valueKey = keyFromLabel(label);

    if (valueKey === '') {
      problems.push({ line, message: `"${label}" has no letters or numbers to make a key from.` });

      return;
    }

    if (taken.has(valueKey)) {
      problems.push({ line, message: `"${label}" repeats a value that already exists.` });

      return;
    }

    /*
     * 🔴 **A malformed price is refused, never coerced.** `Number(x) || 0`
     * would turn "ten pounds" into a free value, and the merchant would publish
     * the giveaway believing they had set a price.
     */
    let priceAmountMinor = 0;

    if (amount !== '') {
      const money = parseAmount(amount);

      if (!money.ok) {
        problems.push({ line, message: `"${amount}" is not an amount.` });

        return;
      }

      priceAmountMinor = money.minor;
    }

    taken.add(valueKey);
    values.push({ label, valueKey, priceAmountMinor });
  });

  if (problems.length === 0 && values.length === 0) {
    return { ok: false, problems: [{ line: 1, message: 'There is nothing to paste.' }] };
  }

  /*
   * ⚠️ **Counted against what the option already holds**, and reported once
   * rather than per line — a paste fifty over the limit is one problem, not
   * fifty.
   */
  if (existingKeys.length + values.length > MAX_PASTED_VALUES) {
    problems.push({
      line: 1,
      message:
        `An option holds at most ${MAX_PASTED_VALUES} values. ` +
        `This one has ${existingKeys.length} and the paste adds ${values.length}.`,
    });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, values };
}
