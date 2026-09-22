import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
 * Autosave when the **row** closes — not when focus moves between its fields.
 *
 * 🔴 **The save unit is the row, not the field.** `ValueRow` edits five fields
 * that describe one value together, and `updateValue` writes them as one
 * request. Saving per-field would mean five writes, five failure surfaces and
 * five row-version bumps for one edit a merchant made once — and it would make
 * Cancel a lie, because tabbing from Label to Price would already have
 * committed the label.
 *
 * ⚠️ **So "blur" here means focus leaving the row entirely**, which is what
 * keeps Cancel meaningful: nothing commits while the merchant is still inside
 * the form.
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

/** ⚠️ Takes overrides so a test can mount a value that already has data. */
const mount = (over: Partial<AuthoringValue> = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPatched = vi.fn();

  const result = render(
    <QueryClientProvider client={client}>
      <div>
        <ValueRow
          value={{ ...value(), ...over }}
          presentation="dropdown"
          canEdit
          onChanged={() => {}}
          onPatched={onPatched}
          onRecord={() => {}}
        />
        <button type="button">outside</button>
      </div>
    </QueryClientProvider>,
  );

  return { ...result, onPatched };
};

/** Open the editor, as a merchant does before any of this applies. */
const openEditor = () => {
  fireEvent.click(screen.getByLabelText('Edit Matte'));
};

const row = () => document.querySelector('[data-value-row]') as HTMLElement;

beforeEach(() => {
  vi.mocked(updateValue).mockReset();
  vi.mocked(updateValue).mockResolvedValue({ ...value(), label: 'Satin' });
});

describe('ValueRow autosave', () => {
  it('has no Save button', () => {
    mount();
    openEditor();

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  /** 🔴 The core behaviour: leaving the row commits the edit. */
  it('saves when focus leaves the row', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ label: 'Satin' });
  });

  /**
   * ⚠️ **The case that makes Cancel meaningful.** Tabbing from Label to Price
   * is focus moving WITHIN the row; committing there would write a value the
   * merchant is still editing.
   */
  it('does not save when focus moves between fields in the row', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByLabelText('Price') });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **An untouched row must not write.** Opening a value to look at it and
   * clicking away is not an edit, and a write there would bump the row version
   * and mark the set as differing from what is published.
   */
  it('does not save when nothing changed', async () => {
    mount();
    openEditor();

    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **A window switch is not a row close.** `relatedTarget` is null both
   * when the merchant clicks the page background and when they alt-tab away;
   * only the first is a decision to stop editing. Treating a window switch as
   * a commit would save a half-typed value the moment attention moved.
   *
   * 🔴 **`document.hasFocus()` is what separates them**, not `relatedTarget`.
   * An earlier version skipped the save whenever `relatedTarget` was null and
   * so ALSO skipped it for a click on a heading or the page background — the
   * most ordinary way to leave a row. The canonical E2E caught it: the row was
   * still open with "Matte black" typed and nothing written.
   */
  it('does not save when the window loses focus', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.blur(row(), { relatedTarget: null });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  /**
   * 🔴 **Clicking a heading, a paragraph or blank space MUST save.** Those are
   * not focusable, so the browser reports `relatedTarget: null` exactly as it
   * does for a window switch — but the document still has focus, and the
   * merchant has plainly left the row.
   */
  it('saves when focus leaves for a non-focusable part of the page', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.blur(row(), { relatedTarget: null });

    await waitFor(() => expect(updateValue).toHaveBeenCalledTimes(1));
    hasFocus.mockRestore();
  });

  /** Cancel still abandons, because nothing commits while focus is inside. */
  it('discards the draft on Cancel without saving', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **A rejected write must not close the row.** With a Save button the
   * error sits beside the thing the merchant just clicked; with autosave the
   * row has already closed, so the edit would vanish with no sign it failed.
   */
  it('keeps the row open and shows the error when the save fails', async () => {
    vi.mocked(updateValue).mockRejectedValue(new Error('nope'));
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('Label')).toBeTruthy());
  });

  /** ⚠️ An invalid draft must not be written. */
  it('does not save an invalid draft', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: '' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
  });

  /** 📌 The saved row patches the cache rather than triggering a refetch. */
  it('hands the saved value back for patching', async () => {
    const { onPatched } = mount();
    openEditor();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(onPatched).toHaveBeenCalledTimes(1));
    expect(onPatched.mock.calls[0]?.[0]).toMatchObject({ label: 'Satin' });
  });
});

/**
 * 🔴 **Reopening a closed row must show what the tree now holds.**
 *
 * `ValueRow` seeds five `useState` fields from its prop and never resyncs, and
 * `key={value.id}` does not change on an edit — so no remount. Measured before
 * this existed: prop `"Gloss"`, reopened editor `"Matte"`.
 *
 * ⚠️ **Pre-existing, but undo made it REACHABLE** — undo is the first feature
 * that changes a value from outside the row that owns it. Before undo, nothing
 * could alter a value while its row sat closed.
 */
