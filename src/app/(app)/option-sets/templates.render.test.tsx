import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TemplatePicker } from '@/components/option-sets/option-set-display';

/**
 * Choosing a starter template (M20.7).
 *
 * 🔴 **"A merchant's first option set should be a template they adapt, never a
 * blank canvas."** Phase 20b names the failure it prevents: a merchant who does
 * not yet know what "option group" means is not taught by an empty screen.
 *
 * ⚠️ **Offered beside "create from scratch", never instead of it.** A merchant
 * who knows what they want should not have to delete a template first.
 */
describe('TemplatePicker', () => {
  const templates = [
    { id: 'engraving', name: 'Engraving', description: 'Text priced per character.' },
    { id: 'gift-wrap', name: 'Gift wrap', description: 'A priced wrapping choice.' },
  ];

  it('lists each template by name', () => {
    const markup = renderToStaticMarkup(
      <TemplatePicker templates={templates} onChoose={() => {}} />,
    );

    expect(markup).toMatch(/Engraving/);
    expect(markup).toMatch(/Gift wrap/);
  });

  /** 📌 The description is what tells a merchant which one fits their shop. */
  it('describes each one', () => {
    const markup = renderToStaticMarkup(
      <TemplatePicker templates={templates} onChoose={() => {}} />,
    );

    expect(markup).toMatch(/priced per character/);
  });

  it('offers nothing when there are no templates', () => {
    const markup = renderToStaticMarkup(<TemplatePicker templates={[]} onChoose={() => {}} />);

    expect(markup).toBe('');
  });

  /** ⚠️ A disabled picker is one already working — no double submission. */
  it('disables every choice while one is being created', () => {
    const markup = renderToStaticMarkup(
      <TemplatePicker templates={templates} busy onChoose={() => {}} />,
    );

    expect(markup.match(/disabled=""/g)?.length).toBe(2);
  });

  /**
   * 🔴 **The defect this prop exists for (Step 0, S0-1).**
   *
   * An option set belongs to a store, so importing a template needs one
   * connected. The page rendered the cards regardless and rejected the click
   * with "Connect a store before using a template." — a dead end reached by
   * exactly the merchant templates are meant to help, and the funnel proves that
   * merchant is real: more tenants have created a set than have a connected
   * store.
   *
   * The reason must be visible **instead of** the cards, not behind them.
   */
  it('explains why instead of offering cards that cannot work', () => {
    const markup = renderToStaticMarkup(
      <TemplatePicker
        templates={templates}
        unavailable={<span>Connect a store first</span>}
        onChoose={() => {}}
      />,
    );

    expect(markup).toMatch(/Connect a store first/);
    // No card is offered, so no click can fail.
    expect(markup).not.toMatch(/Engraving/);
    expect(markup).not.toMatch(/<button/);
  });

  /**
   * A1 — "not yet known" is not "none".
   *
   * The page passes a different node while the store query is in flight, and the
   * picker must render it rather than falling back to cards or to the refusal.
   */
  it('renders a pending reason without offering cards', () => {
    const markup = renderToStaticMarkup(
      <TemplatePicker
        templates={templates}
        unavailable={<span>Checking your stores…</span>}
        onChoose={() => {}}
      />,
    );

    expect(markup).toMatch(/Checking your stores/);
    expect(markup).not.toMatch(/Connect a store/);
    expect(markup).not.toMatch(/<button/);
  });

  it('offers the templates normally once a store is connected', () => {
    const markup = renderToStaticMarkup(
      <TemplatePicker templates={templates} unavailable={null} onChoose={() => {}} />,
    );

    expect(markup).toMatch(/Engraving/);
    expect(markup).toMatch(/<button/);
  });
});

/**
 * The page's half of the contract (Step 0, S0-1).
 *
 * 🔴 **The component tests above could never have caught this defect.** The
 * picker was correct in isolation; the *page* rendered it without checking
 * whether a store existed. A seam between two correct pieces is where the bug
 * lived, which is the shape of defect this project keeps finding.
 *
 * Read from source for the reason `editor-contracts` gives: the page is a client
 * component needing `useParams`, React Query and a session provider, and this
 * repository has no renderer for that. A source contract protects the wiring
 * today rather than a better test arriving after it breaks again.
 */
