import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { AuthoringGroup } from '@/lib/option-sets/api';
import { GroupList } from './[id]/page';

/**
 * What happens when a set has **more than one group** (20-2d).
 *
 * 🔴 **Every gate passes today because nothing ever renders two.** The
 * canonical E2E creates exactly one group — `#new-group-label` is filled once —
 * and each unit test mounts a single `AddOption`. So the editor has never been
 * observed in the state a merchant reaches by clicking "Add group" twice.
 *
 * ⚠️ **`AddOption` renders once per group with FIXED ids** — `#option-label`,
 * `#option-key` and five more — gated only on `canEdit`. Two groups therefore
 * put duplicate ids in one document: invalid HTML, and `<label htmlFor>` binds
 * to whichever the browser resolves first. A merchant filling the second
 * group's label can have the first group's field labelled for it.
 *
 * 📌 **The pattern for the fix already exists in the same file.** `ValueRow`
 * scopes six ids per row — `` id={`label-${value.id}`} `` — so this is an
 * inconsistency rather than an unsolved problem.
 */
const group = (id: string, label: string): AuthoringGroup => ({
  id,
  label,
  description: null,
  sortOrder: 0,
  isEnabled: true,
  displayType: 'inline',
  isCollapsible: false,
  options: [],
  items: [],
});

const mount = (groups: AuthoringGroup[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <GroupList
        setId="set-1"
        groups={groups}
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
};

describe('GroupList with one group', () => {
  it('renders one add-option form, scoped to the group', () => {
    mount([group('g1', 'Finish')]);

    expect(document.querySelectorAll('#option-label-g1')).toHaveLength(1);
  });
});

describe('GroupList — one group is edited at a time (20-2d)', () => {
  /**
   * 🔴 **The rendering-model change, asserted before it is built.** Until now
   * every group rendered its **full** editor inline: description, layout, every
   * option block, every item and both add-forms. A set at
   * `AUTHORING_LIMITS` scale — 20 groups of 30 options — mounted **600**
   * `OptionBlock`s at once.
   *
   * A structure pane selects; an editor pane shows the selection. So exactly
   * one add-option form exists in the document however many groups there are.
   *
   * ⚠️ **This also makes the scoped ids of 2d-b belt-and-braces rather than
   * load-bearing** — with one editor mounted they could not collide anyway. The
   * scoping stays: it is what keeps the markup valid if anything ever renders
   * two, and `ValueRow` has done the same for its rows since it was written.
   */
  it('mounts one add-option form regardless of group count', () => {
    mount([group('g1', 'Finish'), group('g2', 'Size'), group('g3', 'Colour')]);

    expect(document.querySelectorAll('[id^="option-label-"]')).toHaveLength(1);
  });

  /** Every group is still reachable — selection must not hide the others. */
  it('lists every group by name', () => {
    const { container } = mount([group('g1', 'Finish'), group('g2', 'Size')]);

    expect(container.textContent).toContain('Finish');
    expect(container.textContent).toContain('Size');
  });

  /**
   * 📌 **The first group is selected on arrival.** A merchant opening a set
   * should see an editor, not an empty pane asking them to choose.
   */
  it('selects the first group on arrival', () => {
    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    expect(document.querySelector('#option-label-g1')).not.toBeNull();
    expect(document.querySelector('#option-label-g2')).toBeNull();
  });

  /** Choosing another group moves the editor to it. */
  it('moves the editor when another group is chosen', async () => {
    const { fireEvent } = await import('@testing-library/react');

    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    const chooser = document.querySelector('[data-group-select="g2"]');

    expect(chooser, 'no way to choose the second group').not.toBeNull();
    fireEvent.click(chooser as Element);

    expect(document.querySelector('#option-label-g2')).not.toBeNull();
    expect(document.querySelector('#option-label-g1')).toBeNull();
  });
});

describe('GroupList — unsaved work is not discarded silently (M20.10)', () => {
  /**
   * 🔴 **Switching groups clears the form, and that is correct.** M110 proved
   * the alternative: without the remount a half-typed option carries into the
   * *next* group and can be created against one the merchant never chose. The
   * defect M20.10 fixes is that the clearing happened **silently** — fourteen
   * fields gone on one click, with no dialog.
   *
   * ⚠️ **`beforeunload` cannot cover this.** It fires for a reload, a closed
   * tab or a typed URL; an in-page click never reaches it. So the question is
   * asked where the click happens.
   */
  it('asks before a switch throws away a half-typed option', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { vi } = await import('vitest');

    const confirm = vi.fn(() => true);

    vi.stubGlobal('confirm', confirm);

    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    fireEvent.change(document.querySelector('#option-label-g1') as HTMLInputElement, {
      target: { value: 'HALF TYPED' },
    });

    fireEvent.click(document.querySelector('[data-group-select="g2"]') as Element);

    expect(confirm, 'a dirty form must be defended').toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  /**
   * ⚠️ **A clean form must never interrupt.** A guard that asks every time
   * teaches a merchant to dismiss it unread — which costs more than it saves
   * the first time the form really is dirty.
   */
  it('switches without asking when nothing is unsaved', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { vi } = await import('vitest');

    const confirm = vi.fn(() => true);

    vi.stubGlobal('confirm', confirm);

    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    fireEvent.click(document.querySelector('[data-group-select="g2"]') as Element);

    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelector('#option-label-g2')).not.toBeNull();

    vi.unstubAllGlobals();
  });

  /** 🔴 Declining must keep the merchant where they were, or the question is decoration. */
  it('stays on the group when the merchant declines', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { vi } = await import('vitest');

    vi.stubGlobal('confirm', vi.fn(() => false));

    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    fireEvent.change(document.querySelector('#option-label-g1') as HTMLInputElement, {
      target: { value: 'HALF TYPED' },
    });

    fireEvent.click(document.querySelector('[data-group-select="g2"]') as Element);

    expect(document.querySelector('#option-label-g1'), 'should not have moved').not.toBeNull();
    expect((document.querySelector('#option-label-g1') as HTMLInputElement).value).toBe(
      'HALF TYPED',
    );

    vi.unstubAllGlobals();
  });
});

