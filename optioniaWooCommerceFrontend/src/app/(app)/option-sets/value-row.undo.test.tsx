import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoringValue } from '@/lib/option-sets/api';

vi.mock('@/lib/option-sets/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/option-sets/api')>(
    '@/lib/option-sets/api',
  );

  return { ...actual, updateValue: vi.fn() };
});

const { updateValue } = await import('@/lib/option-sets/api');
const { ValueRow } = await import('./[id]/page');

/**
 * What an edited value records for undo (M20.10).
 *
 * 🔴 **The inverse is the PREVIOUS field values, not a tree snapshot.** The
 * editor already holds them — they are what it rendered the form from — so the
 * entry costs five strings rather than a copy of a set that reaches 12,000
 * values at `AUTHORING_LIMITS` scale.
 */
const value = (): AuthoringValue => ({
  id: 'v1',
  valueKey: 'matte',
  label: 'Matte',
  sortOrder: 0,
  priceType: 'fixed',
  priceAmountMinor: 0,
  groupLabel: null,
  colorHex: null,
  imageUrl: null,
});

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const record = vi.fn();

  render(
    <QueryClientProvider client={client}>
      <div>
        <ValueRow
          value={value()}
          presentation="dropdown"
          canEdit
          onChanged={() => {}}
          onPatched={() => {}}
          onRecord={record}
        />
        <button type="button">outside</button>
      </div>
    </QueryClientProvider>,
  );

  return { record };
};

const save = () => {
  fireEvent.blur(document.querySelector('[data-value-row]') as HTMLElement, {
    relatedTarget: screen.getByText('outside'),
  });
};

beforeEach(() => {
  vi.mocked(updateValue).mockReset();
  vi.mocked(updateValue).mockResolvedValue({ ...value(), label: 'Satin' });
});

describe('ValueRow undo', () => {
  it('records an entry when an edit is saved', async () => {
    const { record } = mount();

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    save();

    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
  });

  /** ⚠️ Named for the merchant, not for the endpoint. */
  it('names the operation', async () => {
    const { record } = mount();

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    save();

    await waitFor(() => expect(record).toHaveBeenCalled());
    expect(record.mock.calls[0]?.[0]).toMatchObject({ label: expect.stringMatching(/Matte/) });
  });

  /** 🔴 The inverse must write the values the row held BEFORE the edit. */
  it('the inverse restores the previous label', async () => {
    const { record } = mount();

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    save();

    await waitFor(() => expect(record).toHaveBeenCalled());

    vi.mocked(updateValue).mockClear();
    await record.mock.calls[0][0].inverse();

    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ label: 'Matte' });
  });

  /** 🔴 Redo must re-apply the edit the merchant made. */
  it('the replay re-applies the new label', async () => {
    const { record } = mount();

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    save();

    await waitFor(() => expect(record).toHaveBeenCalled());

    vi.mocked(updateValue).mockClear();
    await record.mock.calls[0][0].replay();

    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ label: 'Satin' });
  });

  /** ⚠️ A refused save records nothing — there is nothing to undo. */
  it('records nothing when the save fails', async () => {
    vi.mocked(updateValue).mockRejectedValue(new Error('nope'));

    const { record } = mount();

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    save();

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(record).not.toHaveBeenCalled();
  });
});
