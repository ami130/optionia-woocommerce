import Link from 'next/link';

import {
  ACTIVATION_STEPS,
  STEP_ACTIONS,
  STEP_LABELS,
  isSetupStep,
  type ActivationStep,
  type TenantActivation,
} from '@/lib/activation/api';
import type { UiCapability } from '@/lib/auth/capabilities';
import { cn } from '@/lib/utils';

/**
 * Where a merchant stands in the activation funnel (M20b.1).
 *
 * A **presentational** component: it takes the activation state and renders it,
 * so the same view serves the dashboard now and M20b.2's dismissible checklist
 * later without either owning the fetch.
 *
 * ⚠️ **Setup and value-realized steps are separated, not concatenated.** The last
 * two steps are things a *customer* does; listing them among the merchant's todo
 * items asks them to tick a box they cannot reach. They are shown as an outcome
 * instead, and only once the merchant has published — before that they are noise.
 */
export function ActivationProgress({
  activation,
  canAct,
  className,
}: {
  activation: TenantActivation;
  /**
   * Whether the signed-in member holds a capability.
   *
   * 🔴 **Passed in rather than read here, and not optional.** All five tenant
   * roles hold `analytics:view`, which is what gates the funnel — so `viewer`
   * and `billing` reach this checklist, and neither can connect a store, create
   * a set or publish. `billing` cannot even *view* stores or option sets, so a
   * link would land it on a `403`.
   *
   * A required prop rather than a defaulted one: a component that quietly
   * assumed "yes" would put that `403` back the first time a caller forgot.
   */
  canAct: (capability: UiCapability) => boolean;
  className?: string;
}) {
  const reached = new Map(activation.steps.map((s) => [s.step, s.reached]));
  const setupSteps = ACTIVATION_STEPS.filter(isSetupStep);
  const done = setupSteps.filter((s) => reached.get(s)).length;

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium">Setup</h2>
        <p className="text-muted-foreground text-sm" aria-live="polite">
          {done} of {setupSteps.length} complete
        </p>
      </div>

      <ol className="space-y-1">
        {setupSteps.map((step) => (
          <StepRow
            key={step}
            step={step}
            canAct={canAct}
            reached={reached.get(step) === true}
            /**
             * Exactly one row is "current", and it is `nextStep` — the earliest
             * gap, which the API decides. Marking the first unreached row here
             * instead would duplicate that rule in a second place and let the two
             * disagree.
             */
            current={activation.nextStep === step}
          />
        ))}
      </ol>

      {activation.activated ? (
        <div className="space-y-1 border-t pt-4">
          <h2 className="text-sm font-medium">Since you published</h2>
          <ol className="space-y-1">
            {ACTIVATION_STEPS.filter((s) => !isSetupStep(s)).map((step) => (
              <StepRow
                key={step}
                step={step}
                canAct={canAct}
                reached={reached.get(step) === true}
                current={false}
              />
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function StepRow({
  step,
  reached,
  current,
  canAct,
}: {
  step: ActivationStep;
  reached: boolean;
  current: boolean;
  canAct: (capability: UiCapability) => boolean;
}) {
  const action = STEP_ACTIONS[step];

  /**
   * Whether to offer the action at all.
   *
   * Three reasons not to, and they are different things:
   *
   * - **Already done.** Nothing to do; the tick is the whole message.
   * - **No action exists** (`synced`, and the two customer steps) — a state the
   *   merchant waits on rather than a task they perform (ADR-091).
   * - **The role cannot do it.** A `viewer` sees the checklist and must not be
   *   sent to a screen that refuses them.
   */
  const offer =
    !reached && action !== null && (action.capability === null || canAct(action.capability));

  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-md px-2 py-1.5 text-sm',
        current && 'bg-muted font-medium',
      )}
      /**
       * The tick is decorative; the state is announced in text instead, so a
       * screen reader is not left to infer completion from a glyph.
       */
      aria-current={current ? 'step' : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border text-xs',
          reached && 'border-transparent bg-primary text-primary-foreground',
        )}
      >
        {reached ? '✓' : ''}
      </span>
      <span className={cn(!reached && !current && 'text-muted-foreground')}>
        {STEP_LABELS[step]}
      </span>
      <span className="sr-only">{reached ? '(done)' : current ? '(next step)' : '(not started)'}</span>

      {offer && action !== null ? (
        /*
         * `ml-auto` rather than a grid: the label is the row's content and the
         * action is an affordance beside it, so it sits at the end whatever the
         * label's length.
         */
        <Link
          href={action.href}
          className="ml-auto shrink-0 text-xs underline"
          /*
           * ⚠️ **The visible words repeat across rows.** "Publish", "Assign" and
           * "Create one" say nothing on their own, and a screen reader listing
           * the page's links reads eight of them with no way to tell which step
           * each belongs to. The accessible name carries the step; the visible
           * one stays short because the row beside it already gives the context
           * a sighted reader needs.
           *
           * Same treatment as `aria-label={`Select ${product.name}`}` in the
           * product picker, for the same reason.
           */
          aria-label={`${action.label}: ${STEP_LABELS[step]}`}
        >
          {action.label}
        </Link>
      ) : null}
    </li>
  );
}
