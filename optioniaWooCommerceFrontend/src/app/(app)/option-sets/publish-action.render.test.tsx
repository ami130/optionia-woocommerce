import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoringSet, PublishFinding } from '@/lib/option-sets/api';
import { loadSetVersion, publishCheck, publishSet } from '@/lib/option-sets/api';
import { PublishAction } from './[id]/page';

vi.mock('@/lib/option-sets/api', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/option-sets/api')>('@/lib/option-sets/api');

  return {
    ...actual,
    publishCheck: vi.fn(),
    publishSet: vi.fn(),
    loadSetVersion: vi.fn(),
  };
});

/**
 * The control that decides whether a merchant can ship, rendered.
 *
 * 🔴 **It had no render coverage at all, and the gate it guards shipped
 * unreachable.** `publishGate` is now a pure module with its own tests, and
 * `editor-contracts` asserts the button consults it — but both read *source*.
 * Neither can see that the button renders, that it is disabled when the gate
 * says blocked, or that clicking it reaches the API. Measured before this
 * file: deleting `blocked` from the `disabled` expression left the suite green
 * except for an unrelated write-inventory check that fired **incidentally**,
 * because the mutation left `isLoading` unused.
 *
 * ⚠️ **This is the boundary `editor-contracts` names.** Source-reading proves a
 * call is wired, never that it is reachable. This file is the other half.
 */
const set = (): AuthoringSet =>
  ({
    id: 'set-1',
    name: 'Hoodie options',
    status: 'published',
    version: 3,
    rowVersion: 9,
    storeId: 'store-1',
    groups: [],
    rules: [],
  }) as unknown as AuthoringSet;

const finding = (severity: PublishFinding['severity']): PublishFinding => ({
  severity,
  code: 'no-values',
  subject: 'option:1',
  message: 'Finish has no values',
});

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <PublishAction set={set()} onPublished={() => {}} onResult={() => {}} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.mocked(publishCheck).mockReset();
  vi.mocked(publishSet).mockReset();
  vi.mocked(loadSetVersion).mockReset();
  vi.mocked(loadSetVersion).mockResolvedValue(9);
  vi.mocked(publishSet).mockResolvedValue({
    version: 4,
    publishedAt: '2026-09-23T00:00:00.000Z',
    configVersion: 12,
    warnings: [],
  });
});

describe('PublishAction', () => {
  /** A clean set ships: the button is there, and it is usable. */
  it('offers an enabled button when nothing blocks', async () => {
    vi.mocked(publishCheck).mockResolvedValue([]);
    mount();

    const button = await screen.findByRole('button', { name: 'Publish' });

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  /**
   * 🔴 **The defect worth the most.** A button that publishes past its own
   * blockers ships a broken option set to a live storefront.
   */
  it('disables the button while a blocker stands', async () => {
    vi.mocked(publishCheck).mockResolvedValue([finding('blocker')]);
    mount();

    const button = await screen.findByRole('button', { name: 'Publish' });

    /*
     * 🔴 **Waited for the SETTLED state, not for `disabled` to be true.** The
     * first draft did the latter and **survived** the mutation that removes
     * `blocked` from the expression: the button is also disabled while
     * `isLoading`, so `waitFor` saw that first moment and returned satisfied —
     * a test that asserted the loading spinner and called it a safety gate.
     *
     * Waiting for the summary proves the check has answered; only then is
     * `disabled` a statement about the gate rather than about the network.
     */
    await screen.findByText('1 thing to fix');

    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * ⚠️ **A warning must NOT block.** Trapping a merchant behind advice they
   * have read and accepted is a different failure, not a safer one.
   */
  it('publishes despite a warning', async () => {
    vi.mocked(publishCheck).mockResolvedValue([finding('warning')]);
    mount();

    const button = await screen.findByRole('button', { name: 'Publish' });

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  /**
   * 📌 **A disabled control that does not say why is a dead end.** The findings
   * themselves render in the panel further down the page, so without a count
   * the merchant's question has no answer in view.
   */
  it('says how many things must be fixed', async () => {
    vi.mocked(publishCheck).mockResolvedValue([finding('blocker'), finding('blocker')]);
    mount();

    expect(await screen.findByText('2 things to fix')).toBeTruthy();
  });

  it('counts a single blocker in the singular', async () => {
    vi.mocked(publishCheck).mockResolvedValue([finding('blocker')]);
    mount();

    expect(await screen.findByText('1 thing to fix')).toBeTruthy();
  });

  /**
   * 🔴 **Reachability, which no source contract can see.** The click must
   * arrive at the API with the refetched lock token — not `set.rowVersion`,
   * which goes stale the moment an edit is patched rather than refetched.
   */
  it('publishes with the refetched lock token when clicked', async () => {
    vi.mocked(publishCheck).mockResolvedValue([]);
    vi.mocked(loadSetVersion).mockResolvedValue(11);
    mount();

    const button = await screen.findByRole('button', { name: 'Publish' });

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(publishSet).toHaveBeenCalledWith('set-1', 11));
  });

  /** The outcome goes to the page, which has the width to render a sentence. */
  it('reports its result upward rather than rendering it in the header', async () => {
    vi.mocked(publishCheck).mockResolvedValue([]);
    const onResult = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <PublishAction set={set()} onPublished={() => {}} onResult={onResult} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole('button', { name: 'Publish' });

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(onResult).toHaveBeenCalled());
  });
});
