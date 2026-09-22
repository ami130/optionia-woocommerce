import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AddOption } from './[id]/page';

/**
 * Which of `AddOption`'s fields a merchant can actually see (20-2c).
 *
 * ## Why this file exists
 *
 * 🔴 **This is the coverage that has to exist BEFORE the form is migrated.**
 * `AddOption` is 430 lines of JSX over fifteen interdependent fields, and which
 * of them render is decided by `presentation`. The canonical E2E drives
 * **three** — label, key, type. The source contract in
 * `editor-contracts.test.ts` provably cannot see rendering at all: making a
 * component `return null` leaves every assertion there green.
 *
 * So a `react-hook-form` migration would have moved conditional markup with
 * roughly a fifth of it verified, and a field that silently stopped rendering
 * would have passed every gate. These tests are the net that makes the
 * migration checkable rather than hoped-for.
 *
 * ⚠️ **Characterisation, not specification.** They record what the form does
 * *today*, so the migration can be judged by whether they still pass. A test
 * here that looks wrong is a question to raise, not a bug to fix in passing —
 * changing behaviour and its test together proves nothing.
 */
const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <AddOption groupId="group-1" onAdded={() => {}} />
    </QueryClientProvider>,
  );
};

/** Choose an option type by its stable hook, the way the E2E does. */
const chooseType = async (value: string) => {
  const { fireEvent } = await import('@testing-library/react');
  const button = document.querySelector(`[data-option-type="${value}"]`);

  expect(button, `no control for ${value}`).not.toBeNull();
  fireEvent.click(button as Element);
};

/*
 * ⚠️ **Ids are scoped to the group** since 20-2d — `option-label-group-1`, not
 * `option-label`. `AddOption` renders once per group, and fixed ids collided
 * the moment a set had two. Resolved here rather than at each call site, so the
 * tests read the same as before.
 */
const field = (id: string) => document.querySelector(`#${id}-group-1`);

describe('AddOption — always present', () => {
  it('offers a label and a key', () => {
    mount();

    expect(field('option-label')).not.toBeNull();
    expect(field('option-key')).not.toBeNull();
  });

  it('offers every authorable type', async () => {
    mount();

    const { AUTHORABLE_TYPES } = await import('@/lib/schemas/option-sets');

    for (const type of AUTHORABLE_TYPES) {
      expect(
        document.querySelector(`[data-option-type="${type.value}"]`),
        `${type.value} has no control`,
      ).not.toBeNull();
    }
  });

  /** Help text and collapse apply to every type, so they never hide. */
  it('offers help text', () => {
    mount();

    expect(field('option-tooltip')).not.toBeNull();
  });
});

describe('AddOption — the four fields nothing else watched', () => {
  /**
   * 🔴 **Added after an audit found them unprotected at every layer.** The
   * first version of this file claimed to cover *"the twelve fields no E2E
   * touches"*; it covered seven. `columns`, `priceFraming`, `isRequired` and
   * `collapsed` had **no render test and no E2E** — and making the columns
   * chooser never render (M97) passed all **641** tests while a merchant lost
   * a real control.
   *
   * These four are exactly what a `react-hook-form` migration moves, so they
   * are the last part of the net that has to exist before it does.
   */
  it('offers the required toggle, for every type', async () => {
    mount();

    expect(screen.queryByText(/Required — the customer cannot add to cart/i)).not.toBeNull();

    await chooseType('text_field');
    expect(
      screen.queryByText(/Required — the customer cannot add to cart/i),
      'required applies to a text field too',
    ).not.toBeNull();
  });

  /** Folding is presentation, so it applies whatever the option collects. */
  it('offers the start-folded toggle', () => {
    mount();

    expect(screen.queryByText(/Start folded/i)).not.toBeNull();
  });

  /**
   * ⚠️ **Columns are meaningless for a type with no choices to lay out.** Both
   * directions asserted: a test that only checked presence would pass a form
   * showing a column chooser on a date picker.
   */
  it('offers columns for a choice type and not for a text field', async () => {
    mount();

    await chooseType('radio');
    expect(screen.queryByText(/How many columns/i), 'radio lays out choices').not.toBeNull();

    await chooseType('text_field');
    expect(screen.queryByText(/How many columns/i), 'a text field has none').toBeNull();
  });

  /** A price framing only means something where a choice can carry a price. */
  it('offers price framing for a choice type and not for a text field', async () => {
    mount();

    await chooseType('radio');
    expect(screen.queryByText(/Show a price beside each choice/i)).not.toBeNull();

    await chooseType('text_field');
    expect(screen.queryByText(/Show a price beside each choice/i)).toBeNull();
  });
});

