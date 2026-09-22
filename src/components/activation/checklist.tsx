import {
  ACTIVATION_STEPS,
  isSetupStep,
  type TenantActivation,
} from '@/lib/activation/api';
import type { UiCapability } from '@/lib/auth/capabilities';
import { ErrorState } from '@/components/layout/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ActivationProgress } from './activation-progress';

/**
 * The checklist, and the control that hides it.
 *
 * ## Why dismissal appears only when everything is done (ADR-093)
 *
 * M20b.2 asks for a *"dismissible"* checklist **and** that *"completed steps stay
 * visible"*. Those pull against each other, and the resolution is timing: while
 * any step is outstanding this is the merchant's map, and a dismiss button
 * invites them to hide the one surface telling them what to do next. A merchant
 * who is stuck does not need a way to hide being stuck.
 *
 * Once every setup step is done the ticks are clutter, and that is the case
 * "dismissible" was asking about.
 */
export function Checklist({
  activation,
  canAct,
  dismissed,
  onDismissedChange,
  busy,
  error,
}: {
  activation: TenantActivation;
  canAct: (capability: UiCapability) => boolean;
  dismissed: boolean;
  onDismissedChange: (dismissed: boolean) => void;
  busy: boolean;
  /**
   * Why the last hide-or-show attempt failed, if it did.
   *
   * 🔴 **This had no home at all, and the failure was silent.** The mutation
   * carried no `onError` and nothing rendered its error, so a merchant pressing
   * "Hide this checklist" against a failing API watched the button re-enable and
   * the checklist stay — with nothing to say why, and nothing to retry.
   *
   * Every other mutation in this dashboard renders its error this way
   * (`disconnect`, `fromTemplate`, `duplicate`); this was the one that did not.
   */
  error: unknown;
}) {
  const reached = new Map(activation.steps.map((s) => [s.step, s.reached]));
  const complete = ACTIVATION_STEPS.filter(isSetupStep).every((step) => reached.get(step) === true);

  /**
   * ⚠️ **Dismissal is not a one-way door**, and it un-hides itself.
   *
   * `connected` and `published` ask about *current* state, so a merchant who
   * dismissed a complete checklist and later disconnected their store has an
   * incomplete one again — and must see it. The stored flag stays set; it simply
   * stops applying until they are finished again.
   */
  if (dismissed && complete) {
    return (
      <div className="flex flex-col items-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDismissedChange(false)}>
          Show setup checklist
        </Button>

        {/* A failed *restore* is as silent as a failed hide, and as confusing. */}
        {error === null || error === undefined ? null : <ErrorState error={error} />}
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <ActivationProgress activation={activation} canAct={canAct} />

        {complete ? (
          <div className="space-y-3 border-t pt-4">
            {error === null || error === undefined ? null : <ErrorState error={error} />}

            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onDismissedChange(true)}
              >
                Hide this checklist
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
