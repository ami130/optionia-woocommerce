/**
 * How a value or option is priced.
 *
 * 🔴 **Copied from the backend's `common/database/enums.ts`, which is 430
 * lines of which this is five.** ADR-083 lists that file among the evaluator's
 * dependencies; in practice `price-config-delta.ts` imports exactly this one
 * symbol, so copying the file wholesale would bring thirty unrelated enums —
 * assignment targets, audit actions, rule vocabulary — into a dashboard that
 * has its own vocabulary module for the ones it needs.
 *
 * ⚠️ **Parity is held by the shared fixture, not by this file matching.** The
 * fixture exercises every type against the same expected answers in all three
 * repositories; a divergence here fails those cases rather than passing quietly
 * because two sources looked alike.
 */
export const PriceType = {
  FIXED: 'fixed',
  PERCENTAGE: 'percentage',
  PER_UNIT: 'per_unit',
  PER_CHAR: 'per_char',
  TIERED: 'tiered',
} as const;

export type PriceType = (typeof PriceType)[keyof typeof PriceType];