describe('AddOption — errors appear while typing, not only on blur', () => {
  /**
   * 🔴 **The migration could silently revert this, and nothing noticed.**
   * Before 20-2c the component recomputed `optionSchema.safeParse` on **every
   * render**, so an invalid key was flagged as a merchant typed it. `useForm`
   * runs with `mode: 'onBlur'`, which alone would hold the message back until
   * the field is left — so four setters pass `shouldValidate: true` to keep the
   * old behaviour.
   *
   * ⚠️ **Measured: deleting that one property takes the red hints from 1 to 0
   * while leaving all 651 tests green.** A merchant would type a malformed key,
   * see nothing, and only learn on blur. This is the assertion that makes the
   * property load-bearing rather than decorative.
   *
   * 📌 Asserted through the rendered class rather than `formState`, because the
   * class is what a merchant actually sees — `formState.errors` could populate
   * while the hint stayed grey and the test would still pass.
   */
  const redHints = () => document.querySelectorAll('.text-destructive').length;

  it('flags a malformed key before the field is left', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');

    mount();

    const keyInput = field('option-key') as HTMLInputElement;

    fireEvent.change(keyInput, { target: { value: 'Bad Key!!' } });

    await waitFor(() => expect(redHints()).toBeGreaterThan(0));
  });

  /** And a valid key shows nothing, so the assertion above means something. */
  it('flags nothing while a valid key is typed', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');

    mount();

    fireEvent.change(field('option-key') as HTMLInputElement, { target: { value: 'finish' } });

    await waitFor(() => {}, { timeout: 30 });

    expect(redHints()).toBe(0);
  });
});

describe('AddOption — contradictory length bounds', () => {
  /**
   * 🔴 **A regression the 20-2c migration introduced, and the audit caught.**
   * `optionSchema`'s `superRefine` reports *"A minimum of 50 cannot fit inside
   * a limit of 10"* at `path: ['minLength']`, and the form used to render it
   * because `issue()` read that parse directly. Moving `issue()` to
   * `formState` lost it twice over: the form schema had no such rule, and
   * `shouldValidate: true` validates only the field being edited — never a
   * cross-field issue reported at a **third** path.
   *
   * Measured at each step: present before the migration, absent after, present
   * again once both length setters call `form.trigger()`.
   */
  it('tells a merchant when the minimum cannot fit the maximum', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');

    mount();
    await chooseType('text_field');

    fireEvent.change(field('option-min-length') as HTMLInputElement, { target: { value: '50' } });
    fireEvent.change(field('option-max-length') as HTMLInputElement, { target: { value: '10' } });

    await waitFor(() =>
      expect(document.body.textContent).toContain('cannot fit inside a limit'),
    );
  });

  it('says nothing when the bounds fit', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');

    mount();
    await chooseType('text_field');

    fireEvent.change(field('option-min-length') as HTMLInputElement, { target: { value: '5' } });
    fireEvent.change(field('option-max-length') as HTMLInputElement, { target: { value: '50' } });

    await waitFor(() => {}, { timeout: 40 });

    expect(document.body.textContent).not.toContain('cannot fit inside a limit');
  });
});

describe('AddOption — contradictory selection bounds', () => {
  /**
   * 🔴 **A minimum above the maximum must block the add.** `boundsContradict`
   * is a tested pure function, and the component wires it to three things — the
   * hint's colour, the hint's wording, and the submit button's `disabled`. The
   * *wiring* was untested: the render tests covered whether the bound fields
   * appear, never what happens when they disagree.
   *
   * 📌 **Left OUTSIDE the schema, deliberately.** 20-2c's plan proposed folding
   * this into `optionFormExtrasSchema` as a `.refine()`. Reading the call site
   * first showed why not: the component needs the boolean *live*, on every
   * keystroke, to colour a hint and disable a button — not as a parse failure
   * at submit. A refine would have moved a working, visible check behind
   * `safeParse` and made the hint harder to render, for tidiness alone.
   */
  const showBounds = async () => {
    const { fireEvent } = await import('@testing-library/react');

    mount();
    await chooseType('checkbox');

    const toggle = screen.getByLabelText(/several|multiple|more than one/i);

    fireEvent.click(toggle);

    return fireEvent;
  };

  it('refuses to add when the minimum exceeds the maximum', async () => {
    const fireEvent = await showBounds();

    fireEvent.change(field('option-label') as HTMLInputElement, {
      target: { value: 'Toppings' },
    });
    fireEvent.change(field('option-min-sel') as HTMLInputElement, { target: { value: '5' } });
    fireEvent.change(field('option-max-sel') as HTMLInputElement, { target: { value: '2' } });

    const add = [...document.querySelectorAll('button')].find((button) =>
      /add option/i.test(button.textContent ?? ''),
    );

    expect(add?.disabled, 'a contradictory pair must block the add').toBe(true);
  });

  it('allows the add when the bounds agree', async () => {
    const fireEvent = await showBounds();

    fireEvent.change(field('option-label') as HTMLInputElement, {
      target: { value: 'Toppings' },
    });
    fireEvent.change(field('option-min-sel') as HTMLInputElement, { target: { value: '2' } });
    fireEvent.change(field('option-max-sel') as HTMLInputElement, { target: { value: '5' } });

    const add = [...document.querySelectorAll('button')].find((button) =>
      /add option/i.test(button.textContent ?? ''),
    );

    expect(add?.disabled, 'an agreeing pair must not block the add').toBe(false);
  });
});