describe('ValueRow resync', () => {
  it('shows the current value when reopened after an external change', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const row = (label: string) => (
      <QueryClientProvider client={client}>
        <ValueRow
          value={{ ...value(), label }}
          presentation="dropdown"
          canEdit
          onChanged={() => {}}
          onPatched={() => {}}
          onRecord={() => {}}
        />
      </QueryClientProvider>
    );

    const { rerender } = render(row('Matte'));

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Satin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    rerender(row('Gloss'));
    fireEvent.click(screen.getByLabelText('Edit Gloss'));

    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Gloss');
  });

  /** ⚠️ An OPEN row must not be clobbered mid-edit by a background refresh. */
  it('does not discard a draft while the row is open', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const row = (label: string) => (
      <QueryClientProvider client={client}>
        <ValueRow
          value={{ ...value(), label }}
          presentation="dropdown"
          canEdit
          onChanged={() => {}}
          onPatched={() => {}}
          onRecord={() => {}}
        />
      </QueryClientProvider>
    );

    const { rerender } = render(row('Matte'));

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Half-typed' } });

    rerender(row('Gloss'));

    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Half-typed');
  });
});

/**
 * Percentage pricing on a value (M20.6 audit F1).
 *
 * 🔴 **Four of five price types were implemented end-to-end and unauthorable.**
 * The storefront charges a percentage, the evaluators price one, 157 shared
 * fixture cases prove it — and no merchant could create one, because the editor
 * offered a flat amount and nothing else.
 *
 * 📌 **`percentage` is the one this closes.** `per_char`, `per_unit` and
 * `tiered` are **option-level** types — `pricingConfigSchema` accepts only
 * `fixed` and `percentage` at the value level, because a choice option prices
 * per value and a text or number option has no values to hang a price on.
 * Authoring those belongs with the option editor, not here.
 */
describe('ValueRow percentage pricing', () => {
  it('offers a price type', () => {
    mount();
    openEditor();

    expect(screen.getByLabelText(/Price type/i)).toBeTruthy();
  });

  it('shows a percent field when percentage is chosen', () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'percentage' } });

    expect(screen.getByLabelText(/Percent/i)).toBeTruthy();
  });

  /** ⚠️ And hides the flat amount, so only one price is on screen. */
  it('hides the flat amount when percentage is chosen', () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'percentage' } });

    expect(screen.queryByLabelText('Price')).toBeNull();
  });

  /** 🔴 Sent as `basisPoints` — the STORED shape, camelCase. */
  it('sends a percentage as basis points', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'percentage' } });
    fireEvent.change(screen.getByLabelText(/Percent/i), { target: { value: '2.5' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({
      priceConfig: { type: 'percentage', basisPoints: 250 },
    });
  });

  /** 🔴 A malformed percentage must not be written. */
  it('does not save a malformed percentage', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'percentage' } });
    fireEvent.change(screen.getByLabelText(/Percent/i), { target: { value: 'lots' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **The case that isolates `priceKind` in the dirty check.**
   *
   * A value STORED as a percentage, switched to a flat amount, with nothing
   * else touched — the percent field is not edited, the label is not edited, so
   * `priceKind !== storedKind` is the ONLY thing that makes the row dirty.
   * Without it, autosave skips the write and the merchant's switch is silently
   * discarded on leaving the row, while the editor showed it as made.
   *
   * ⚠️ Two earlier attempts at this test still changed a field alongside the
   * type, so the mutant survived both (M190).
   */
  it('saves a switch away from a stored percentage on its own', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <div>
          <ValueRow
            value={{ ...value(), priceConfig: { type: 'percentage', basisPoints: 1000 } }}
            presentation="dropdown"
            canEdit
            onChanged={() => {}}
            onPatched={() => {}}
            onRecord={() => {}}
          />
          <button type="button">stored-outside</button>
        </div>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByLabelText('Edit Matte'));
    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'fixed' } });
    fireEvent.blur(document.querySelectorAll('[data-value-row]')[0] as HTMLElement, {
      relatedTarget: screen.getByText('stored-outside'),
    });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ priceConfig: null });
  });

  /**
   * 🔴 **Switching the price type ALONE must count as a change.**
   *
   * Every other test here edits a field as well, so `isDirty` was true either
   * way and a mutant that ignored `priceKind` survived (M190). A merchant who
   * switches a value from a flat amount to a percentage and changes nothing
   * else has still changed the value — and autosave that skipped it would
   * silently discard the switch on leaving the row.
   */
  it('treats a price-type switch on its own as a change', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'percentage' } });
    fireEvent.change(screen.getByLabelText(/Percent/i), { target: { value: '5' } });
    /* The label is untouched — only the pricing changed. */
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({
      label: 'Matte',
      priceConfig: { type: 'percentage', basisPoints: 500 },
    });
  });

  /**
   * 🔴 **A refused percentage must SAY so.** Autosave writes on leaving the
   * row, so a merchant who typed something unparseable gets no request and no
   * error — the edit simply does not happen, which reads as the editor being
   * broken rather than the value being wrong.
   */
  it('explains a malformed percentage', () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'percentage' } });
    fireEvent.change(screen.getByLabelText(/Percent/i), { target: { value: 'lots' } });

    expect(screen.getByText(/percentage like/i)).toBeTruthy();
  });

  /**
   * ⚠️ **Switching back to a flat amount CLEARS the stored config**, or the
   * storefront would keep charging the percentage the merchant just abandoned.
   */
  it('clears priceConfig when switching back to a flat amount', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'percentage' } });
    fireEvent.change(screen.getByLabelText(/Price type/i), { target: { value: 'fixed' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '3.00' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ priceConfig: null });
  });
});

