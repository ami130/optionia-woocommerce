'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import {
  AsyncState,
  ConflictAwareError,
  EmptyState,
  ErrorState,
} from '@/components/layout/states';
import { AuthForm, Field } from '@/components/forms/auth-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { roleCan } from '@/lib/auth/capabilities';
import {
  createSet,
  deleteSet,
  duplicateSet,
  listSets,
  updateSet,
  type OptionSetSummary,
} from '@/lib/option-sets/api';
import {
  createSetSchema,
  renameSetSchema,
  type CreateSetInput,
} from '@/lib/schemas/option-sets';
import { listStores } from '@/lib/stores/api';
import { cn } from '@/lib/utils';

/**
 * Option sets (M13.4).
 *
 * ⚠️ **Four separate capabilities.** `edit`, `delete`, `publish` and `rollback`
 * are distinct, and an **editor holds only `edit`** — which is the common role
 * here, since authoring is its whole purpose. Offering them a Delete button that
 * answers `403` is the defect the Stage 3 audit found on the store screens.
 */
export default function OptionSetsPage() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const canEdit = roleCan(me?.role, 'option_sets:edit');
  const canDelete = roleCan(me?.role, 'option_sets:delete');

  const stores = useQuery({ queryKey: ['stores'], queryFn: listStores });
  const sets = useQuery({ queryKey: ['option-sets'], queryFn: () => listSets() });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['option-sets'] });

  /**
   * Which store each set belongs to.
   *
   * 🔴 The list is unfiltered, so a tenant with two stores sees both catalogues
   * merged — and two sets named "Hoodie options" were indistinguishable. Shown
   * only when there is more than one store: with a single store the label is
   * noise on every row.
   */
  const storeLabels = new Map((stores.data ?? []).map((store) => [store.id, store.storeUrl]));
  const showStore = (stores.data ?? []).length > 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Option sets</h1>
          <p className="text-muted-foreground text-sm">
            The options your storefront offers, grouped and published together.
          </p>
        </div>

        {canEdit && !creating ? (
          <Button onClick={() => setCreating(true)}>New option set</Button>
        ) : null}
      </div>

      {creating ? (
        <Card>
          <CardContent className="pt-6">
            <NewSetForm
              stores={stores.data ?? []}
              onCancel={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                refresh();
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <AsyncState
        isLoading={sets.isLoading}
        error={sets.error}
        data={sets.data}
        onRetry={() => void sets.refetch()}
        empty={
          <EmptyState
            title="No option sets yet"
            description={
              canEdit
                ? 'An option set holds the choices a customer makes — a finish, a size, an engraving. Create one, add a group and an option, then publish it to your store.'
                : 'Nobody has created an option set in this workspace yet. An owner, admin or editor can make the first one.'
            }
            action={
              canEdit ? (
                <Button onClick={() => setCreating(true)}>Create your first option set</Button>
              ) : (
                <span className="text-muted-foreground text-sm">Ask a teammate to create one.</span>
              )
            }
          />
        }
      >
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((set) => (
              <li key={set.id}>
                <SetRow
                  set={set}
                  storeLabel={showStore ? storeLabels.get(set.storeId) : undefined}
                  canEdit={canEdit}
                  canDelete={canDelete}
                  onChanged={refresh}
                />
              </li>
            ))}
          </ul>
        )}
      </AsyncState>
    </div>
  );
}

