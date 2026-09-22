import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoringGroup } from '@/lib/option-sets/api';

vi.mock('@/lib/option-sets/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/option-sets/api')>(
    '@/lib/option-sets/api',
  );

  return { ...actual, updateOption: vi.fn() };
});

const { updateOption } = await import('@/lib/option-sets/api');
const { GroupList } = await import('./[id]/page');

/**
 * Option-level pricing in the editor (Phase 20 audit, F1 remainder).
 *
 * 🔴 **`per_char` and `per_unit` were chargeable and unauthorable.** A merchant
 * could not price an engraving by the character, though the storefront has
 * charged for one since M16.2 and the shared fixture proves it.
 */
const group = (presentation: string, pricing?: Record<string, unknown>): AuthoringGroup =>
  ({
    id: 'g1',
    label: 'Engraving',
    description: null,
    sortOrder: 0,
    isEnabled: true,
    displayType: 'inline',
    isCollapsible: false,
    options: [
      {
        id: 'o1',
        key: 'text',
        label: 'Engraving',
        presentation,
        isRequired: false,
        sortOrder: 0,
        isEnabled: true,
        pricing: pricing ?? null,
        values: [],
      },
    ],
    items: [],
  }) as never;

/**
 * 🔴 **Spies, not no-op stubs.** With `() => {}` these tests could assert only
 * that `updateOption` was *called*; deleting the `onSuccess` patch passed all
 * 1,236 tests (M293). A merchant saves a price, the server writes it, and the
 * form still shows the old one until a refresh.
 */
const mount = (presentation: string, pricing?: Record<string, unknown>) => {
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
        groups={[group(presentation, pricing)]}
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
  vi.mocked(updateOption).mockReset();
  vi.mocked(updateOption).mockResolvedValue({} as never);
});

