'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { AuthoringGroup } from '@/lib/option-sets/api';
import { updateGroupDisplay } from '@/lib/option-sets/api';
import { GROUP_LAYOUTS } from '@/lib/schemas/option-sets';

/**
 * How a group is laid out on the storefront.
 *
 * 🔴 **The authoring half of M18.4, and it had to land in the same stage as
 * the rendering half** (ADR-059). `displayType` and `isCollapsible` were
 * stored, accepted by the API and published in the config document since
 * Phase 5 — and settable nowhere, because the editor could only create a group
 * by label and delete it. A field the storefront honours but no merchant can
 * set is the same defect as one nothing reads, arrived at from the other side.
 *
 * ⚠️ **Three layouts, not the API's four** (ADR-063). `stepped` renders as
 * `inline` until its own stage, so offering it would be a choice that silently
 * behaves like another — exactly what ADR-055 and ADR-056 withdrew two rule
 * actions to avoid.
 */
export function GroupLayout({
  group,
  canEdit,
  onChanged,
}: {
  group: AuthoringGroup;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);

  const save = useMutation({
    mutationFn: (changes: { displayType?: string; isCollapsible?: boolean }) =>
      updateGroupDisplay(group.id, changes),
    onSuccess: () => {
      onChanged();
    },
  });

  /*
   * ⚠️ **A group authored elsewhere may name a layout this picker omits.**
   * `stepped` is the case that exists today. Showing its real name rather than
   * silently reading as "Inline" means a merchant who opens such a group can
   * see what it is set to, even though they cannot choose it here.
   */
  const current =
    GROUP_LAYOUTS.find((layout) => layout.value === group.displayType) ?? null;

  if (!canEdit) {
    return (
      <p className="text-muted-foreground text-sm">
        Layout: {current?.label ?? group.displayType}
      </p>
    );
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Layout: {current?.label ?? group.displayType}
      </Button>
    );
  }

  return (
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">How is this group laid out?</legend>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {GROUP_LAYOUTS.map((layout) => {
          const active = layout.value === group.displayType;

          return (
            <button
              key={layout.value}
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate({ displayType: layout.value })}
              aria-pressed={active}
              className={[
                'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition',
                'hover:border-foreground/30 hover:bg-accent/50',
                active
                  ? 'border-foreground/60 bg-accent ring-foreground/20 ring-2'
                  : 'border-border',
              ].join(' ')}
            >
              <span aria-hidden="true" className="text-lg leading-none">
                {layout.icon}
              </span>
              <span className="text-sm font-medium">{layout.label}</span>
              <span className="text-muted-foreground text-xs">{layout.hint}</span>
            </button>
          );
        })}
      </div>

      {/*
       * 🔴 **Offered only for `inline`** (ADR-059). An accordion is already
       * folded and a panel already sets its group apart, so the checkbox would
       * promise something those layouts cannot honour — and the storefront
       * ignores it for them, so a merchant who ticked it would see nothing
       * change and have no way to learn why.
       */}
      {group.displayType !== 'inline' ? null : (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={group.isCollapsible}
            disabled={save.isPending}
            onChange={(event) => save.mutate({ isCollapsible: event.target.checked })}
          />
          Let customers fold this group away
        </label>
      )}

      {save.isError ? (
        <p className="text-destructive text-sm">That change could not be saved. Try again.</p>
      ) : null}

      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Done
      </Button>
    </fieldset>
  );
}