describe('the option-sets page tells the picker when a template cannot be used', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'),
    'utf8',
  );

  it('passes an unavailable reason to the picker', () => {
    expect(source).toMatch(/unavailable=\{/);
  });

  /**
   * The condition must be the **store list**, not something incidental. A guard
   * on the wrong value is how this defect existed in the first place: the store
   * check lived in `NewSetForm` and never applied to the picker.
   */
  it('keys that reason on there being no connected store', () => {
    const picker = source.slice(source.indexOf('<TemplatePicker'));

    expect(picker).toMatch(/stores\.data[^)]*\)\.length === 0/);
  });

  /**
   * ✏️ **Asserted on `templateUnavailable`, not on the JSX.** The reason lived
   * inline beside each `<TemplatePicker>` until ADR-096 added a second placement;
   * three copies of one rule is how two of them end up saying different things,
   * so it moved into a function — and these guards follow it rather than
   * continuing to slice markup that no longer holds the logic.
   */
  it('points the merchant at the stores screen rather than only refusing', () => {
    const helper = source.slice(source.indexOf('function templateUnavailable'));

    expect(helper.slice(0, helper.indexOf('\n}'))).toMatch(/\/stores/);
  });
});

/**
 * ADR-087 — templates lead the first run, the blank canvas is demoted.
 *
 * 🔴 **This pins a resolved contradiction, which is why it is worth a test.**
 * M20b.4 said "never a blank canvas"; the code said templates sit "beside the
 * empty button, never instead of it". Both were deliberate. Without a guard the
 * next person to read either one will "fix" the other back.
 */
describe('the first run leads with templates', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'),
    'utf8',
  );

  /**
   * The empty state's own action block, where the first-run choice is made.
   *
   * 🔴 **The first version of this sliced on `</EmptyState>`, which does not
   * exist** — the element is self-closing, so the fallback ran to end of file and
   * the "secondary choice" assertion below searched the whole 600-line page. That
   * mattered: `variant="outline"` appears six times in this file, so the
   * assertion would have passed against any of the five unrelated buttons.
   *
   * Bounded by the `AsyncState` children instead — the `{(rows) =>` callback that
   * renders the populated list is the first thing after the empty state — and the
   * bound is asserted rather than defaulted, so a refactor that moves it fails
   * here instead of silently widening the slice again.
   */
  const emptyStart = source.indexOf('<TemplatePicker');
  const emptyEnd = source.indexOf('{(rows) =>');
  const emptyAction = source.slice(emptyStart, emptyEnd);

  it('bounds its own search to the empty state', () => {
    expect(emptyStart).toBeGreaterThan(-1);
    expect(emptyEnd).toBeGreaterThan(emptyStart);
    // A slice that ran to end of file would swallow the whole page.
    expect(emptyAction.length).toBeLessThan(source.length / 2);
  });

  it('offers the templates before "start from scratch"', () => {
    const picker = source.indexOf('<TemplatePicker');
    const scratch = source.indexOf('Start from scratch');

    expect(picker).toBeGreaterThan(-1);
    expect(scratch).toBeGreaterThan(-1);
    expect(picker).toBeLessThan(scratch);
  });

  /**
   * ⚠️ Demoted, never removed — one click still reaches an empty set.
   *
   * The button is matched as a whole rather than by `variant="outline"` alone:
   * that attribute appears six times in this file, so on its own it proves
   * nothing about *this* button.
   */
  it('still offers a blank canvas, as the secondary choice', () => {
    // `[\s\S]*?` rather than `[^>]*`: the button's own `onClick={() => …}`
    // contains a `>`, so a negated-`>` class stops inside the attribute.
    expect(emptyAction).toMatch(/<Button\s+variant="outline"[\s\S]*?>\s*Start from scratch/);
  });

  /**
   * The header button re-offered the blank canvas *above* the empty state, which
   * is where the contradiction actually lived. It must be conditional on the
   * tenant already having a set.
   */
  it('hides the header button until the tenant has at least one set', () => {
    const header = source.slice(0, source.indexOf('<AsyncState'));

    expect(header).toMatch(/sets\.data[^)]*\)\.length > 0/);
  });
});

/**
 * A1 — the store list has three states, and the page must not collapse them.
 *
 * 🔴 **The defect:** `stores` and `sets` are independent queries and `AsyncState`
 * gates only on `sets`, so an empty set list renders while the store list is
 * still in flight. Reading `(stores.data ?? []).length === 0` treats that moment
 * as "no stores" and tells a merchant who *does* have one to go and connect it.
 *
 * Both surfaces that need a store had this: the template picker and `NewSetForm`.
 */
