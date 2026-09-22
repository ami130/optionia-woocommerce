import type {
  AuthoringGroup,
  AuthoringOption,
  AuthoringRule,
  AuthoringSet,
  AuthoringValue,
} from '@/lib/option-sets/api';

import { toPublishedPriceConfig } from '@/lib/money/to-wire-price-config';

import {
  toPublishedDisplay,
  toPublishedOptionPricing,
  toPublishedValidation,
} from './published-shape';

/**
 * The authoring tree reduced to what a storefront would actually receive.
 *
 * ## Why this exists rather than handing the editor's tree to the preview
 *
 * 🔴 **A disabled thing is *absent* from the published document, not present
 * and flagged.** The publish serializer drops disabled groups, options, values
 * and rules before the document is built, so the storefront never sees the flag
 * — only its effect. A preview rendering the raw authoring tree would show a
 * merchant four things the storefront will not show, and — worse — would fire
 * rules the storefront has dropped.
 *
 * ## The one asymmetry worth knowing about
 *
 * ⚠️ **`AuthoringValue.isEnabled` is optional where group, option and rule are
 * required** (`api.ts:267` against `:61`, `:123`, `:1139`). The backend column
 * is `default: true` and not nullable, so a stored row always has a boolean —
 * but the dashboard's own type permits the field to be absent, and its fixtures
 * construct values without it. `.filter((v) => v.isEnabled)` would therefore
 * drop every value whose flag simply was not sent.
 *
 * `!== false` is the idiom the editor already uses for exactly this field
 * (`option-sets/[id]/page.tsx:3164`, `:3246`), and it is the one used here.
 *
 * ## Pricing converts; rules do not (ADR-103)
 *
 * The two evaluators read opposite dialects — `priceConfigDelta` wants
 * `snake_case` because it was extracted from the published projection, and
 * `rule-evaluator` wants `camelCase` because it was extracted from the authoring
 * model. So `pricing` and `display` are converted on the way through and rules
 * are handed on exactly as authored. Converting rules too would break
 * evaluation; leaving pricing alone would silently zero every price — a failure
 * this repository has already recorded once.
 *
 * ⚠️ **All three per-option transforms, not two.** The serializer converts
 * `validation`, `pricing` and `display`; this converted only the last two until
 * an audit counted them against each other. A renderer enforcing
 * `validation.maxLength` would have honoured a limit the storefront — which
 * reads `max_length` — does not. `bin/check-preview-filters.sh` now counts
 * transforms as well as filters, so a fourth cannot go missing the same way.
 *
 * ⚠️ **Values convert too, so the whole tree speaks one dialect.**
 *
 * ✏️ **This file previously left `priceConfig` in the stored spelling**, on the
 * reasoning that `toPublishedPriceConfig` needs the row's
 * `priceType`/`priceAmountMinor` as a fallback and so "cannot run without the
 * value beside it". That reasoning was wrong — both fields are *on* the value,
 * so the converter runs here perfectly well.
 *
 * 🔴 **What it cost:** a value carrying `{ type: 'percentage', basisPoints: 250 }`
 * came off this tree unchanged, and a renderer feeding it to `priceConfigDelta`
 * got `{ deltaMinor: 0, unpriced: 'percentage' }` — a 2.5% surcharge priced at
 * **zero**. Exactly the regression ADR-103 exists to prevent. Worse than a plain
 * bug: `option.pricing` *was* converted, so the two pricing fields disagreed and
 * a renderer had to know which was which, with a silent zero for guessing wrong.
 *
 * ⚠️ **`price_config` is unconditional**, matching the serializer. A value with
 * no JSON gets `{ type, amount_minor }` synthesised from its columns — every
 * choice value takes that path, because a radio prices per value rather than per
 * option.
 */
export interface PreviewTree {
  readonly groups: readonly PreviewGroup[];
  readonly rules: readonly AuthoringRule[];
}

export interface PreviewGroup extends Omit<AuthoringGroup, 'options'> {
  readonly options: readonly PreviewOption[];
}

export interface PreviewOption extends Omit<AuthoringOption, 'values'> {
  readonly values: readonly PreviewValue[];
}

/**
 * A value whose `priceConfig` is the published shape rather than the stored one,
 * and is always present — the columns stand in when there is no JSON.
 *
 * 🔴 **Converting an already-converted config destroys the amount, silently.**
 * `toPublishedPriceConfig` reads `amountMinor` and writes `amount_minor`, so a
 * second pass finds nothing to read: measured,
 * `{ type: 'fixed', amount_minor: 500 }` becomes
 * `{ type: 'fixed', amount_minor: undefined }` and prices as **zero** — the
 * same silent-zero failure this tree was fixed to remove, from the other
 * direction.
 *
 * ⚠️ **A branded type cannot prevent it, and one was tried.** An intersection
 * carrying a `unique symbol` is still assignable to the converter's
 * `Record<string, unknown>` parameter, so it compiles regardless; refusing it
 * would mean narrowing the signature of shared money code whose cross-repository
 * equivalence `bin/check-evaluator-parity.sh` compares as text. So the guard is
 * this type's *name* and a test, not the compiler — recorded plainly rather than
 * left as a brand that reads like protection and is not.
 */
export interface PreviewValue extends Omit<AuthoringValue, 'priceConfig'> {
  readonly priceConfig: Record<string, unknown>;
}

/**
 * Whether a value survives into the document.
 *
 * Absent means enabled — see the note on the asymmetry above.
 */
export function valueIsEnabled(value: AuthoringValue): boolean {
  return value.isEnabled !== false;
}

/**
 * One value, with its price in the dialect the evaluator reads.
 *
 * The other fields stay as authored, for the reason ADR-103 gives: a renderer
 * reads this tree, and the dashboard's own components are written against the
 * authoring spelling. Only the parts an **evaluator** consumes are converted.
 */
function toPreviewValue(value: AuthoringValue): PreviewValue {
  return {
    ...value,
    priceConfig: toPublishedPriceConfig(value.priceConfig ?? null, {
      priceType: value.priceType,
      priceAmountMinor: value.priceAmountMinor,
    }),
  };
}

/**
 * The published view of an authoring set, for the preview to render.
 *
 * @param set The set as the editor holds it, disabled rows and all.
 * @returns Only what the storefront would receive, with pricing converted.
 */
export function previewTree(set: AuthoringSet): PreviewTree {
  return {
    groups: set.groups
      .filter((group) => group.isEnabled)
      .map((group) => ({
        ...group,
        options: group.options
          .filter((option) => option.isEnabled)
          .map((option) => ({
            ...option,
            validation: toPublishedValidation(option.validation),
            pricing: toPublishedOptionPricing(option.pricing),
            display: toPublishedDisplay(option.display),
            values: option.values.filter(valueIsEnabled).map(toPreviewValue),
          })),
      })),

    /*
     * ⚠️ **Rules are dropped, never disabled-but-present.** M17.3's
     * `RULE_TARGET_NOT_PUBLISHED` warning tells a merchant that a rule aimed at
     * a disabled target will not fire; a preview that fired it anyway would make
     * that warning a lie.
     *
     * `rules` is optional on `AuthoringSet` because `createSet` and
     * `duplicateSet` return a bare summary — a set whose rules have not been
     * loaded previews with none, which is right: none have been authored yet.
     */
    rules: (set.rules ?? []).filter((rule) => rule.isEnabled),
  };
}
