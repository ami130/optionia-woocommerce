import { describe, expect, it } from 'vitest';

import type { PublishFinding } from '@/lib/option-sets/api';
import { publishGate, publishResultIsCurrent } from './publish-gate';

const finding = (severity: PublishFinding['severity'], code: string): PublishFinding => ({
  severity,
  code,
  subject: `option:${code}`,
  message: `${code} needs attention`,
});

describe('publishGate', () => {
  /**
   * 🔴 **The mutation this file exists for.** Dropping `blocked` from the
   * button's `disabled` — publishing a set with unresolved blockers to a live
   * storefront — left all 1752 tests passing before this module existed.
   */
  it('blocks when any finding is a blocker', () => {
    const gate = publishGate([finding('blocker', 'no-values')]);

    expect(gate.blocked).toBe(true);
  });

  /**
   * ⚠️ **The opposite defect, and it is equally real.** A warning is *"worth
   * knowing"* — trapping a merchant behind advice they have read and accepted
   * is not a safer failure, it is a different one.
   */
  it('does not block on warnings alone', () => {
    const gate = publishGate([finding('warning', 'no-assignment')]);

    expect(gate.blocked).toBe(false);
    expect(gate.warnings).toHaveLength(1);
  });

  /** Both kinds at once: the blocker decides, and the warning still surfaces. */
  it('separates the two without losing either', () => {
    const gate = publishGate([finding('blocker', 'no-values'), finding('warning', 'no-assignment')]);

    expect(gate.blocked).toBe(true);
    expect(gate.blockers.map((f) => f.code)).toEqual(['no-values']);
    expect(gate.warnings.map((f) => f.code)).toEqual(['no-assignment']);
  });

  /**
   * 📌 **`undefined` is "not asked yet", and it must not block.** The check is
   * a query; treating its pending state as a blocker would disable the button
   * on every load and read as a set that can never ship.
   */
  it('does not block before the check has answered', () => {
    expect(publishGate(undefined).blocked).toBe(false);
    expect(publishGate([]).blocked).toBe(false);
  });

  /** A clean set says nothing beside its button. */
  it('summarises nothing when nothing blocks', () => {
    expect(publishGate([]).summary).toBeNull();
  });

  /** One is spelled out; more is counted. Neither reads as machine output. */
  it('counts what must be fixed', () => {
    expect(publishGate([finding('blocker', 'a')]).summary).toBe('1 thing to fix');
    expect(publishGate([finding('blocker', 'a'), finding('blocker', 'b')]).summary).toBe(
      '2 things to fix',
    );
  });

  /** The summary counts blockers only — a warning is not something to fix first. */
  it('does not count warnings as things to fix', () => {
    expect(publishGate([finding('blocker', 'a'), finding('warning', 'b')]).summary).toBe(
      '1 thing to fix',
    );
  });
});

describe('publishResultIsCurrent', () => {
  /**
   * 🔴 **The defect this exists for.** "Published version 7" stayed at the top
   * of the page while `UnpublishedChangesNotice` rendered directly below it
   * saying the storefront was serving something older — two contradictory
   * sentences, stacked, with the stale one first.
   */
  it('expires once something differs from the published version', () => {
    expect(publishResultIsCurrent(true, ['Finish: added Matte black'])).toBe(false);
  });

  /** Nothing differs, so the storefront really does match: the message holds. */
  it('keeps the confirmation while nothing has changed', () => {
    expect(publishResultIsCurrent(true, [])).toBe(true);
  });

  /**
   * ⚠️ **`undefined` is "not asked yet", not "something changed".** The diff is
   * a query, and it is `undefined` on every refetch — expiring on it would
   * blank the confirmation most of the time, including immediately after the
   * publish that produced it.
   */
  it('does not expire while the answer is still pending', () => {
    expect(publishResultIsCurrent(true, undefined)).toBe(true);
  });

  /** No result recorded renders nothing, whatever the diff says. */
  it('shows nothing when no publish has been attempted', () => {
    expect(publishResultIsCurrent(false, [])).toBe(false);
    expect(publishResultIsCurrent(false, undefined)).toBe(false);
    expect(publishResultIsCurrent(false, ['a change'])).toBe(false);
  });
});