describe('the page distinguishes "no stores" from "not yet known"', () => {
  const raw = readFileSync(join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'), 'utf8');

  /**
   * ⚠️ **Comments are stripped before anything is asserted.**
   *
   * The first draft of the assertion below failed against this very file: the
   * comment explaining why `(stores.data ?? []).length === 0` was wrong *contains*
   * that string, so a guard reading raw source declared the defect still present.
   * A contract about code must read code.
   */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('derives a three-state answer from the store query', () => {
    expect(source).toMatch(/storeState[\s\S]*?'unknown'[\s\S]*?'none'[\s\S]*?'some'/);
  });

  /** `undefined` is the unresolved case, and must be tested before length. */
  it('treats an unresolved store query as unknown, not as empty', () => {
    expect(source).toMatch(/stores\.data === undefined \? 'unknown'/);
  });

  it('gates the template picker on that state rather than on a defaulted array', () => {
    const helper = source.slice(
      source.indexOf('function templateUnavailable'),
      source.indexOf('function NewSetForm'),
    );

    expect(helper).toMatch(/storeState === 'none'/);
    // The defaulted-array test is what produced the wrong message.
    expect(helper).not.toMatch(/\(stores\.data \?\? \[\]\)\.length === 0/);
  });

  /** Every placement must use that one helper rather than re-deciding locally. */
  it('uses the shared reason at every picker', () => {
    const calls = source.match(/unavailable=\{templateUnavailable\(storeState\)\}/g) ?? [];

    // The empty state's, and the header's (ADR-096).
    expect(calls).toHaveLength(2);
  });

  /**
   * `NewSetForm` had the identical flaw and predates the picker — it is fixed in
   * the same way rather than left as the one screen that still misreports.
   */
  it('gates the blank-canvas form on that state too', () => {
    const form = source.slice(source.indexOf('function NewSetForm'));

    expect(form).toMatch(/storeState === 'unknown'/);
    expect(form).toMatch(/storeState === 'none'/);
    expect(form).not.toMatch(/if \(stores\.length === 0\)/);
  });
});

/**
 * Where a template takes the merchant, and where it stays reachable (M20b.4).
 */
describe('templates are a route somewhere, and not only a first-run one', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * 🔴 **This was `onSuccess: refresh`** — the same handler the blank-canvas form
   * uses — so choosing a template left the merchant on the list they started on,
   * with a new row to find and click.
   *
   * That undercut the milestone's own claim: a template is "the fastest route to
   * a published option" only because the merchant lands in a **populated** editor
   * and learns by seeing one. Landing back on a list teaches nothing and costs a
   * click more than the blank canvas it was meant to beat.
   */
  it('opens the set a template created', () => {
    const handler = source.slice(source.indexOf('const fromTemplate'));
    const body = handler.slice(0, handler.indexOf('\n  });'));

    expect(body).toMatch(/router\.push\(`\/option-sets\/\$\{created\.id\}`\)/);
  });

  /** 📌 And still refreshes the list the merchant will come back to. */
  it('refreshes the list as well as navigating', () => {
    const handler = source.slice(source.indexOf('const fromTemplate'));
    const body = handler.slice(0, handler.indexOf('\n  });'));

    expect(body).toMatch(/refresh\(\)/);
  });

  /**
   * ADR-096 — the picker lived only inside `EmptyState`, so a merchant who made
   * one blank set could never find a template again.
   */
  it('offers templates from the header once a set exists', () => {
    expect(source).toMatch(/New from template/);
  });

  /**
   * ⚠️ **The header action must not appear on a first run.** ADR-087 gives that
   * screen to the empty state, and a second template entry point above it would
   * be the clutter that decision removed.
   */
  it('keeps the header actions behind the same first-run condition', () => {
    const header = source.slice(0, source.indexOf('<AsyncState'));
    const gate = header.indexOf("(sets.data ?? []).length > 0");

    expect(gate).toBeGreaterThan(-1);
    expect(header.indexOf('New from template')).toBeGreaterThan(gate);
    expect(header.indexOf('New option set')).toBeGreaterThan(gate);
  });
});

/**
 * The two create flows are alternatives, not layers (H3).
 */
describe('choosing one create flow closes the other', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/option-sets/page.tsx'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  /**
   * ⚠️ `pickingTemplate` used to survive the switch, so a merchant who opened
   * templates, chose the blank canvas instead, and then cancelled the form was
   * returned to the picker they had already left.
   */
  it('closes the template picker when the blank canvas opens', () => {
    const header = source.slice(0, source.indexOf('<AsyncState'));
    const button = header.slice(header.indexOf('New option set') - 400);

    expect(button).toMatch(/setPickingTemplate\(false\)/);
  });

  /** 📌 And the template panel still never renders beside the form. */
  it('never renders both panels at once', () => {
    expect(source).toMatch(/\{pickingTemplate && !creating \?/);
  });
});

