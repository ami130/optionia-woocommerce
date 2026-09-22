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
 * The wording a customer reads beside an option (Phase 20 audit, F1).
 *
 * 🔴 **The storefront rendered these and no merchant could set them.** Plugin
 * templates draw `help_text`, `placeholder` and `description`; the published
 * document carries all three — and `AuthoringOption` declared nine fields where
 * the projection sends nineteen, so they were dropped at the type boundary.
 *
 * ⚠️ **This is what "without reading documentation" rests on.** An option with
 * no help text pushes the explaining out of the product and into a support
 * page, which is exactly what Phase 20's exit criterion forbids.
 */
const group = (option: Record<string, unknown> = {}): AuthoringGroup =>
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
        presentation: 'text_field',
        isRequired: false,
        sortOrder: 0,
        isEnabled: true,
        values: [],
        ...option,
      },
    ],
    items: [],
  }) as never;

const mount = (option: Record<string, unknown> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GroupList
        setId="s1"
        groups={[group(option)]}
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

const open = () => fireEvent.click(screen.getByRole('button', { name: /Wording/i }));

beforeEach(() => {
  vi.mocked(updateOption).mockReset();
  vi.mocked(updateOption).mockResolvedValue({} as never);
});

describe('option wording', () => {
  it('is offered on an option', () => {
    mount();

    expect(screen.getByRole('button', { name: /Wording/i })).toBeTruthy();
  });

  it('offers the four fields the storefront renders', () => {
    mount();
    open();

    expect(screen.getByLabelText(/Description/i)).toBeTruthy();
    expect(screen.getByLabelText(/Placeholder/i)).toBeTruthy();
    expect(screen.getByLabelText(/Help text/i)).toBeTruthy();
    expect(screen.getByLabelText(/Default/i)).toBeTruthy();
  });

  it('saves what the merchant wrote', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Help text/i), {
      target: { value: 'Up to 20 characters' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      helpText: 'Up to 20 characters',
    });
  });

  /** 📌 Stored wording is shown, so editing starts from what is set. */
  it('shows stored wording', () => {
    mount({ helpText: 'Existing help', placeholder: 'Your name' });
    open();

    expect((screen.getByLabelText(/Help text/i) as HTMLInputElement).value).toBe('Existing help');
    expect((screen.getByLabelText(/Placeholder/i) as HTMLInputElement).value).toBe('Your name');
  });

  /**
   * 🔴 **An emptied field CLEARS the wording rather than being ignored.** A
   * merchant deleting help text is making a choice, and treating `''` as "no
   * change" would leave text on the storefront they had just removed — the same
   * rule `GroupDescription` follows.
   */
  it('clears wording a merchant empties', async () => {
    mount({ helpText: 'Existing help' });
    open();

    fireEvent.change(screen.getByLabelText(/Help text/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({ helpText: '' });
  });

  /** 🔴 Over-long text is refused with the API's own limit, not truncated. */
  it('refuses help text longer than the API accepts', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Help text/i), { target: { value: 'x'.repeat(501) } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(screen.getByText(/too long/i)).toBeTruthy());
    expect(updateOption).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **A placeholder means nothing on a choice option** — there is no box to
   * type into — so it is not offered there.
   */
  it('does not offer a placeholder on a choice option', () => {
    mount({ presentation: 'dropdown' });
    open();

    expect(screen.queryByLabelText(/Placeholder/i)).toBeNull();
  });

  it('still offers help text on a choice option', () => {
    mount({ presentation: 'dropdown' });
    open();

    expect(screen.getByLabelText(/Help text/i)).toBeTruthy();
  });
});

/**
 * The limits a customer's answer must satisfy (Phase 20 audit, F2).
 *
 * 🔴 **Beside the wording deliberately.** The wording editor let a merchant
 * write "Up to 20 characters" and not enforce twenty — advisory text with no
 * rule behind it, which is worse than neither. The two belong on one form
 * because a merchant setting one is describing the other.
 */
describe('option limits', () => {
  it('offers length bounds on a text option', () => {
    mount();
    open();

    expect(screen.getByLabelText(/Shortest/i)).toBeTruthy();
    expect(screen.getByLabelText(/Longest/i)).toBeTruthy();
  });

  it('offers range bounds on a number option', () => {
    mount({ presentation: 'number_field' });
    open();

    expect(screen.getByLabelText(/Smallest/i)).toBeTruthy();
    expect(screen.getByLabelText(/Largest/i)).toBeTruthy();
  });

  /** ⚠️ A choice option's answer is a value id — there is nothing to bound. */
  it('offers no bounds on a choice option', () => {
    mount({ presentation: 'dropdown' });
    open();

    expect(screen.queryByLabelText(/Shortest/i)).toBeNull();
    expect(screen.queryByLabelText(/Smallest/i)).toBeNull();
  });

  it('saves a length limit', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Longest/i), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      validation: { maxLength: 20 },
    });
  });

  /** 🔴 The API's cross-field rule, refused before the wire. */
  it('refuses a minimum above the maximum', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Shortest/i), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText(/Longest/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(screen.getByText(/above the maximum/i)).toBeTruthy());
    expect(updateOption).not.toHaveBeenCalled();
  });

  /** 📌 Stored limits are shown, so editing starts from what is set. */
  it('shows stored limits', () => {
    mount({ validation: { minLength: 2, maxLength: 20 } });
    open();

    expect((screen.getByLabelText(/Shortest/i) as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText(/Longest/i) as HTMLInputElement).value).toBe('20');
  });

  /**
   * 🔴 **A stored `pattern` must survive.** `textValidationSchema` is
   * `.strict()`, so saving without it would delete a rule the merchant never
   * touched — a length limit silently removing their pattern.
   */
  it('preserves a stored pattern when saving a length', async () => {
    mount({ validation: { pattern: '^[A-Z]+$' } });
    open();

    fireEvent.change(screen.getByLabelText(/Longest/i), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      validation: { pattern: '^[A-Z]+$', maxLength: 20 },
    });
  });
});

