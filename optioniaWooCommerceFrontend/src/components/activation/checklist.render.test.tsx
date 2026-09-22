import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ACTIVATION_STEPS, isSetupStep, type ActivationStep, type TenantActivation } from '@/lib/activation/api';
import { Checklist } from './checklist';

/**
 * When the checklist can be hidden (ADR-093).
 *
 * 🔴 **M20b.2 asks for two things that pull against each other**: a
 * *"dismissible"* checklist, and that *"completed steps stay visible — progress
 * is motivating"*. The resolution is timing, and it is the whole of this
 * component's logic, so it is asserted rather than left to a reading of the code.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

const state = (reachedSteps: ActivationStep[]): TenantActivation => {
  const reached = new Set(reachedSteps);

  return {
    tenantId: 't-1',
    signedUpAt: '2026-09-01T10:00:00.000Z',
    steps: ACTIVATION_STEPS.map((step) => ({ step, reached: reached.has(step) })),
    activated: reached.has('published'),
    nextStep: ACTIVATION_STEPS.find((s) => !reached.has(s)) ?? null,
  };
};

/** Every setup step done — the only state in which dismissal is offered. */
const ALL_SETUP = ACTIVATION_STEPS.filter(isSetupStep);

const render = (activation: TenantActivation, dismissed = false, error: unknown = null) =>
  html(
    <Checklist
      activation={activation}
      canAct={() => true}
      dismissed={dismissed}
      onDismissedChange={() => {}}
      busy={false}
      error={error}
    />,
  );

describe('Checklist', () => {
  /**
   * 🔴 **A merchant who is stuck does not need a way to hide being stuck.**
   * While any step is outstanding this is their map, and a dismiss control
   * invites them to hide the one surface telling them what to do next.
   */
  it('offers no way to hide an unfinished checklist', () => {
    const output = render(state(['signed_up', 'verified']));

    expect(output).not.toMatch(/Hide this checklist/);
    // And the steps themselves are still there.
    expect(output).toMatch(/Connect your store/);
  });

  it('offers to hide it once every setup step is done', () => {
    const output = render(state([...ALL_SETUP]));

    expect(output).toMatch(/Hide this checklist/);
  });

  /**
   * ⚠️ The value-realized steps are a *customer's* doing, so they must not hold
   * the dismiss control hostage — a merchant who has published has finished
   * their setup whether or not anyone has bought yet.
   */
  it('does not wait for a customer to buy before offering to hide it', () => {
    const output = render(state([...ALL_SETUP]));

    expect(output).toMatch(/Hide this checklist/);
    // `selected` and `ordered` are both unreached in this state.
    expect(output).toMatch(/Since you published/);
  });

  it('hides the checklist once dismissed, leaving a way back', () => {
    const output = render(state([...ALL_SETUP]), true);

    expect(output).not.toMatch(/Connect your store/);
    expect(output).toMatch(/Show setup checklist/);
  });

  /**
   * 🔴 **Dismissal is not a one-way door, and it un-hides itself.**
   *
   * `connected` and `published` ask about *current* state, so a merchant who
   * dismissed a complete checklist and later disconnected their store has an
   * incomplete one again — and must see it rather than having it stay hidden by
   * a decision they made when everything was fine.
   */
  it('reappears when a completed step stops being true', () => {
    const output = render(state(ALL_SETUP.filter((s) => s !== 'connected')), true);

    expect(output).toMatch(/Connect your store/);
    expect(output).not.toMatch(/Show setup checklist/);
  });

  /**
   * 🔴 **A failed dismissal used to be silent.**
   *
   * The mutation carried no `onError` and nothing rendered its error, so a
   * merchant pressing "Hide this checklist" against a failing API watched the
   * button re-enable and the checklist stay — with nothing to say why. Every
   * other mutation in this dashboard reports its failure (`disconnect`,
   * `fromTemplate`, `duplicate`); this was the one that did not.
   */
  describe('a failed hide or show says so', () => {
    it('reports an error raised while hiding', () => {
      const output = render(state([...ALL_SETUP]), false, new Error('nope'));

      expect(output).toMatch(/That did not work/);
      // And the control is still there to try again.
      expect(output).toMatch(/Hide this checklist/);
    });

    it('reports an error raised while showing it again', () => {
      const output = render(state([...ALL_SETUP]), true, new Error('nope'));

      expect(output).toMatch(/That did not work/);
      expect(output).toMatch(/Show setup checklist/);
    });

    it('says nothing when there is no error', () => {
      const output = render(state([...ALL_SETUP]));

      expect(output).not.toMatch(/That did not work/);
    });
  });
});
