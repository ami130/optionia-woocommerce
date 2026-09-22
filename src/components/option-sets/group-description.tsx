'use client';

import { useMutation } from '@tanstack/react-query';

import type { HistoryEntry } from '@/lib/option-sets/history';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AuthoringGroup } from '@/lib/option-sets/api';
import { updateGroup } from '@/lib/option-sets/api';
import { groupSchema } from '@/lib/schemas/option-sets';

/**
 * A group's help text, shown to the customer above its options.
 *
 * 🔴 **Stored, published and RENDERED since Phase 5 — and settable nowhere.**
 * `createGroup` sends only a label and there was no group edit form, so the
 * paragraph the storefront draws in both template branches could never be
 * filled in. The fourth occurrence in this phase of one defect: a capability
 * built on the server and the storefront with no way for a merchant to reach
 * it (ADR-064).
 *
 * ⚠️ **M18.5 lists "help text" as new work.** It is not — this is it.
 */
export function GroupDescription({
  group,
  canEdit,
  onPatched,
  onRecord,
}: {
  group: AuthoringGroup;
  canEdit: boolean;

  /** 🔴 The updated group, so the caller patches rather than refetches. */
  onPatched: (group: AuthoringGroup) => void;

  /** Record the change so it can be undone (M20.10). */
  onRecord: (entry: HistoryEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(group.description ?? '');

  const parsed = groupSchema.safeParse({ label: group.label, description: draft });
  const issue = parsed.success
    ? null
    : (parsed.error.issues.find((i) => i.path[0] === 'description')?.message ?? null);

  const save = useMutation({
    /*
     * ⚠️ **An emptied box clears the description rather than being ignored.**
     * A merchant removing help text is making a choice, and treating `''` as
     * "no change" would leave text on the storefront they had just deleted.
     */
    mutationFn: () => updateGroup(group.id, { description: draft.trim() }),
    onSuccess: (updated) => {
      setOpen(false);
      onPatched(updated);

      /*
       * ⚠️ **`?? ''` because an emptied box CLEARS the description** — the
       * mutation above says so. The inverse has to send the same shape, or
       * undoing a cleared description would send `null` and leave it cleared.
       */
      const before = group.description ?? '';

      onRecord({
        label: `Help text: ${group.label}`,
        inverse: async () =>
          void onPatched(await updateGroup(group.id, { description: before })),
        replay: async () =>
          void onPatched(await updateGroup(group.id, { description: updated.description ?? '' })),
      });
    },
  });

  if (!canEdit) {
    return group.description === null || group.description === '' ? null : (
      <p className="text-muted-foreground text-sm">{group.description}</p>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {group.description === null || group.description === '' ? null : (
          <p className="text-muted-foreground text-sm">{group.description}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(group.description ?? '');
            setOpen(true);
          }}
        >
          {group.description ? 'Edit help text' : 'Add help text'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={`group-description-${group.id}`}>
        Help text
      </label>
      <Input
        id={`group-description-${group.id}`}
        value={draft}
        placeholder="Shown above this group's options."
        onChange={(event) => setDraft(event.target.value)}
      />

      <p className={issue === null ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}>
        {issue ?? 'Shown to the customer above this group. Leave empty for none.'}
      </p>

      {save.isError ? (
        <p className="text-destructive text-sm">That change could not be saved. Try again.</p>
      ) : null}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={issue !== null || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