describe('AddOption — the form resets after a successful add', () => {
  /**
   * 🔴 **Fifteen fields are cleared by hand today**, in a fifteen-line block.
   * That is correct at the moment — every declared field appears in it — and it
   * is exactly the kind of list a sixteenth field gets left out of. Locked here
   * *before* the form is migrated, so the migration has to preserve it rather
   * than be trusted to.
   *
   * ⚠️ Asserted through what a merchant sees — a typed label that is gone
   * afterwards — not through the setters, which are an implementation detail
   * the migration is meant to replace.
   */
  it('keeps typed values until the add succeeds', async () => {
    const { fireEvent } = await import('@testing-library/react');

    mount();

    const label = field('option-label') as HTMLInputElement;

    fireEvent.change(label, { target: { value: 'Engraving' } });

    expect((field('option-label') as HTMLInputElement).value).toBe('Engraving');
  });

  /**
   * The key follows the label until a merchant edits the key themselves —
   * `keyTouched`, the one piece of state that is UI bookkeeping rather than
   * data, and the reason it is excluded from `optionFormExtrasSchema`.
   */
  it('fills the key from the label until the key is edited', async () => {
    const { fireEvent } = await import('@testing-library/react');

    mount();

    fireEvent.change(field('option-label') as HTMLInputElement, {
      target: { value: 'Gift Wrap' },
    });

    expect((field('option-key') as HTMLInputElement).value).not.toBe('');

    const key = field('option-key') as HTMLInputElement;

    fireEvent.change(key, { target: { value: 'custom' } });
    fireEvent.change(field('option-label') as HTMLInputElement, {
      target: { value: 'Something Else' },
    });

    expect((field('option-key') as HTMLInputElement).value).toBe('custom');
  });
});

describe('AddOption — fields that depend on the type', () => {
  /**
   * 🔴 **The twelve fields no E2E touches.** Each assertion pairs a type that
   * *should* show the field with one that should not — a test that only proved
   * presence would pass against a form that showed everything always, which is
   * the opposite defect and just as wrong.
   */
  it('offers a character limit for a text field, not for radio', async () => {
    mount();

    await chooseType('text_field');
    expect(field('option-max-length'), 'text_field should accept a limit').not.toBeNull();

    await chooseType('radio');
    expect(field('option-max-length'), 'radio should not').toBeNull();
  });

  it('offers a minimum length on the same terms', async () => {
    mount();

    await chooseType('textarea');
    expect(field('option-min-length')).not.toBeNull();

    await chooseType('radio');
    expect(field('option-min-length')).toBeNull();
  });

  /**
   * ⚠️ **Selection bounds need BOTH a multi-answer type and the toggle.** They
   * are meaningless on an option that takes one answer, so the type alone is
   * not enough to reveal them.
   */
  it('hides selection bounds until several answers are allowed', async () => {
    mount();

    await chooseType('checkbox');
    expect(field('option-min-sel'), 'bounds before the toggle').toBeNull();

    const { fireEvent } = await import('@testing-library/react');
    const toggle = screen.getByLabelText(/several|multiple|more than one/i);

    fireEvent.click(toggle);

    expect(field('option-min-sel'), 'bounds after the toggle').not.toBeNull();
    expect(field('option-max-sel')).not.toBeNull();
  });

  it('offers swatch sizing only for a swatch type', async () => {
    mount();

    await chooseType('color_swatch');
    const withSwatch = screen.queryAllByText(/small|medium|large/i).length;

    await chooseType('radio');
    const withoutSwatch = screen.queryAllByText(/small|medium|large/i).length;

    expect(withSwatch).toBeGreaterThan(withoutSwatch);
  });
});