function NewSetForm({
  stores,
  onCancel,
  onCreated,
}: {
  stores: Array<{ id: string; storeUrl: string }>;
  onCancel: () => void;
  onCreated: () => void;
}) {
  /*
   * A set belongs to a store, and the API requires the id rather than inferring
   * it: a tenant may have several. With exactly one connected the choice is
   * made for the merchant; with none, there is nothing to author against.
   */
  const onlyStore = stores.length === 1 ? stores[0].id : '';

  if (stores.length === 0) {
    return (
      <Alert>
        <AlertDescription>
          Connect a store first — an option set belongs to one.{' '}
          <Link href="/stores" className="underline">
            Go to stores
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <AuthForm<CreateSetInput>
      schema={createSetSchema}
      defaultValues={{ name: '', storeId: onlyStore }}
      fields={['name', 'storeId']}
      submitLabel="Create"
      pendingLabel="Creating…"
      onSubmit={async (values) => {
        await createSet(values.name, values.storeId);
        onCreated();
      }}
    >
      {(form) => (
        <>
          <Field label="Name" error={form.formState.errors.name?.message}>
            <Input autoFocus placeholder="Hoodie options" {...form.register('name')} />
          </Field>

          {stores.length > 1 ? (
            <Field label="Store" error={form.formState.errors.storeId?.message}>
              <select
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                {...form.register('storeId')}
              >
                <option value="">Choose a store…</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.storeUrl}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </>
      )}
    </AuthForm>
  );
}

function SetRow({
  set,
  storeLabel,
  canEdit,
  canDelete,
  onChanged,
}: {
  set: OptionSetSummary;
  storeLabel?: string;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);

  /**
   * Both writes carry `rowVersion`.
   *
   * 🔴 The API marks it optional and `assertVersionMatches()` only throws when
   * one is *sent* — so omitting it is silent last-write-wins, which the entity's
   * own comment calls "unforgivable in an authoring tool". A `409` here means a
   * colleague changed this set, and reloading is the honest remedy.
   */
  const remove = useMutation({
    mutationFn: () => deleteSet(set.id, set.rowVersion),
    onSuccess: () => {
      setConfirming(false);
      onChanged();
    },
  });

  const duplicate = useMutation({
    mutationFn: () => duplicateSet(set.id),
    onSuccess: onChanged,
  });

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/*
            🔴 `min-w-0` is what lets the name below actually truncate. A flex
            child defaults to `min-width: auto`, so it refuses to shrink past its
            content and `truncate` never engages — the row widens instead. Names
            are merchant text capped at 255 characters with no space required,
            and the plan is explicit that merchants check on phones.
          */}
          <div className="min-w-0 space-y-1">
            {renaming ? (
              <RenameField
                set={set}
                onDone={() => {
                  setRenaming(false);
                  onChanged();
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <Link
                href={`/option-sets/${set.id}`}
                className="block truncate font-medium hover:underline"
              >
                {set.name}
              </Link>
            )}
            <p className="text-muted-foreground text-sm">
              <StatusBadge status={set.status} />
              {set.status === 'published' ? ` · version ${set.version}` : null}
              {/* Only when a tenant has more than one store — see `showStore`. */}
              {storeLabel === undefined ? null : ` · ${storeLabel}`}
            </p>
          </div>

          <div className="flex gap-2">
            {canEdit && !renaming ? (
              <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
                Rename
              </Button>
            ) : null}

            {canEdit ? (
              <Button
                variant="outline"
                size="sm"
                disabled={duplicate.isPending}
                onClick={() => duplicate.mutate()}
              >
                {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
              </Button>
            ) : null}

            {canDelete ? (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            ) : null}
          </div>
        </div>

        {remove.error === null || remove.error === undefined ? null : (
          <ConflictAwareError error={remove.error} />
        )}
        {duplicate.error === null || duplicate.error === undefined ? null : (
          <ErrorState error={duplicate.error} />
        )}

        {!confirming ? null : (
          <Alert variant="destructive">
            <AlertDescription className="space-y-3">
              <p>
                {set.status === 'published'
                  ? 'This set is published. Deleting it stops those options appearing on your storefront.'
                  : 'Delete this option set?'}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? 'Deleting…' : 'Yes, delete'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Rename in place (M13.4).
 *
 * 🔴 **Missing until the Stage 4 audit**, with `updateSet()` and
 * `renameSetSchema` both written and wired to nothing — a named operation absent
 * from the UI while its scaffolding sat beside it.
 *
 * Inline rather than a dialog: renaming is a one-field change on a row that is
 * already on screen, and a modal for it would be more ceremony than the act.
 *
 * `rowVersion` travels with the write. A `409` means a colleague renamed it
 * first, and the field says so rather than silently overwriting them.
 */
function RenameField({
  set,
  onDone,
  onCancel,
}: {
  set: OptionSetSummary;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(set.name);

  const parsed = renameSetSchema.safeParse({ name });

  const rename = useMutation({
    mutationFn: () => updateSet(set.id, set.rowVersion, { name: name.trim() }),
    onSuccess: onDone,
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={name}
          className="h-8 max-w-xs"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && parsed.success && !rename.isPending) {
              rename.mutate();
            }

            if (event.key === 'Escape') {
              onCancel();
            }
          }}
        />
        <Button
          size="sm"
          disabled={!parsed.success || rename.isPending || name.trim() === set.name}
          onClick={() => rename.mutate()}
        >
          {rename.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {parsed.success || name === '' ? null : (
        <p className="text-destructive text-xs">{parsed.error.issues[0].message}</p>
      )}

      {rename.error === null || rename.error === undefined ? null : (
        <ConflictAwareError error={rename.error} />
      )}
    </div>
  );
}

/** Draft or published, visible at a glance — M13.4 asks for exactly this. */
function StatusBadge({ status }: { status: OptionSetSummary['status'] }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'published'
          ? 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {status === 'published' ? 'Published' : status === 'draft' ? 'Draft' : 'Archived'}
    </span>
  );
}