describe('GroupList — switching groups starts a fresh form', () => {
  /**
   * 🔴 **Without `key={selected.id}` the form state follows the merchant.**
   * React reuses a component in the same position, so `AddOption`'s
   * `useForm` — and its fifteen values — survive a group change. Measured with
   * the key removed: typing *"HALF TYPED"* into group A's label and choosing
   * group B leaves **`'HALF TYPED'` sitting in B's field**.
   *
   * ⚠️ That is worse than losing the text. A merchant who switches groups to
   * check something, comes back, and clicks *Add option* would create it on
   * the wrong group — with a label they half-wrote for another.
   *
   * 📌 **Found by mutation, not by review.** M110 (dropping the key) passed all
   * **77** tests; the carry-over is invisible to every assertion about which
   * fields render.
   */
  it('does not carry a half-typed option to another group', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { vi } = await import('vitest');

    /*
     * ✏️ **M20.10 put a confirm in front of this switch**, so the dialog has to
     * be answered for the test to reach what it is actually about. Accepting is
     * the right answer here: the question under test is what happens to the
     * *other* group's form once a merchant has chosen to discard.
     */
    vi.stubGlobal('confirm', vi.fn(() => true));

    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    fireEvent.change(document.querySelector('#option-label-g1') as HTMLInputElement, {
      target: { value: 'HALF TYPED' },
    });

    fireEvent.click(document.querySelector('[data-group-select="g2"]') as Element);

    const other = document.querySelector('#option-label-g2') as HTMLInputElement;

    expect(other, 'the second group should have its own form').not.toBeNull();
    expect(other.value, 'the other group’s form must start empty').toBe('');

    vi.unstubAllGlobals();
  });
});

describe('GroupList — ordering lives in one place', () => {
  /**
   * 🔴 **Two sets of arrows would be worse than none.** `GroupCard` kept its
   * own move buttons after 2d-d moved ordering into the structure pane, and its
   * `onMove` prop is optional — so they rendered **inert**. A merchant would
   * see arrows beside the group name that work and arrows inside the editor
   * that do nothing, with no way to tell which is which.
   */
  it('offers exactly one pair of move controls per group', () => {
    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    expect(document.querySelectorAll('[aria-label="Move Finish up"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-label="Move Finish down"]')).toHaveLength(1);
  });

  /** And no button anywhere is an inert copy. */
  it('renders no move control without a handler', () => {
    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    const dead = [...document.querySelectorAll('button')].filter(
      (button) => /^(↑|↓)$/.test(button.textContent?.trim() ?? '') && !button.getAttribute('aria-label'),
    );

    expect(dead, 'a move button with no accessible name is an orphaned copy').toEqual([]);
  });
});

describe('GroupList with two groups', () => {
  /**
   * 🔴 **The assertion this stage exists to satisfy.** Ids must identify one
   * element. Asserted per id rather than in aggregate, so a failure names the
   * field that collided instead of a count.
   */
  it.each([
    'option-label',
    'option-key',
    'option-tooltip',
  ])('keeps #%s unique across groups', (id) => {
    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    /*
     * ⚠️ **Asserted on the UNSCOPED name.** After the fix no element carries it
     * — each is `option-label-g1`, `option-label-g2` — so the count is zero.
     * Written this way on purpose: it fails at **two** if the scoping is ever
     * removed, which is the regression worth catching. The scoped ids are
     * asserted separately below.
     */
    expect(document.querySelectorAll(`#${id}`).length).toBeLessThanOrEqual(1);
  });

  /**
   * ✏️ **These two asserted both groups' fields existed at once — the old
   * model.** 2d-d mounts one editor, so only the selected group has fields.
   * Rewritten to assert the *selected* group owns them, which is the property
   * the scoping still has to guarantee.
   */
  it('gives the selected group its own scoped option-label', async () => {
    const { fireEvent } = await import('@testing-library/react');

    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    expect(document.querySelectorAll('#option-label-g1')).toHaveLength(1);

    fireEvent.click(document.querySelector('[data-group-select="g2"]') as Element);

    expect(document.querySelectorAll('#option-label-g2')).toHaveLength(1);
  });

  /**
   * 🔴 **The label must point at ITS OWN field.** Unique ids alone are not the
   * fix — a `htmlFor` left unscoped would bind every label to one input, which
   * is the same defect wearing different clothes.
   */
  it('binds the selected group’s label to its own input', async () => {
    const { fireEvent } = await import('@testing-library/react');

    mount([group('g1', 'Finish'), group('g2', 'Size')]);

    expect(document.querySelector('label[for="option-label-g1"]')).not.toBeNull();

    fireEvent.click(document.querySelector('[data-group-select="g2"]') as Element);

    expect(document.querySelector('label[for="option-label-g2"]')).not.toBeNull();
  });

  /** Both groups' labels still render — the split must not hide one. */
  it('shows both groups', () => {
    const { container } = mount([group('g1', 'Finish'), group('g2', 'Size')]);

    expect(container.textContent).toContain('Finish');
    expect(container.textContent).toContain('Size');
  });
});
