import { formatAmount, parseAmount } from '@/lib/money/money';

/**
 * Option-level pricing, as a merchant authors it.
 *
 * ## Why an option prices at all
 *
 * 🔴 **A choice option prices per VALUE; a text or number option has no values
 * to hang a price on.** A radio's "Gold +£5" belongs to the value; an
 * engraving's "50p per character" belongs to the option, because the customer
 * types the answer rather than choosing one. `PRICING-SPEC.md` §2 defines
 * `per_char` at the option level for exactly that reason, and M16.2/M16.3 added
 * `per_unit` and `tiered` for the number types.
 *
 * ⚠️ **Which kinds an option may use is the REGISTRY's decision.** The API
 * validates `pricing` against that option type's `pricingSchema` —
 * `noTypeLevelPricing` for the choice types, which accepts only `null`. A form
 * offering a kind the API would refuse is one that fails on save, so the list
 * is mirrored here rather than guessed.
 *
 * 📌 **`tiered` lives in `tiers.ts`**, because its brackets are validated as a
 * *set* — gaps between them, overlaps, and open ends at both extremes — against
 * the API's own copied schema rather than rules restated here.
 */

/** What a merchant may choose for an option of this presentation. */
export type OptionPricingKind = 'per_char' | 'per_unit' | 'tiered';

/**
 * The kinds this editor can author for a presentation.
 *
 * ⚠️ **Mirrors `type-registry.ts`**, where `textOptionPricing` accepts
 * `per_char` and `numberOptionPricing` accepts `per_unit` or `tiered`. A choice
 * type returns nothing, which is what `noTypeLevelPricing` enforces.
 */
export function optionPricingKinds(presentation: string): OptionPricingKind[] {
  if (presentation === 'text_field' || presentation === 'textarea') {
    return ['per_char'];
  }

  if (presentation === 'number_field' || presentation === 'range' || presentation === 'quantity') {
    return ['per_unit', 'tiered'];
  }

  return [];
}

/** The fields an option-pricing form holds. */
export interface OptionPricingFields {
  amount: string;
  free: string;
}

export type OptionPricingParse =
  | { ok: true; pricing: Record<string, unknown> | null }
  | { ok: false; message: string };

/**
 * Build the stored pricing object, or say why it cannot be built.
 *
 * 🔴 **A blank amount CLEARS the pricing rather than failing.** "I do not
 * charge for this" is an ordinary intent, and refusing it would leave a
 * merchant unable to undo a price they had set.
 *
 * ⚠️ **The STORED shape — `amountMinor`, `freeCharacters`.**
 * `pricing.schema.ts` validates this dialect; `toPublishedPriceConfig` converts
 * to the wire shape the plugin reads. Sending snake_case here is the M20.6 F1
 * defect, one level up.
 */
export function parseOptionPricing(
  kind: OptionPricingKind,
  fields: OptionPricingFields,
): OptionPricingParse {
  if (fields.amount.trim() === '') {
    return { ok: true, pricing: null };
  }

  const money = parseAmount(fields.amount);

  if (!money.ok) {
    return { ok: false, message: 'Enter an amount like 0.50.' };
  }

  if (kind === 'per_unit') {
    /*
     * ⚠️ **No free allowance, deliberately.** `pricing.schema.ts` records why:
     * a free-unit allowance is a *volume discount*, which `tiered` expresses
     * with brackets a merchant can see. Two mechanisms for one intent is two
     * places for them to disagree.
     */
    return { ok: true, pricing: { type: 'per_unit', amountMinor: money.minor } };
  }

  const free = fields.free.trim();

  if (free === '') {
    return { ok: true, pricing: { type: 'per_char', amountMinor: money.minor, freeCharacters: 0 } };
  }

  /*
   * 🔴 **Parsed, not `Number()`.** `Number('')` is 0 and `Number('1e3')` is
   * 1000 — a blank would become a real allowance and an exponent a number
   * nobody typed.
   */
  if (!/^\d+$/.test(free)) {
    return { ok: false, message: 'Free characters must be a whole number, or blank.' };
  }

  const freeCharacters = Number(free);

  if (freeCharacters > 10_000) {
    return { ok: false, message: 'That is more free characters than the API accepts.' };
  }

  return { ok: true, pricing: { type: 'per_char', amountMinor: money.minor, freeCharacters } };
}

/**
 * Read stored pricing back into form fields.
 *
 * ⚠️ **A stored `tiered` reports its kind with empty fields.** This editor
 * cannot author one, and showing it as unpriced would invite a merchant to
 * overwrite a bracket set they cannot see.
 */
export function readOptionPricing(pricing: Record<string, unknown> | null | undefined): {
  kind: string;
  amount: string;
  free: string;
} {
  if (!pricing || typeof pricing.type !== 'string') {
    return { kind: '', amount: '', free: '' };
  }

  const amount =
    typeof pricing.amountMinor === 'number' ? formatAmount(pricing.amountMinor) : '';

  return {
    kind: pricing.type,
    amount: pricing.type === 'tiered' ? '' : amount,
    free:
      pricing.type === 'per_char' && typeof pricing.freeCharacters === 'number'
        ? String(pricing.freeCharacters)
        : '',
  };
}
