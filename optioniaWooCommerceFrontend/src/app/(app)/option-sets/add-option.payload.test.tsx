import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `AddOption` actually SENDS — not what it renders (20-2c step 1).
 *
 * 🔴 **The behaviour nothing watched, and the one most likely to break.**
 * `AddOption` holds **zero** `useEffect`. Switching option type does not clear
 * the fields that no longer apply; instead **nine** `accepts*(presentation)`
 * guards drop them at payload-build time:
 *
 * ```ts
 * const maxLength = acceptsLength(presentation) && maxLengthText.trim() !== ''
 *   ? Number(maxLengthText) : null;
 * ```
 *
 * So a limit typed for a text field is still in state after switching to
 * radio — and must **not** reach the API. The render tests assert which fields
 * a merchant can see; none of them could see this.
 *
 * ⚠️ **A `react-hook-form` migration is exactly what breaks it.** Calling
 * `form.reset()` on type change, or trusting `form.getValues()` without the
 * guards, would silently start sending stale fields while every other test
 * stayed green. These assertions are the reason the migration is checkable.
 *
 * 📌 **The helpers themselves are already covered** — `layoutFor`,
 * `priceFramingFor`, `swatchSizeFor`, `selectionBoundsFor` and `configFor` each
 * have their own tests for returning `{}`. What was untested is the
 * *component* wiring them to the live `presentation`.
 */
/*
 * ⚠️ **Typed by its signature, not by naming unused parameters.** The mock has
 * to accept two arguments so `mock.calls.at(-1)?.[1]` typechecks — but naming
 * them warns under `no-unused-vars`, and this repository configures no
 * underscore escape.
 */
const createOption = vi.hoisted(() =>
  vi.fn<(groupId: string, changes: Record<string, unknown>) => Promise<{ id: string }>>(
    async () => ({ id: 'new-option' }),
  ),
);

vi.mock('@/lib/option-sets/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/option-sets/api')>()),
  createOption,
}));

const { AddOption } = await import('./[id]/page');

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <AddOption groupId="group-1" onAdded={() => {}} />
    </QueryClientProvider>,
  );
};

/*
 * ⚠️ **Ids are scoped to the group** since 20-2d — `option-label-group-1`, not
 * `option-label`. `AddOption` renders once per group, and fixed ids collided
 * the moment a set had two. Resolved here rather than at each call site, so the
 * tests read the same as before.
 */
const field = (id: string) =>
  document.querySelector(`#${id}-group-1`) as HTMLInputElement | null;

const chooseType = (value: string) => {
  const button = document.querySelector(`[data-option-type="${value}"]`);

  expect(button, `no control for ${value}`).not.toBeNull();
  fireEvent.click(button as Element);
};

const type = (id: string, value: string) => {
  const input = field(id);

  expect(input, `no field ${id}`).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { value } });
};

/** Fill the two always-required fields and submit. */
const submit = async () => {
  type('option-label', 'Engraving');

  const add = [...document.querySelectorAll('button')].find(
    (button) => /add option/i.test(button.textContent ?? '') && !button.disabled,
  );

  expect(add, 'the add button should be enabled').toBeDefined();
  fireEvent.click(add as HTMLButtonElement);

  await waitFor(() => expect(createOption).toHaveBeenCalled());

  return (createOption.mock.calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
};

describe('AddOption — the payload after a type switch', () => {
  beforeEach(() => {
    createOption.mockClear();
  });

  /**
   * 🔴 **The core case.** A character limit typed while the type was
   * `text_field` is still in state after switching to `radio`, and radio takes
   * no limit — so it must not be sent.
   */
  /**
   * 📌 **The defence is DOUBLED, and that makes single mutants equivalent.**
   * Removing the component's `acceptsLength(presentation)` guard (M102) leaves
   * `configFor`'s own identical guard; removing `configFor`'s (M103) leaves the
   * component's. Each alone is survivable and this test stays green — correctly.
   * Removing **both** (M104) leaks a stale `50` into `validation.maxLength` and
   * this test fails. Recorded so a future audit does not read two equivalent
   * mutants as a coverage hole.
   */
  it('drops a character limit that the chosen type cannot use', async () => {
    mount();

    chooseType('text_field');
    type('option-max-length', '50');

    chooseType('radio');

    const payload = await submit();

    expect(payload.maxLength ?? null).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('50');
  });

  /** The same value IS sent when the type does accept it. */
  it('sends a character limit the chosen type accepts', async () => {
    mount();

    chooseType('text_field');
    type('option-max-length', '50');

    const payload = await submit();

    /*
     * ⚠️ **It lands in `validation`, not at the top level** — `configFor`
     * returns `{ validation: { maxLength } }`. A first draft of this test
     * asserted `payload.maxLength` and failed against correct code; the shape
     * is the contract's, not the form's.
     */
    expect((payload.validation as Record<string, unknown>)?.maxLength).toBe(50);
  });

  /**
   * ⚠️ **Selection bounds need the type AND the multi-answer toggle.** A bound
   * typed with the toggle on, then turned off, must not survive into the
   * payload — `selectionBoundsFor` takes `takesMany` for exactly this reason.
   */
  it('drops selection bounds once several answers are turned off', async () => {
    mount();

    chooseType('checkbox');

    const toggle = [...document.querySelectorAll('input[type="checkbox"]')].find((input) =>
      /several|multiple|more than one/i.test(input.closest('label')?.textContent ?? ''),
    );

    expect(toggle, 'no multi-answer toggle').toBeDefined();
    fireEvent.click(toggle as HTMLInputElement);

    type('option-min-sel', '2');

    fireEvent.click(toggle as HTMLInputElement);

    const payload = await submit();

    expect(JSON.stringify(payload)).not.toContain('"min"');
  });

  /** A type that takes no choices carries no column layout. */
  it('drops a column layout the chosen type cannot use', async () => {
    mount();

    chooseType('text_field');

    const payload = await submit();

    expect(JSON.stringify(payload)).not.toContain('columns');
  });
});
