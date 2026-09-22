'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { Checklist } from '@/components/activation/checklist';
import { LoadingRows, ErrorState } from '@/components/layout/states';
import { useSession } from '@/components/providers/session-provider';
import { Card, CardContent } from '@/components/ui/card';
import { getActivation, getPreferences, setChecklistDismissed } from '@/lib/activation/api';
import { activationKeys } from '@/lib/activation/cache';
import { roleCan, type UiCapability } from '@/lib/auth/capabilities';

/**
 * The dashboard home: the guided setup checklist (M20b.2).
 *
 * The progress view is a shared component rather than markup on this page,
 * because the funnel (M20b.1) and this checklist must not drift into disagreeing
 * about what "connected" means — they read the same endpoint and render the same
 * steps.
 */
export default function DashboardPage() {
  const { me } = useSession();
  const queryClient = useQueryClient();

  const activation = useQuery({ queryKey: activationKeys.me(), queryFn: getActivation });
  const preferences = useQuery({ queryKey: activationKeys.preferences(), queryFn: getPreferences });

  /**
   * What this member may actually do.
   *
   * 🔴 **All five roles hold `analytics:view`**, which gates the funnel — so a
   * `viewer` and a `billing` member both reach this page. Neither can connect a
   * store or publish, and `billing` cannot even *view* stores or option sets, so
   * an unguarded link would land it on a `403`.
   */
  const canAct = useCallback(
    (capability: UiCapability) => roleCan(me?.role, capability),
    [me?.role],
  );

  const dismiss = useMutation({
    mutationFn: (dismissed: boolean) => setChecklistDismissed(dismissed),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: activationKeys.preferences() });
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          Signed in as {me?.name} ({me?.role}) in {me?.tenant?.name}.
        </p>
      </div>

      {activation.isPending ? (
        <Card>
          <CardContent className="pt-6">
            <LoadingRows rows={4} />
          </CardContent>
        </Card>
      ) : activation.isError || activation.data === undefined ? (
        <Card>
          <CardContent className="pt-6">
            {/*
              A failed funnel read must not read as "you have done nothing".
              Rendering the checklist with no data would show every step
              unticked, which is a false statement about the merchant's account.

              ⚠️ `data === undefined` is checked alongside `isError` rather than
              left to the type narrowing: a query can settle without error and
              still carry no data, and that path would otherwise fall through to
              the populated branch.
            */}
            <ErrorState error={activation.error} onRetry={() => void activation.refetch()} />
          </CardContent>
        </Card>
      ) : (
        <Checklist
          activation={activation.data}
          canAct={canAct}
          /*
           * ⚠️ **Treated as not-dismissed until the preference is known.** The
           * two queries settle independently, and defaulting the other way would
           * flash the checklist away from a merchant who never dismissed it —
           * the same "unresolved reads as a decision" mistake that told merchants
           * with a store to go and connect one.
           */
          dismissed={preferences.data?.checklistDismissedAt != null}
          onDismissedChange={(next) => dismiss.mutate(next)}
          busy={dismiss.isPending}
          error={dismiss.error}
        />
      )}
    </div>
  );
}
