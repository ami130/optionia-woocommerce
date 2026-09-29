import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalyticsSummary } from '@/lib/analytics/api';
import { downloadAnalyticsCsv } from '@/lib/analytics/api';
import { ApiError } from '@/lib/api/error';
import { Summary } from './page';

vi.mock('@/lib/analytics/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/analytics/api')>('@/lib/analytics/api');

  return { ...actual, downloadAnalyticsCsv: vi.fn() };
});

/**
 * What the export button does when the export fails (F167).
 *
 * 🔴 **`summary.render.test.tsx` proves the button is PRESENT, and nothing
 * proved it WORKS.** Its two export assertions read `container.textContent` for
 * the words "Export CSV" — which a `<Button>` rendering nothing but a label
 * would satisfy. The click handler, the plan refusal it is meant to surface and
 * the object URL it must release were all unexercised.
 *
 * ⚠️ **The failure path specifically, because that is the one a merchant hits
 * without warning.** A Free merchant pressing Export gets a `403` naming the
 * plan that includes exports; if that sentence is swallowed the button appears
 * to do nothing at all, which reads as a broken dashboard rather than as a
 * plan boundary. The success path ends in a browser download that jsdom cannot
 * observe — `link.click()` on a detached anchor is a no-op there — so what is
 * asserted below is the state this component actually owns.
 */
describe('Analytics export button', () => {
  const mocked = vi.mocked(downloadAnalyticsCsv);

  /*
   * ⚠️ **jsdom implements neither `createObjectURL` nor `revokeObjectURL`**, so
   * the two tests that exercise the success path assign them. Vitest gives each
   * file its own environment, so that cannot reach another file today — but the
   * originals are captured and restored anyway, because "isolated by default"
   * is a setting someone can change, and a global left overwritten is the same
   * shape of defect as the test-database leak this repository has just fixed.
   */
  const originals = {
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  };

  beforeEach(() => {
    mocked.mockReset();
  });

  afterEach(() => {
    URL.createObjectURL = originals.create;
    URL.revokeObjectURL = originals.revoke;
  });

  /* A shop with orders, so the populated screen — and the button — renders. */
  const data = (): AnalyticsSummary => ({
    attach: {
      orders: 10,
      ordersWithOptions: 8,
      rate: 0.8,
      optionRevenueMinor: 12_000,
      totalRevenueMinor: 90_000,
      averageOrderValueWithOptionsMinor: 9_000,
      averageOrderValueWithoutOptionsMinor: 4_000,
    },
    topOptions: { rows: [], total: 0, truncated: false },
    topValues: { rows: [], total: 0, truncated: false },
    leastValues: { rows: [], total: 0, truncated: false },
    deadOptions: { rows: [], total: 0, truncated: false },
    trend: {
      windowDays: 30,
      currentMinor: 9_900,
      previousMinor: 6_600,
      currentOrders: 4,
      previousOrders: 3,
      changeFraction: 0.5,
    },
    products: {
      rows: [{ productRef: '42', name: 'Engraved Mug', revenueMinor: 9_900, orders: 4 }],
      total: 1,
      truncated: false,
    },
    unattributedProductSelections: 0,
    optionSets: { rows: [], total: 0, truncated: false },
    unattributedSelections: 0,
    currency: 'GBP',
  });

  const press = () => fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

  /**
   * 🔴 **The click reaches the API at all.** Everything else in this file is
   * about what happens afterwards; if this fails the button is decoration.
   */
  it('asks for the file when the merchant presses it', async () => {
    mocked.mockResolvedValue({ blob: new Blob(['a,b']), filename: 'x.csv' });

    render(<Summary data={data()} />);
    press();

    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
  });

  /**
   * 🔴 **A plan refusal is shown, in the API's own words.** The export is gated
   * by `PlanFeatureGuard`, which answers `403 PLAN_FEATURE_UNAVAILABLE` with a
   * sentence naming the plan that includes it. Dropping that sentence leaves a
   * merchant pressing a button that silently does nothing.
   */
  it('shows the refusal when the plan does not include exports', async () => {
    mocked.mockRejectedValue(
      new ApiError(403, {
        code: 'PLAN_FEATURE_UNAVAILABLE',
        message: 'Exports are included on the Pro plan.',
      }),
    );

    render(<Summary data={data()} />);
    press();

    await waitFor(() =>
      expect(screen.getByText('Exports are included on the Pro plan.')).toBeDefined(),
    );
  });

  /**
   * ⚠️ **A failure with no sentence still says something.** A network drop
   * throws a `NetworkError` whose message is about reaching the server, and a
   * non-`Error` rejection has no message at all — neither may leave the screen
   * unchanged.
   */
  it('falls back to its own wording when the failure carries none', async () => {
    mocked.mockRejectedValue('nope');

    render(<Summary data={data()} />);
    press();

    await waitFor(() =>
      expect(screen.getByText('The export could not be produced.')).toBeDefined(),
    );
  });

  /**
   * 🔴 **The button comes back.** `busy` is set before the request and cleared
   * in a `finally`; clearing it only on success would leave a merchant who hit
   * one refusal with a permanently disabled button and no way to retry after
   * upgrading.
   */
  it('re-enables itself after a failure so the merchant can try again', async () => {
    mocked.mockRejectedValue(new Error('boom'));

    render(<Summary data={data()} />);

    const button = screen.getByRole('button', { name: /export csv/i });

    press();

    await waitFor(() => expect(screen.getByText('boom')).toBeDefined());

    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * 📌 **A stale refusal is cleared when the merchant retries.** Upgrading and
   * pressing again must not leave the previous plan message sitting under a
   * button that has just succeeded.
   */
  it('clears an earlier failure on the next attempt', async () => {
    mocked.mockRejectedValueOnce(new Error('first failure'));

    render(<Summary data={data()} />);
    press();

    await waitFor(() => expect(screen.getByText('first failure')).toBeDefined());

    mocked.mockResolvedValue({ blob: new Blob(['a,b']), filename: 'x.csv' });
    press();

    await waitFor(() => expect(screen.queryByText('first failure')).toBeNull());
  });

  /**
   * 🔴 **The object URL is released.** It holds the whole blob in memory until
   * revoked, so a merchant exporting repeatedly over a large catalogue would
   * accumulate every copy for the life of the tab. jsdom implements neither
   * `createObjectURL` nor `revokeObjectURL`, so both are stubbed — which is
   * also what lets the success path run at all.
   */
  it('releases the object URL it created', async () => {
    const create = vi.fn().mockReturnValue('blob:x');
    const revoke = vi.fn();

    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;

    mocked.mockResolvedValue({ blob: new Blob(['a,b']), filename: 'x.csv' });

    render(<Summary data={data()} />);
    press();

    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:x'));
  });

  /**
   * ⚠️ **And nothing is revoked when nothing was created.** The `finally` runs
   * on the failure path too, where `url` is still null — passing that to
   * `revokeObjectURL` would throw inside the error handler and replace the
   * merchant's refusal message with a crash.
   */
  it('revokes nothing when the request failed before a URL existed', async () => {
    const revoke = vi.fn();

    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = revoke;

    mocked.mockRejectedValue(new Error('boom'));

    render(<Summary data={data()} />);
    press();

    await waitFor(() => expect(screen.getByText('boom')).toBeDefined());

    expect(revoke).not.toHaveBeenCalled();
  });
});
