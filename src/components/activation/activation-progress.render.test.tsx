import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ACTIVATION_STEPS, type ActivationStep, type TenantActivation } from '@/lib/activation/api';
import { ActivationProgress } from './activation-progress';

/**
 * What a merchant actually sees of their funnel position (M20b.1).
 *
 * Asserted as rendered output rather than props: the defects that matter here
 * are "the merchant is told they have done something they have not" and "the
 * merchant is asked to do something they cannot", and neither is visible from
 * the component's inputs.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

/** An owner — holds everything, so these tests see the richest rendering. */
const owner = () => true;

/** An activation state with the named steps reached. */
const state = (
  reachedSteps: ActivationStep[],
  overrides: Partial<TenantActivation> = {},
): TenantActivation => {
  const reached = new Set(reachedSteps);
  const steps = ACTIVATION_STEPS.map((step) => ({ step, reached: reached.has(step) }));

  return {
    tenantId: 't-1',
    signedUpAt: '2026-09-01T10:00:00.000Z',
    steps,
    activated: reached.has('published'),
    nextStep: ACTIVATION_STEPS.find((s) => !reached.has(s)) ?? null,
    ...overrides,
  };
};

describe('ActivationProgress', () => {
  it('lists every setup step by its merchant-facing label', () => {
    const output = html(<ActivationProgress activation={state(['signed_up'])} canAct={owner} />);

    expect(output).toContain('Connect your store');
    expect(output).toContain('Create your first option set');
    expect(output).toContain('Publish');
  });

  /**
   * The last two steps are a customer's doing. Before the merchant has published
   * they are unreachable, and showing them as unticked todo items tells the
   * merchant to go and make a stranger buy something.
   */
  it('hides the value-realized steps until the merchant has published', () => {
    const output = html(<ActivationProgress activation={state(['signed_up', 'verified'])} canAct={owner} />);

    expect(output).not.toContain('A customer chooses an option');
    expect(output).not.toContain('An order arrives with options');
  });

  it('shows them once published, under their own heading', () => {
    const activation = state([
      'signed_up',
      'verified',
      'installed',
      'connected',
      'synced',
      'created',
      'assigned',
      'published',
    ]);

    const output = html(<ActivationProgress activation={activation} canAct={owner} />);

    expect(output).toContain('Since you published');
    expect(output).toContain('A customer chooses an option');
  });

  it('counts only setup steps in its progress, not the customer ones', () => {
    const output = html(<ActivationProgress activation={state(['signed_up', 'verified'])} canAct={owner} />);

    // Eight setup steps; `selected` and `ordered` are not part of the count.
    expect(output).toContain('2 of 8 complete');
  });

  it('marks a reached step done and an unreached one not', () => {
    const output = html(<ActivationProgress activation={state(['signed_up'])} canAct={owner} />);

    expect(output).toContain('(done)');
    expect(output).toContain('(not started)');
  });

  /**
   * The current step is whatever the API called `nextStep`, so the rule lives in
   * one place. Here the merchant published but their store is disconnected — the
   * API names `connected`, and the view must highlight that rather than the
   * furthest gap or the first row it finds.
   */
  it('marks the API’s nextStep as current, even when a later step is done', () => {
    const activation = state(
      ['signed_up', 'verified', 'installed', 'created', 'assigned', 'published'],
      { nextStep: 'connected', activated: true },
    );

    const output = html(<ActivationProgress activation={activation} canAct={owner} />);

    expect(output).toContain('aria-current="step"');
    // Exactly one row is current.
    expect(output.match(/aria-current="step"/g)).toHaveLength(1);

    // And it is the connect row, not the sync row that also remains unreached.
    const currentRow = output.slice(output.indexOf('aria-current="step"') - 400);
    expect(currentRow).toContain('Connect your store');
  });

  /**
   * 🔴 **`nextStep` is read, never recomputed.**
   *
   * The previous test cannot prove this on its own: there, the API's `nextStep`
   * and the first locally-unreached step are the same row, so a component that
   * ignored the field entirely still passed. Verified by mutation — replacing
   * `activation.nextStep` with a local "first unreached" scan left it green.
   *
   * Here the two **disagree**: `verified` is unreached but the API names
   * `connected`. That happens whenever the server's rule and a client's guess
   * diverge, and the server's answer is the one that must win.
   */
  it('does not recompute the current step from the rows it was given', () => {
    const activation = state(['signed_up', 'installed'], { nextStep: 'connected' });

    const output = html(<ActivationProgress activation={activation} canAct={owner} />);

    expect(output.match(/aria-current="step"/g)).toHaveLength(1);

    const currentRow = output.slice(output.indexOf('aria-current="step"') - 400);
    expect(currentRow).toContain('Connect your store');
    expect(currentRow).not.toContain('Verify your email');
  });

  it('marks nothing current when every step is done', () => {
    const activation = state([...ACTIVATION_STEPS], { nextStep: null });

    const output = html(<ActivationProgress activation={activation} canAct={owner} />);

    expect(output).not.toContain('aria-current="step"');
    expect(output).toContain('8 of 8 complete');
  });

  /** A funnel with no steps must not claim progress it cannot see. */
  it('reports nothing complete for an empty step list', () => {
    const activation: TenantActivation = {
      tenantId: 't-1',
      signedUpAt: '2026-09-01T10:00:00.000Z',
      steps: [],
      activated: false,
      nextStep: 'signed_up',
    };

    const output = html(<ActivationProgress activation={activation} canAct={owner} />);

    expect(output).toContain('0 of 8 complete');
  });

  /**
   * 🔴 **Not every role that sees this checklist can act on it.**
   *
   * All five tenant roles hold `analytics:view`, which gates the funnel — so a
   * `viewer` and a `billing` member both reach this component. Neither can
   * connect a store or publish, and `billing` cannot even *view* stores or option
   * sets, so an unguarded link lands them on a `403`. That is the exact defect
   * the stores screen records having fixed once already.
   */
  describe('actions are offered only to a member who can perform them', () => {
    /** Nothing reached, so every setup step would offer an action if allowed. */
    const nothingDone = state(['signed_up']);

    it('links a step when the member holds its capability', () => {
      const output = html(<ActivationProgress activation={nothingDone} canAct={() => true} />);

      expect(output).toContain('href="/stores"');
      expect(output).toContain('href="/option-sets"');
    });

    it('renders plain rows when the member holds nothing', () => {
      const output = html(<ActivationProgress activation={nothingDone} canAct={() => false} />);

      // The capability-gated destinations are gone...
      expect(output).not.toContain('href="/option-sets"');
      // ...and the steps themselves are still listed.
      expect(output).toContain('Connect your store');
      expect(output).toContain('Publish');
    });

    /**
     * An `editor` may author but not publish, so the two links must be decided
     * separately — a single "can they do anything?" check would offer both.
     */
    it('offers create but not publish to a member who may only edit', () => {
      const output = html(
        <ActivationProgress
          activation={nothingDone}
          canAct={(capability) => capability === 'option_sets:edit'}
        />,
      );

      const links = output.match(/href="\/option-sets"/g) ?? [];
      // `created` and `assigned` are edit-gated; `published` is not.
      expect(links).toHaveLength(2);
    });

    /** ⚠️ ADR-091 — a sync has no action at all, whatever the role holds. */
    it('offers nothing for the sync step even to an owner', () => {
      const output = html(<ActivationProgress activation={nothingDone} canAct={() => true} />);
      const syncRow = output.slice(output.indexOf('Sync your products'));

      expect(syncRow.slice(0, syncRow.indexOf('</li>'))).not.toContain('<a');
    });

    /** A finished step needs no action — the tick is the whole message. */
    it('offers nothing for a step already done', () => {
      const output = html(
        <ActivationProgress
          activation={state(['signed_up', 'verified', 'installed', 'connected'])}
          canAct={() => true}
        />,
      );

      const connectRow = output.slice(output.indexOf('Connect your store'));
      expect(connectRow.slice(0, connectRow.indexOf('</li>'))).not.toContain('<a');
    });
  });

  /**
   * The visible link text repeats across rows — "Publish", "Assign", "Create
   * one" — so a screen reader listing the page's links reads several with no way
   * to tell which step each belongs to. The accessible name carries the step.
   */
  describe('each action names the step it belongs to', () => {
    const nothingDone = state(['signed_up']);

    it('gives every offered link an accessible name carrying its step', () => {
      const output = html(<ActivationProgress activation={nothingDone} canAct={() => true} />);

      expect(output).toContain('aria-label="Connect: Connect your store"');
      expect(output).toContain('aria-label="Publish: Publish"');
    });

    /** Every link, not merely the two above — a missed one is silent. */
    it('leaves no link without one', () => {
      const output = html(<ActivationProgress activation={nothingDone} canAct={() => true} />);

      const links = output.match(/<a [^>]*>/g) ?? [];
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link).toContain('aria-label=');
      }
    });
  });
});