/**
 * 🔴 **The counter the plugin says the dashboard must DERIVE.**
 *
 * `text_field.php`: *"The dashboard derives `character_counter` from the limit
 * rather than offering it as a separate switch, so the two cannot disagree."*
 * Making `maxLength` authorable without honouring that produced exactly the
 * defect M14.4b names — *"silently rejecting the 21st character of an engraving
 * is a support ticket and often an abandoned cart."*
 */
describe('derived character counter', () => {
  it('turns the counter on with a length limit', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Longest/i), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      validation: { maxLength: 20 },
      display: { characterCounter: true },
    });
  });

  it('turns it off when the limit is removed', async () => {
    mount({ validation: { maxLength: 20 }, display: { characterCounter: true } });
    open();

    fireEvent.change(screen.getByLabelText(/Longest/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      display: { characterCounter: false },
    });
  });

  /** ⚠️ Never offered as a switch — a merchant could set it against the limit. */
  it('offers no counter switch', () => {
    mount();
    open();

    expect(screen.queryByLabelText(/counter/i)).toBeNull();
  });
});

/**
 * The three text rules, one of which is a security boundary.
 *
 * 🔴 **`pattern` is accepted here and refused at PUBLISH.** The registry is
 * explicit: refusing an unsafe pattern at authoring would stop a merchant
 * saving a draft they are still writing, so `patternsAreSafe` is a publish
 * blocker instead. The editor must mirror that, not diverge from it.
 */
describe('text rules', () => {
  it('offers a pattern, a charset and forbidden words on a text option', () => {
    mount();
    open();

    expect(screen.getByLabelText(/Pattern/i)).toBeTruthy();
    expect(screen.getByLabelText(/Allowed characters/i)).toBeTruthy();
    expect(screen.getByLabelText(/Words to refuse/i)).toBeTruthy();
  });

  /** ⚠️ A number option has no text to constrain. */
  it('offers none of them on a number option', () => {
    mount({ presentation: 'number_field' });
    open();

    expect(screen.queryByLabelText(/Pattern/i)).toBeNull();
  });

  it('saves all three', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Pattern/i), { target: { value: '^[A-Z ]+$' } });
    fireEvent.change(screen.getByLabelText(/Allowed characters/i), { target: { value: 'alpha' } });
    fireEvent.change(screen.getByLabelText(/Words to refuse/i), { target: { value: 'damn\nhell' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      validation: {
        pattern: '^[A-Z ]+$',
        allowedCharset: 'alpha',
        forbiddenWords: ['damn', 'hell'],
      },
    });
  });

  /** 🔴 A pattern that cannot compile is refused and explained. */
  it('refuses a malformed pattern', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Pattern/i), { target: { value: '[unclosed' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(screen.getByText(/not a valid pattern/i)).toBeTruthy());
    expect(updateOption).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **An unsafe pattern SAVES, and the merchant is told publish will refuse
   * it.** Blocking the save would stop a draft mid-edit; saying nothing would
   * let them discover it at publish with no idea why.
   */
  it('saves an unsafe pattern and warns about publish', async () => {
    mount();
    open();

    fireEvent.change(screen.getByLabelText(/Pattern/i), { target: { value: '(a+)+' } });

    /* ⚠️ Matched on the warning's own wording — `/publish/i` alone found two
     * elements, the test failing for its breadth rather than the code. */
    expect(screen.getByText(/repetition inside a repetition/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));
    await waitFor(() => expect(updateOption).toHaveBeenCalled());
  });

  /** 🔴 The length bounds must survive a pattern edit. */
  it('preserves the length bounds when saving a pattern', async () => {
    mount({ validation: { minLength: 2, maxLength: 20 } });
    open();

    fireEvent.change(screen.getByLabelText(/Pattern/i), { target: { value: '^[A-Z]+$' } });
    fireEvent.click(screen.getByRole('button', { name: /Save wording/i }));

    await waitFor(() => expect(updateOption).toHaveBeenCalled());
    expect(vi.mocked(updateOption).mock.calls[0]?.[1]).toMatchObject({
      validation: { minLength: 2, maxLength: 20, pattern: '^[A-Z]+$' },
    });
  });
});
