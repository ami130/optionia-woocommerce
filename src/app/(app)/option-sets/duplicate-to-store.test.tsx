import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OptionSetSummary } from '@/lib/option-sets/api';
import type { StoreSummary } from '@/lib/stores/api';

vi.mock('@/lib/option-sets/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/option-sets/api')>(
    '@/lib/option-sets/api',
  );

  return { ...actual, duplicateSet: vi.fn() };
});

const { duplicateSet } = await import('@/lib/option-sets/api');
const { SetRow } = await import('./page');

/**
 * Copying a set into another store (M20.8) — [D5]'s multi-store differentiator.
 *
 * 🔴 **Offered only when there IS another store.** A merchant with one
 * storefront has no choice to make, and a picker listing exactly one option is
 * a question with one answer — noise on the screen for everyone who is not
 * running several shops.
 */
const set = (): OptionSetSummary =>
  ({
    id: 's1',
    storeId: 'store-1',
    name: 'Finish',
    status: 'draft',
    version: 0,
    rowVersion: 1,
    publishedAt: null,
    publishedConfigVersion: 0,
  }) as OptionSetSummary;

const store = (id: string, url: string): StoreSummary =>
  ({ id, name: url, storeUrl: url, status: 'connected' }) as StoreSummary;

const mount = (stores: StoreSummary[]) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SetRow set={set()} stores={stores} canEdit canDelete onChanged={() => {}} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(duplicateSet).mockReset();
  vi.mocked(duplicateSet).mockResolvedValue(set());
});

describe('duplicate into another store', () => {
  it('duplicates in place when there is only one store', async () => {
    mount([store('store-1', 'https://a.example.com')]);

    fireEvent.click(screen.getByRole('button', { name: /Duplicate/ }));

    await waitFor(() => expect(duplicateSet).toHaveBeenCalled());
    expect(vi.mocked(duplicateSet).mock.calls[0]?.[2]).toBeUndefined();
  });

  it('offers no store picker with one store', () => {
    mount([store('store-1', 'https://a.example.com')]);

    expect(screen.queryByLabelText(/Copy to/i)).toBeNull();
  });

  /** 🔴 With a second store, the merchant chooses where the copy lands. */
  it('offers the other stores as targets', () => {
    mount([
      store('store-1', 'https://a.example.com'),
      store('store-2', 'https://b.example.com'),
    ]);

    expect(screen.getByLabelText(/Copy to/i)).toBeTruthy();
  });

  /** ⚠️ The set's own store is not offered — that is the plain Duplicate. */
  it('does not offer the set’s own store as a target', () => {
    mount([
      store('store-1', 'https://a.example.com'),
      store('store-2', 'https://b.example.com'),
    ]);

    const options = [...(screen.getByLabelText(/Copy to/i) as HTMLSelectElement).options];

    expect(options.map((option) => option.value)).not.toContain('store-1');
  });

  it('sends the chosen store', async () => {
    mount([
      store('store-1', 'https://a.example.com'),
      store('store-2', 'https://b.example.com'),
    ]);

    fireEvent.change(screen.getByLabelText(/Copy to/i), { target: { value: 'store-2' } });
    fireEvent.click(screen.getByRole('button', { name: /Copy to store/i }));

    await waitFor(() => expect(duplicateSet).toHaveBeenCalled());
    expect(vi.mocked(duplicateSet).mock.calls[0]?.[2]).toBe('store-2');
  });
});
