import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoringGroup } from '@/lib/option-sets/api';

vi.mock('@/lib/option-sets/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/option-sets/api')>(
    '@/lib/option-sets/api',
  );

  return {
    ...actual,
    updateGroup: vi.fn(),
    updateOption: vi.fn(),
    updateValue: vi.fn(),
  };
});

const { updateGroup, updateOption, updateValue } = await import('@/lib/option-sets/api');
const { GroupList } = await import('./[id]/page');

/**
 * Taking something off sale without deleting it (Phase 20 audit, F1).
 *
 * 🔴 **The reversible mechanism existed at every level and was reachable at
 * one.** The API accepts `isEnabled` on groups, options and values, and the
 * serializer filters disabled ones at publish — all four `.filter()` calls are
 * there. Only **rules** had a toggle in the editor.
 *
 * ⚠️ **So a merchant taking one colour off sale for a fortnight had to DELETE
 * it** — and a delete is a shape change that clears the undo log, with no
 * restore endpoint. The destructive path was available and the reversible one
 * was not.
 *
 * 📌 **Disabling does not cascade**, unlike deleting: it is a flag the publish
 * serializer reads, and the publish checks already skip disabled entities — so
 * a disabled group raises no findings about its own options.
 */
const group = (over: Record<string, unknown> = {}): AuthoringGroup =>
  ({
    id: 'g1',
    label: 'Finish',
    description: null,
    sortOrder: 0,
    isEnabled: true,
    displayType: 'inline',
    isCollapsible: false,
    options: [
      {
        id: 'o1',
        key: 'colour',
        label: 'Colour',
        presentation: 'dropdown',
        isRequired: false,
        sortOrder: 0,
        isEnabled: true,
        values: [
          {
            id: 'v1',
            valueKey: 'gold',
            label: 'Gold',
            sortOrder: 0,
            priceType: 'fixed',
            priceAmountMinor: 0,
            isEnabled: true,
          },
        ],
      },
    ],
    items: [],
    ...over,
  }) as never;

/**
 * 🔴 **Spies, not no-op stubs — and that distinction is the point.**
 *
 * These were `() => {}`, so the tests could assert only that the API was
 * *called*. Measured: deleting the `onSuccess` patch from any of the three
 * toggles passed all 1,236 tests (M290-M292). A merchant clicks Disable, the
 * server writes it, and **the screen does not change** until a refresh.
 *
 * ⚠️ **Verifying the request is not verifying the answer arrived.** The patch is
 * what puts the server's response back on screen; a test that never observes it
 * is testing half the operation.
 */
const mount = (over: Record<string, unknown> = {}) => {
  const patch = {
    option: vi.fn(),
    value: vi.fn(),
    group: vi.fn(),
    item: vi.fn(),
    record: vi.fn(),
  };

  const result = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GroupList
        setId="s1"
        groups={[group(over)]}
        canEdit
        onChanged={() => {}}
        onReordered={() => {}}
        patch={patch}
      />
    </QueryClientProvider>,
  );

  return { ...result, patch };
};

beforeEach(() => {
  [updateGroup, updateOption, updateValue].forEach((fn) => {
    vi.mocked(fn).mockReset();
    vi.mocked(fn).mockResolvedValue({} as never);
  });
});

describe('enable and disable', () => {
  it('offers a group toggle', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Disable group/i }));

    await waitFor(() => expect(updateGroup).toHaveBeenCalled());
    expect(vi.mocked(updateGroup).mock.calls[0]?.[1]).toMatchObject({ isEnabled: false });
  });

  it('offers an option toggle', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Disable Colour/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({ isEnabled: false });
  });

  it('offers a value toggle', async () => {
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Disable Gold/i }));

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ isEnabled: false });
  });

  /** 🔴 Reversible is the whole point — a disabled thing must re-enable. */
  it('re-enables a disabled group', async () => {
    mount({ isEnabled: false });

    fireEvent.click(screen.getByRole('button', { name: /Enable group/i }));

    await waitFor(() => expect(updateGroup).toHaveBeenCalled());
    expect(vi.mocked(updateGroup).mock.calls[0]?.[1]).toMatchObject({ isEnabled: true });
  });

  /**
   * ⚠️ **A disabled thing must LOOK disabled**, or a merchant cannot tell why
   * their option is missing from the storefront.
   */
  it('marks a disabled group', () => {
    mount({ isEnabled: false });

    expect(screen.getByText(/disabled/i)).toBeTruthy();
  });
});


/**
 * 🔴 **The server's answer must reach the screen**, not merely be requested.
 *
 * Each of these kills a mutant that survived every one of the 1,236 tests: the
 * toggles patched the cache, nothing asserted it, and deleting the patch left a
 * merchant looking at a control that had already changed on the server.
 *
 * 📌 **The dashboard patches rather than refetching** (M20.10's groundwork), so
 * the patch callback IS the update — there is no refetch behind it to hide a
 * missing one.
 */
describe('a toggle puts the server’s answer back on screen', () => {
  const updated = { id: 'x', isEnabled: false } as never;

  it('patches the cached group (M291)', async () => {
    vi.mocked(updateGroup).mockResolvedValue(updated);

    const { patch } = mount();

    fireEvent.click(screen.getByRole('button', { name: /Disable group/i }));

    await waitFor(() => expect(patch.group).toHaveBeenCalledTimes(1));

    /* ⚠️ The FIRST argument: React Query hands `onSuccess` three (data,
     * variables, context), so `toHaveBeenCalledWith(updated)` fails on the
     * two `undefined`s that follow — the assertion being strict about a
     * signature rather than about the value. */
    expect(patch.group.mock.calls[0]?.[0]).toBe(updated);
  });

  it('patches the cached option (M290)', async () => {
    vi.mocked(updateOption).mockResolvedValue(updated);

    const { patch } = mount();

    fireEvent.click(screen.getByRole('button', { name: /Disable Colour/i }));

    await waitFor(() => expect(patch.option).toHaveBeenCalledTimes(1));
    expect(patch.option.mock.calls[0]?.[0]).toBe(updated);
  });

  /**
   * ⚠️ **A value patches through `onPatched`, not `patch.value`.** `ValueRow`
   * takes the callback as its own prop — the same function, one layer down — so
   * this asserts the spy the row was handed.
   */
  it('patches the cached value (M292)', async () => {
    vi.mocked(updateValue).mockResolvedValue(updated);

    const { patch } = mount();

    fireEvent.click(screen.getByRole('button', { name: /Disable Gold/i }));

    await waitFor(() => expect(patch.value).toHaveBeenCalledTimes(1));
    expect(patch.value.mock.calls[0]?.[0]).toBe(updated);
  });
});
