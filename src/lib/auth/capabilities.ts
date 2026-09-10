/**
 * What a role may do, as the dashboard understands it.
 *
 * ## This is a *hint*, never enforcement
 *
 * Every response is authorised by the API against the token, so a merchant who
 * edits this away sees a string of 403s rather than extra power. What it buys is
 * that the UI **stops offering actions that cannot succeed** — an editor seeing
 * a Disconnect button, clicking it, and being told they lack permission is a
 * defect even though nothing insecure happened.
 *
 * ## Mirrored from the API, and kept small on purpose
 *
 * `capabilities.ts` in `optioniaWooCommerceBackend` is the source of truth. Only
 * the capabilities this dashboard actually branches on are listed here: a full
 * copy would be a second table to keep in step, and every entry that no screen
 * reads is one that can drift unnoticed.
 *
 * Added in Phase 13 Stage 3, after the audit found both store screens offering
 * actions `viewer` and `editor` cannot perform.
 */

/** The capabilities the dashboard branches on today. */
export type UiCapability =
  | 'stores:connect'
  | 'products:view'
  | 'products:assign'
  | 'option_sets:edit'
  | 'option_sets:delete'
  | 'option_sets:publish'
  | 'option_sets:rollback';

/**
 * Role → capabilities, for the subset above.
 *
 * `viewer` and `billing` appear with empty lists rather than being omitted, so a
 * reader can see they were considered rather than forgotten.
 */
const ROLE_CAPABILITIES: Readonly<Record<string, readonly UiCapability[]>> = {
  owner: [
    'stores:connect',
    'products:view',
    'products:assign',
    'option_sets:edit',
    'option_sets:delete',
    'option_sets:publish',
    'option_sets:rollback',
  ],
  admin: [
    'stores:connect',
    'products:view',
    'products:assign',
    'option_sets:edit',
    'option_sets:delete',
    'option_sets:publish',
    'option_sets:rollback',
  ],
  /**
   * 🔴 **An editor may edit and nothing else** — and this is the common case for
   * the option-set screens, since authoring is the role's whole purpose.
   *
   * `delete`, `publish` and `rollback` are all separate capabilities they lack.
   * Carrying only `edit` and `publish` here — as this table did until Stage 4 —
   * would have offered an editor three buttons that answer `403`, which is the
   * defect the Stage 3 audit found on the store screens, on a screen with four
   * buttons instead of one.
   */
  /**
   * ⚠️ **The products split is not the option-set split.** An editor may
   * `products:assign` — assigning a set to a product is authoring — while
   * holding none of `delete`, `publish` or `rollback`. Guessing from the
   * option-set pattern would get this wrong in both directions.
   */
  editor: ['option_sets:edit', 'products:view', 'products:assign'],
  /** A viewer sees the catalogue and must not be offered **Assign**. */
  viewer: ['products:view'],
  billing: [],
};

/**
 * Whether this role may do that.
 *
 * **Deny by default.** An unknown role — one added to the API before this table
 * — gets nothing, so a new role appears as missing buttons rather than as
 * buttons that fail. That is the correct direction for the mistake to fall, and
 * it matches the API's own `deny by default` rule.
 */
export function roleCan(role: string | null | undefined, capability: UiCapability): boolean {
  if (role === null || role === undefined) {
    return false;
  }

  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}
