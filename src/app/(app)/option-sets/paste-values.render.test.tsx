import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoringGroup } from '@/lib/option-sets/api';

vi.mock('@/lib/option-sets/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/option-sets/api')>(
    '@/lib/option-sets/api',
  );

  return { ...actual, createValue: vi.fn() };
});

const { createValue } = await import('@/lib/option-sets/api');
const { GroupList } = await import('./[id]/page');

/**
 * Bulk paste, as a merchant meets it (M20.4).
 *
 * 🔴 **The refusal path matters more than the happy one.** A paste that breaks
 * a limit the API enforces per-create would otherwise write values partway and
 * stop — and a create clears the undo log, so there is no way back.
 */
const group = (values: { id: string; valueKey: string; label: string }[]): AuthoringGroup =>
  ({
    id: 'g1',
    label: 'Size',
    description: null,
    sortOrder: 0,
    isEnabled: true,
    displayType: 'inline',
    isCollapsible: false,
    options: [
      {
        id: 'o1',
        optionKey: 'size',
        label: 'Size',
        presentation: 'dropdown',
        isRequired: false,
        sortOrder: 0,
        isEnabled: true,
        helpText: null,
        values: values.map((value, index) => ({
          ...value,
          sortOrder: index,
          priceType: 'fixed',
          priceAmountMinor: 0,
        })),
      },
    ],
    items: [],
  }) as never;

const mount = (values: { id: string; valueKey: string; label: string }[] = []) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GroupList
        setId="s1"
        groups={[group(values)]}
        canEdit
        onChanged={() => {}}
        onReordered={() => {}}
        patch={{
          option: () => {},
          value: () => {},
          group: () => {},
          item: () => {},
          record: () => {},
        }}
      />
    </QueryClientProvider>,
  );

const paste = (text: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Paste a list' }));
  fireEvent.change(screen.getByLabelText(/One value per line/), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Add values' }));
};

beforeEach(() => {
  vi.mocked(createValue).mockReset();
  vi.mocked(createValue).mockResolvedValue({} as never);
});

describe('PasteValues', () => {
  it('is offered on an option that takes values', () => {
    mount();

    expect(screen.getByRole('button', { name: 'Paste a list' })).toBeTruthy();
  });

  it('creates one value per line', async () => {
    mount();
    paste('Small,1.50\nMedium,2.50');

    await waitFor(() => expect(createValue).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createValue).mock.calls[0]?.[1]).toMatchObject({
      label: 'Small',
      valueKey: 'small',
      priceAmountMinor: 150,
    });
  });

  /** 🔴 **Nothing is written when any line is bad.** */
  it('writes nothing when a price is malformed', async () => {
    mount();
    paste('Small,1.50\nMedium,ten pounds');

    await waitFor(() => expect(screen.getByText(/Line 2/)).toBeTruthy());
    expect(createValue).not.toHaveBeenCalled();
  });

  /** ⚠️ A key the option already holds is refused before any request. */
  it('writes nothing when a value already exists', async () => {
    mount([{ id: 'v1', valueKey: 'small', label: 'Small' }]);
    paste('Small');

    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy());
    expect(createValue).not.toHaveBeenCalled();
  });

  /** 📌 Every bad line is named at once, not one per attempt. */
  it('reports every bad line together', async () => {
    mount();
    paste('Small,abc\nMedium,def');

    await waitFor(() => expect(screen.getByText(/Line 1/)).toBeTruthy());
    expect(screen.getByText(/Line 2/)).toBeTruthy();
  });
});