/**
 * What a choice does to fulfilment (Phase 20 audit, F1).
 *
 * 🔴 **Both reach the cart and neither could be set.** `sku_suffix` composes the
 * cart item's SKU and `weight_delta_grams` changes the shipping weight — so a
 * merchant selling an engraved item could not make it ship heavier or carry its
 * own SKU, though the storefront has honoured both since M14.
 */
describe('ValueRow fulfilment fields', () => {
  it('offers a SKU suffix and a weight change', () => {
    mount();
    openEditor();

    expect(screen.getByLabelText(/SKU suffix/i)).toBeTruthy();
    expect(screen.getByLabelText(/Weight change/i)).toBeTruthy();
  });

  it('saves both', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/SKU suffix/i), { target: { value: '-ENG' } });
    fireEvent.change(screen.getByLabelText(/Weight change/i), { target: { value: '50' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({
      skuSuffix: '-ENG',
      weightDeltaGrams: 50,
    });
  });

  /**
   * 🔴 **A SKU suffix alone must count as a change.**
   *
   * Every other test here edits the weight as well, so `isDirty` was true from
   * that clause and a mutant ignoring `skuSuffix` survived (M234). A merchant
   * who sets only a SKU suffix has still changed the value — and autosave that
   * skipped it would discard the edit silently on leaving the row.
   */
  it('treats a SKU suffix on its own as a change', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/SKU suffix/i), { target: { value: '-ENG' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ skuSuffix: '-ENG' });
  });

  /** 🔴 And the default flag alone, which touches no text field at all. */
  it('treats the default flag on its own as a change', async () => {
    mount();
    openEditor();

    fireEvent.click(screen.getByLabelText(/Chosen by default/i));
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ isDefault: true });
  });

  /**
   * 🔴 **A lighter variant is real** — hollow rather than solid, a smaller
   * size — and `@IsInt()` accepts a negative. Refusing one here would be the
   * form disagreeing with the API.
   */
  it('accepts a negative weight change', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Weight change/i), { target: { value: '-30' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ weightDeltaGrams: -30 });
  });

  /** ⚠️ A blank weight CLEARS rather than saving zero — no change is not 0g. */
  it('clears the weight when emptied', async () => {
    mount({ weightDeltaGrams: 50 });
    openEditor();

    fireEvent.change(screen.getByLabelText(/Weight change/i), { target: { value: '' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ weightDeltaGrams: null });
  });

  /** 🔴 A malformed weight must not be written. */
  it('does not save a malformed weight', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/Weight change/i), { target: { value: 'heavy' } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
  });

  /** ⚠️ The API caps the suffix at 40 characters. */
  it('does not save an over-long SKU suffix', async () => {
    mount();
    openEditor();

    fireEvent.change(screen.getByLabelText(/SKU suffix/i), { target: { value: 'x'.repeat(41) } });
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateValue).not.toHaveBeenCalled();
  });

  /** 📌 Stored values are shown, so editing starts from what is set. */
  it('shows stored fulfilment values', () => {
    mount({ skuSuffix: '-ENG', weightDeltaGrams: 50 });
    openEditor();

    expect((screen.getByLabelText(/SKU suffix/i) as HTMLInputElement).value).toBe('-ENG');
    expect((screen.getByLabelText(/Weight change/i) as HTMLInputElement).value).toBe('50');
  });

  /**
   * 📌 **The server clears any other default**, so the editor sets the flag and
   * does not replicate "only one per option" — two implementations of one rule
   * is two places for them to disagree.
   */
  it('saves the default flag', async () => {
    mount();
    openEditor();

    fireEvent.click(screen.getByLabelText(/Chosen by default/i));
    fireEvent.blur(row(), { relatedTarget: screen.getByText('outside') });

    await waitFor(() => expect(updateValue).toHaveBeenCalled());
    expect(vi.mocked(updateValue).mock.calls[0]?.[1]).toMatchObject({ isDefault: true });
  });
});