describe('option-level pricing', () => {
  it('is offered on a text option', () => {
    mount('text_field');

    expect(screen.getByLabelText(/Price per character/i)).toBeTruthy();
  });

  it('is offered on a number option', () => {
    mount('number_field');

    expect(screen.getByLabelText(/Price per unit/i)).toBeTruthy();
  });

  /** 🔴 A choice option prices per value — offering this would fail on save. */
  it('is not offered on a choice option', () => {
    mount('dropdown');

    expect(screen.queryByLabelText(/Price per/i)).toBeNull();
  });

  /** ⚠️ The free allowance belongs to per_char alone. */
  it('offers a free allowance for a text option only', () => {
    mount('text_field');

    expect(screen.getByLabelText(/Free characters/i)).toBeTruthy();
  });

  it('offers no free allowance for a number option', () => {
    mount('number_field');

    expect(screen.queryByLabelText(/Free characters/i)).toBeNull();
  });

  /** 🔴 Sent in the STORED shape — camelCase, as `pricing.schema.ts` validates. */
  it('saves a per-character price', async () => {
    mount('text_field');

    fireEvent.change(screen.getByLabelText(/Price per character/i), { target: { value: '0.50' } });
    fireEvent.change(screen.getByLabelText(/Free characters/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save pricing/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      pricing: { type: 'per_char', amountMinor: 50, freeCharacters: 5 },
    });
  });

  /** ⚠️ A blank amount clears the price rather than failing. */
  it('clears the price when the amount is emptied', async () => {
    mount('text_field', { type: 'per_char', amountMinor: 50, freeCharacters: 0 });

    fireEvent.change(screen.getByLabelText(/Price per character/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save pricing/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({ pricing: null });
  });

  /** 📌 A stored price is shown, so editing starts from what is set. */
  it('shows a stored price', () => {
    mount('text_field', { type: 'per_char', amountMinor: 50, freeCharacters: 5 });

    expect((screen.getByLabelText(/Price per character/i) as HTMLInputElement).value).toBe('0.50');
    expect((screen.getByLabelText(/Free characters/i) as HTMLInputElement).value).toBe('5');
  });

  /** 🔴 A malformed amount is refused and explained, not sent. */
  it('refuses a malformed amount', async () => {
    mount('text_field');

    fireEvent.change(screen.getByLabelText(/Price per character/i), { target: { value: 'lots' } });
    fireEvent.click(screen.getByRole('button', { name: /Save pricing/i }));

    await waitFor(() => expect(screen.getByText(/Enter an amount/i)).toBeTruthy());
    expect(updateOption).not.toHaveBeenCalled();
  });

  /**
   * ✏️ **Superseded: a stored `tiered` is now EDITABLE.**
   *
   * This asserted the deliberate fence while the editor could only *name* a
   * bracket set — showing it as unpriced would have invited a merchant to
   * overwrite brackets they could not see. The bracket editor removed the
   * reason for the fence, so the assertion becomes its opposite: a stored set
   * is loaded into rows a merchant can change.
   */
  it('loads a stored tiered price into editable rows', () => {
    mount('number_field', {
      type: 'tiered',
      tiers: [{ minQuantity: 1, maxQuantity: null, amountMinor: 500 }],
    });

    expect((screen.getByLabelText(/From quantity 1/i) as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText(/Amount 1/i) as HTMLInputElement).value).toBe('5.00');
  });
});

/**
 * Quantity brackets (Phase 20 audit — the last pricing gap).
 *
 * 🔴 **Validated by the API's OWN schema, copied not restated.** Six of the
 * rules are about the set rather than a row — a gap, an overlap, an unbounded
 * bracket in the middle — and each is a wrong charge invisible from the row a
 * merchant is typing into.
 */
describe('tiered brackets', () => {
  it('offers tiered on a number option', () => {
    mount('number_field');

    expect(screen.getByLabelText(/Price type/i)).toBeTruthy();
  });

  it('is not offered on a text option', () => {
    mount('text_field');

    expect(screen.queryByLabelText(/Price type/i)).toBeNull();
  });

  it('shows bracket rows when tiered is chosen', () => {
    mount('number_field');

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'tiered' } });

    expect(screen.getByLabelText(/From quantity 1/i)).toBeTruthy();
  });

  it('saves a covering bracket set', async () => {
    mount('number_field');

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'tiered' } });
    fireEvent.change(screen.getByLabelText(/From quantity 1/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/To quantity 1/i), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText(/Amount 1/i), { target: { value: '5.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Add bracket/i }));
    fireEvent.change(screen.getByLabelText(/From quantity 2/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Amount 2/i), { target: { value: '4.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Save pricing/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      pricing: {
        type: 'tiered',
        tiers: [
          { minQuantity: 1, maxQuantity: 9, amountMinor: 500 },
          { minQuantity: 10, maxQuantity: null, amountMinor: 400 },
        ],
      },
    });
  });

  /** 🔴 A gap is refused with the API's own wording, and nothing is written. */
  it('refuses a gap between brackets', async () => {
    mount('number_field');

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'tiered' } });
    fireEvent.change(screen.getByLabelText(/From quantity 1/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/To quantity 1/i), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText(/Amount 1/i), { target: { value: '5.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Add bracket/i }));
    fireEvent.change(screen.getByLabelText(/From quantity 2/i), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText(/Amount 2/i), { target: { value: '4.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Save pricing/i }));

    await waitFor(() => expect(screen.getByText(/fall between/i)).toBeTruthy());
    expect(updateOption).not.toHaveBeenCalled();
  });

  /** 📌 Stored brackets are shown, so a set can now be EDITED, not just named. */
  it('shows stored brackets', () => {
    mount('number_field', {
      type: 'tiered',
      tiers: [
        { minQuantity: 1, maxQuantity: 9, amountMinor: 500 },
        { minQuantity: 10, maxQuantity: null, amountMinor: 400 },
      ],
    });

    expect((screen.getByLabelText(/From quantity 2/i) as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText(/To quantity 2/i) as HTMLInputElement).value).toBe('');
  });

  it('removes a bracket', () => {
    mount('number_field', {
      type: 'tiered',
      tiers: [
        { minQuantity: 1, maxQuantity: 9, amountMinor: 500 },
        { minQuantity: 10, maxQuantity: null, amountMinor: 400 },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Remove bracket/i })[1] as HTMLElement);

    expect(screen.queryByLabelText(/From quantity 2/i)).toBeNull();
  });
});


/**
 * 🔴 **The saved price must reach the screen** (M293).
 *
 * The dashboard patches rather than refetching, so the patch callback IS the
 * update — there is no refetch behind it to cover a missing one.
 */
describe('saving option pricing puts the answer back on screen', () => {
  it('patches the cached option', async () => {
    const updated = { id: 'o1', pricing: { type: 'per_char', amountMinor: 50 } } as never;

    vi.mocked(updateOption).mockResolvedValue(updated);

    const { patch } = mount('text_field');

    fireEvent.change(screen.getByLabelText(/Price per character/i), { target: { value: '0.50' } });
    fireEvent.click(screen.getByRole('button', { name: /Save pricing/i }));

    await waitFor(() => expect(patch.option).toHaveBeenCalledTimes(1));

    /* The FIRST argument — React Query passes three to `onSuccess`. */
    expect(patch.option.mock.calls[0]?.[0]).toBe(updated);
  });
});
