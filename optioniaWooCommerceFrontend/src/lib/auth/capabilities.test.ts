import { describe, expect, it } from 'vitest';

import { roleCan, type UiCapability } from './capabilities';

describe('roleCan', () => {
  /**
   * 🔴 **The finding this table exists for.**
   *
   * Stage 0 granted `stores:view` to `editor` and `viewer`, so both can see the
   * store list — but neither has `stores:connect`. Both screens offered a
   * Disconnect button and a Connect button that answered `403` on click.
   */
  it.each([
    ['owner', true],
    ['admin', true],
    ['editor', false],
    ['viewer', false],
    ['billing', false],
  ])('%s may connect a store: %s', (role, expected) => {
    expect(roleCan(role, 'stores:connect')).toBe(expected);
  });

  /**
   * 🔴 **`option_sets` has four capabilities, and an editor holds one.**
   *
   * Authoring is the editor role's whole purpose, so this screen is where they
   * spend their time — and a table carrying only `edit` and `publish` would have
   * offered them Delete, Publish and Rollback buttons that all answer `403`.
   */
  it.each<[string, boolean, boolean, boolean, boolean]>([
    // role, edit, delete, publish, rollback
    ['owner', true, true, true, true],
    ['admin', true, true, true, true],
    ['editor', true, false, false, false],
    ['viewer', false, false, false, false],
    ['billing', false, false, false, false],
  ])('%s: edit=%s delete=%s publish=%s rollback=%s', (role, edit, del, publish, rollback) => {
    expect(roleCan(role, 'option_sets:edit')).toBe(edit);
    expect(roleCan(role, 'option_sets:delete')).toBe(del);
    expect(roleCan(role, 'option_sets:publish')).toBe(publish);
    expect(roleCan(role, 'option_sets:rollback')).toBe(rollback);
  });

  /**
   * 🔴 **The products split differs from the option-set one.**
   *
   * `editor` may assign — that is authoring — while holding none of `delete`,
   * `publish` or `rollback`. And `viewer` may **see** the catalogue without
   * assigning, so a screen offering Assign to everyone who can read is the
   * defect this table exists to prevent, on its third occurrence in the phase.
   */
  it.each<[string, boolean, boolean]>([
    // role, view, assign
    ['owner', true, true],
    ['admin', true, true],
    ['editor', true, true],
    ['viewer', true, false],
    ['billing', false, false],
  ])('%s: products:view=%s products:assign=%s', (role, view, assign) => {
    expect(roleCan(role, 'products:view')).toBe(view);
    expect(roleCan(role, 'products:assign')).toBe(assign);
  });

  /**
   * **Deny by default**, matching the API's own rule.
   *
   * A role added there before it is added here appears as missing buttons rather
   * than as buttons that fail — the correct direction for the mistake to fall.
   */
  it.each([null, undefined, '', 'superuser', 'Owner'])('grants %s nothing', (role) => {
    const capabilities: UiCapability[] = [
      'stores:connect',
      'products:view',
      'products:assign',
      'option_sets:edit',
      'option_sets:delete',
      'option_sets:publish',
      'option_sets:rollback',
    ];

    for (const capability of capabilities) {
      expect(roleCan(role, capability)).toBe(false);
    }
  });
});
