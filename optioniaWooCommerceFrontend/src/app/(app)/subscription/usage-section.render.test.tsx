import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PlanUsage } from '@/lib/billing/api';
import { UsageSection } from './page';

/**
 * M24.4's prompt, which is the half the server could not deliver.
 *
 * 🔴 **The backend shipped `usage[]` and the dashboard ignored it.** Found by
 * auditing my own commit: `grep` for `usage` in `src/lib/billing/api.ts`
 * returned nothing, so a downgraded merchant was refused on create and never
 * told what they were over on. M24.4 asks to *"prompt for explicit choices
 * about what to disable"* — and a prompt is a UI act.
 *
 * ⚠️ **Rendered rather than asserted on props.** The defect was that nothing
 * put these numbers on screen; a test reading the same object the component
 * reads would have passed throughout.
 */
describe('UsageSection', () => {
  function row(over: Partial<PlanUsage> = {}): PlanUsage {
    return {
      metric: 'option_sets',
      label: 'option sets',
      current: 1,
      limit: 10,
      overLimit: false,
      atLimit: false,
      ...over,
    };
  }

  /** 📌 Every metered metric, so "9 of 10" warns before it blocks. */
  it('shows usage against the limit before anything is breached', () => {
    const { container } = render(<UsageSection usage={[row({ current: 9 })]} />);

    expect(container.textContent).toContain('option sets');
    expect(container.textContent).toContain('9 of 10');
  });

  /**
   * 🔴 **The over-limit banner names the metric and the excess**, or "choose
   * what to disable" is unanswerable.
   */
  it('names how much to remove when the plan no longer covers it', () => {
    const { container } = render(
      <UsageSection usage={[row({ current: 12, limit: 10, overLimit: true })]} />,
    );

    expect(container.textContent).toContain('no longer covers');
    expect(container.textContent).toContain('2 option sets');
  });

  /**
   * ⚠️ **It reassures before it instructs.** ADR-116's principle is that a
   * merchant's storefront never goes dark, and a banner that omits this reads
   * as "your shop is broken".
   */
  it('says nothing was deleted and the storefront still works', () => {
    const { container } = render(
      <UsageSection usage={[row({ current: 12, limit: 10, overLimit: true })]} />,
    );

    expect(container.textContent).toContain('Nothing has been deleted');
    expect(container.textContent).toContain('storefront keeps working');
  });

  /**
   * 🔴 **It never offers to delete anything.** M24.4 forbids silent deletion,
   * and a button here removing the excess would be that with a dialog on top.
   */
  it('offers no destructive action', () => {
    const { container } = render(
      <UsageSection usage={[row({ current: 12, limit: 10, overLimit: true })]} />,
    );

    expect(container.querySelector('button')).toBeNull();
  });

  /**
   * 🔴 **`limit: null` is unlimited, never a ceiling of zero** — the same
   * inversion the server guards against, which would render the most
   * permissive plan as the most breached.
   */
  it('renders an unlimited metric as unlimited', () => {
    const { container } = render(
      <UsageSection usage={[row({ current: 3, limit: null })]} />,
    );

    expect(container.textContent).toContain('3 (unlimited)');
    expect(container.textContent).not.toContain('of 0');
  });

  /** 📌 No banner when nothing is breached — a quiet state must stay quiet. */
  it('shows no banner while the tenant is within its plan', () => {
    const { container } = render(<UsageSection usage={[row()]} />);

    expect(container.textContent).not.toContain('no longer covers');
  });

  /** ⚠️ A plan that meters nothing renders nothing, not an empty box. */
  it('renders nothing when the plan meters no metric', () => {
    const { container } = render(<UsageSection usage={[]} />);

    expect(container.textContent).toBe('');
  });
});
