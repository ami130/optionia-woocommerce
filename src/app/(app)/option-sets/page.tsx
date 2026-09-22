'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { useSession } from '@/components/providers/session-provider';
import {
  AsyncState,
  ConflictAwareError,
  EmptyState,
  ErrorState,
  LoadingRows,
} from '@/components/layout/states';
import { AuthForm, Field } from '@/components/forms/auth-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TemplatePicker } from '@/components/option-sets/option-set-display';
import { HelpNote } from '@/components/help/help-note';
import { invalidateActivation } from '@/lib/activation/cache';
import { HELP } from '@/lib/help/concepts';
import { roleCan } from '@/lib/auth/capabilities';
import {
  createSet,
  deleteSet,
  duplicateSet,
  importSet,
  listSets,
  updateSet,
  type OptionSetSummary,
} from '@/lib/option-sets/api';
import {
  createSetSchema,
  renameSetSchema,
  type CreateSetInput,
} from '@/lib/schemas/option-sets';
import { STARTER_TEMPLATES, templateDocument } from '@/lib/option-sets/templates';
import { listStores, type StoreSummary } from '@/lib/stores/api';
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
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [pickingTemplate, setPickingTemplate] = useState(false);

  const canEdit = roleCan(me?.role, 'option_sets:edit');
  const canDelete = roleCan(me?.role, 'option_sets:delete');

  const stores = useQuery({ queryKey: ['stores'], queryFn: listStores });
  const sets = useQuery({ queryKey: ['option-sets'], queryFn: () => listSets() });

  /**
   * Whether this tenant has a store, or whether we do not yet know.
   *
   * Three states, not two. A template and a new option set both need a store,
   * and both screens previously read an unresolved query as "no stores" — so a
   * merchant with a connected store was told to go and connect one while their
   * store list was still loading.
   */
  const storeState: 'unknown' | 'none' | 'some' =
    stores.data === undefined ? 'unknown' : stores.data.length === 0 ? 'none' : 'some';

  /**
   * Creating, importing or deleting a set moves the funnel's `created` step, so
   * the dashboard checklist is refreshed alongside this screen's own list
   * (`invalidateActivation`). Without it the checklist says "create your first
   * option set" for thirty seconds after the merchant created one.
   */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['option-sets'] });
    invalidateActivation(queryClient);
  };

  /**
   * Which store each set belongs to.
   *
   * 🔴 The list is unfiltered, so a tenant with two stores sees both catalogues
   * merged — and two sets named "Hoodie options" were indistinguishable. Shown
   * only when there is more than one store: with a single store the label is
   * noise on every row.
   */
  /**
   * Build a set from a starter template (M20.7).
   *
   * 🔴 **Through the IMPORT endpoint**, so a template and a merchant's own file
   * take one path — one transaction, and every rule the import enforces applies
   * to a template automatically.
   *
   * ⚠️ **Into the merchant's first store**, because this only appears when they
   * have no sets at all: the empty state is the first-run screen, and a store
   * picker there is a question before they have seen what a set is. A merchant
   * with several stores can copy it across afterwards.
   */
  const fromTemplate = useMutation({
    mutationFn: (id: string) => {
      const template = STARTER_TEMPLATES.find((candidate) => candidate.id === id);
      const storeId = (stores.data ?? [])[0]?.id;

      if (template === undefined || storeId === undefined) {
        /*
         * 🔴 **This was documented as unreachable, and was not.** The claim was
         * that "the empty state needs a connected store to have got this far" —
         * but the store guard lives in `NewSetForm`, the *blank canvas* form,
         * and the picker never passed through it. A merchant with no connected
         * store saw four clickable cards and got this rejection on every one.
         *
         * The funnel proves that merchant is real: more tenants have created an
         * option set than have a connected store. The picker is now told it is
         * `unavailable` and says so in place of the cards, so this branch is a
         * backstop rather than the path a merchant actually walks.
         */
        return Promise.reject(new Error('Connect a store before using a template.'));
      }

      return importSet(storeId, templateDocument(template) as unknown as Record<string, unknown>);
    },
    /**
     * 🔴 **Into the editor, not back to the list** (M20b.4).
     *
     * This used to be `onSuccess: refresh` — the same handler the blank-canvas
     * form uses — so a merchant chose "T-shirt printing", the import succeeded,
     * and they were left looking at the list they started on, with a new row to
     * find and click.
     *
     * That undercut the milestone's own claim. A template is *"the fastest route
     * to a published option"* only because the merchant lands in a **populated**
     * editor and learns by seeing one; landing back on a list teaches nothing and
     * costs a click more than the blank canvas it was meant to beat.
     *
     * 📌 The list is still invalidated: the merchant will come back to it, and a
     * stale list would be missing the set they just made.
     */
    onSuccess: (created) => {
      refresh();
      router.push(`/option-sets/${created.id}`);
    },
  });

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

          {/*
            🔴 **In the header, not the empty state** (ADR-098). The hierarchy was
            already explained — and only where a merchant has *no* sets, so it
            vanished the moment they had one. "What is the difference between a
            group and an option?" is asked while building the second one.
          */}
          <HelpNote concept={HELP.hierarchy} className="pt-1" />
        </div>

        {/*
          * Hidden while the tenant has no sets at all (ADR-087): the empty state
          * below is leading that merchant through their first run, and a "New
          * option set" button above it re-offers the blank canvas as the primary
          * action — which is the contradiction ADR-087 resolves. It returns as
          * soon as one set exists.
          */}
        {canEdit && !creating && (sets.data ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {/*
              * 🔴 **Templates stay reachable after the first run** (ADR-096).
              *
              * ADR-087 decided templates *lead* the first run and said nothing
              * about afterwards — and the answer that fell out was "nothing":
              * the picker lives inside the empty state, so a merchant who made
              * one blank set could never find a template again. "Add gift wrap"
              * is far more likely on a second set than a first.
              *
              * ⚠️ **Beside the create button, not inside its form.** A store
              * picker and a name field are questions; a template is an answer.
              * Putting templates inside the blank-canvas form would make a
              * merchant start the wrong flow to find the right one.
              */}
            <Button variant="outline" onClick={() => setPickingTemplate((open) => !open)}>
              {pickingTemplate ? 'Cancel' : 'New from template'}
            </Button>

            {/*
              ⚠️ **Closes the template picker on the way in.** The two panels are
              alternatives, and `pickingTemplate` used to survive the switch — so
              a merchant who opened templates, chose the blank canvas instead, and
              then cancelled the form was returned to the picker they had left.
            */}
            <Button
              onClick={() => {
                setPickingTemplate(false);
                setCreating(true);
              }}
            >
              New option set
            </Button>
          </div>
        ) : null}
      </div>

      {pickingTemplate && !creating ? (
        <Card>
          <CardContent className="space-y-4 pt-6">
            {/*
              The same picker the empty state uses, with the same store guard —
              one component, so the two placements cannot drift into offering
              different templates or disagreeing about when one can be used.
            */}
            <TemplatePicker
              templates={STARTER_TEMPLATES.map((template) => ({
                id: template.id,
                name: template.name,
                description: template.description,
              }))}
              busy={fromTemplate.isPending}
              unavailable={templateUnavailable(storeState)}
              onChoose={(id: string) => fromTemplate.mutate(id)}
            />

            {fromTemplate.error === null || fromTemplate.error === undefined ? null : (
              <ErrorState error={fromTemplate.error} />
            )}
          </CardContent>
        </Card>
      ) : null}

      {creating ? (
        <Card>
          <CardContent className="pt-6">
            <NewSetForm
              stores={stores.data ?? []}
              storeState={storeState}
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
                <div className="space-y-4">
                  {/*
                    * 🔴 **Templates lead the first run (ADR-087).** A merchant who
                    * does not yet know what "option group" means is not taught by
                    * an empty screen, which is M20b.4's argument — so on a tenant
                    * with no sets at all, the templates come first and "start from
                    * scratch" is the secondary choice below them.
                    *
                    * ⚠️ **Demoted, never removed.** The earlier code put the blank
                    * button above the picker; the spec said "never a blank canvas".
                    * Both were deliberate and they contradicted each other. The
                    * resolution is order, not deletion: a merchant who knows what
                    * they want still reaches an empty set in one click, and is not
                    * made to delete a template first.
                    *
                    * 📌 **Built through the IMPORT endpoint**, so a template and
                    * a merchant's own file take one path: one transaction, and
                    * every rule the import enforces applies to a template too.
                    */}
                  <TemplatePicker
                    templates={STARTER_TEMPLATES.map((template) => ({
                      id: template.id,
                      name: template.name,
                      description: template.description,
                    }))}
                    busy={fromTemplate.isPending}
                    /*
                     * An option set belongs to a store, so a template cannot be
                     * imported without one. Said here rather than discovered by
                     * clicking a card that always fails.
                     *
                     * 🔴 **`storeState` distinguishes "none" from "not yet known".**
                     * `stores` and `sets` are independent queries and `AsyncState`
                     * gates only on `sets`, so an empty set list can render while
                     * the store list is still in flight. Testing
                     * `(stores.data ?? []).length === 0` reads that in-flight
                     * moment as "no stores" and tells a merchant who *does* have
                     * one to go and connect it — the wrong message, shown to the
                     * merchant who did everything right.
                     *
                     * `undefined` means unknown; only a settled empty array means
                     * none. The same distinction `AsyncState` itself draws.
                     */
                    unavailable={templateUnavailable(storeState)}
                    onChoose={(id: string) => fromTemplate.mutate(id)}
                  />

                  {fromTemplate.error === null || fromTemplate.error === undefined ? null : (
                    <ErrorState error={fromTemplate.error} />
                  )}

                  <Button variant="outline" onClick={() => setCreating(true)}>
                    Start from scratch
                  </Button>
                </div>
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
                  stores={stores.data ?? []}
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

/**
 * Why a template cannot be used right now, or null when it can.
 *
 * 📌 **One function, three call sites.** The empty state, the header picker and
 * `NewSetForm` all need the same answer, and three copies of it is how two of
 * them end up saying different things about the same tenant.
 *
 * ⚠️ `unknown` is not `none`: an unresolved store query must not be reported as
 * "you have no stores", which is what told merchants with a connected store to
 * go and connect one.
 */
function templateUnavailable(storeState: 'unknown' | 'none' | 'some'): ReactNode {
  if (storeState === 'none') {
    return (
      <>
        Connect a store first — an option set belongs to one.{' '}
        <Link href="/stores" className="underline">
          Go to stores
        </Link>
      </>
    );
  }

  if (storeState === 'unknown') {
    /* Neither offer nor refuse until the answer arrives. */
    return <span className="text-muted-foreground text-sm">Checking your stores…</span>;
  }

  return null;
}

function NewSetForm({
  stores,
  storeState,
  onCancel,
  onCreated,
}: {
  stores: Array<{ id: string; storeUrl: string }>;
  /**
   * Whether the store list has settled, and what it said.
   *
   * 🔴 **`stores.length === 0` cannot answer this on its own.** The prop arrives
   * as `stores.data ?? []`, so an unresolved query is indistinguishable from a
   * tenant with no stores — and this form told a merchant whose store list was
   * still loading to go and connect one they already had.
   */
  storeState: 'unknown' | 'none' | 'some';
  onCancel: () => void;
  onCreated: () => void;
}) {
  /*
   * A set belongs to a store, and the API requires the id rather than inferring
   * it: a tenant may have several. With exactly one connected the choice is
   * made for the merchant; with none, there is nothing to author against.
   */
  const onlyStore = stores.length === 1 ? stores[0].id : '';

  if (storeState === 'unknown') {
    // Neither offer a form that cannot submit nor claim there is no store.
    return <LoadingRows rows={2} />;
  }

  if (storeState === 'none') {
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

/**
 * ⚠️ **Exported for test** (M20.8). The page renders it directly; nothing else
 * imports it. Copy-to-store cannot be asserted without mounting a row that has
 * more than one store to choose between.
 */
export function SetRow({
  set,
  storeLabel,
  stores,
  canEdit,
  canDelete,
  onChanged,
}: {
  set: OptionSetSummary;
  storeLabel?: string;

  /**
   * Every store this merchant owns — the targets a copy may go to (M20.8).
   *
   * 📌 **The whole list, filtered here rather than by the caller**, because the
   * row is what knows which store it is already in: the set's own store is not
   * a target, it is the plain Duplicate.
   */
  stores: StoreSummary[];

  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);

  /*
   * 🔴 **Only the OTHER stores.** A merchant with one storefront has no choice
   * to make, and a picker listing one option is a question with one answer.
   */
  const targets = stores.filter((store) => store.id !== set.storeId);
  const [target, setTarget] = useState('');

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
    mutationFn: (storeId?: string) => duplicateSet(set.id, undefined, storeId),
    onSuccess: () => {
      setTarget('');
      onChanged();
    },
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
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={duplicate.isPending}
                  onClick={() => duplicate.mutate(undefined)}
                >
                  {duplicate.isPending ? 'Duplicating…' : 'Duplicate'}
                </Button>

                {/*
                  * 🔴 **Shown only when there IS somewhere else to copy to**
                  * ([D5], M20.8). Assignments do not travel — they name
                  * products by external id, which means nothing in another
                  * store — so the copy arrives unassigned, which is honest
                  * rather than broken.
                  */}
                {targets.length === 0 ? null : (
                  <>
                    <label className="sr-only" htmlFor={`copy-to-${set.id}`}>
                      Copy to store
                    </label>
                    <select
                      id={`copy-to-${set.id}`}
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      className="border-input h-8 rounded-md border px-2 text-xs"
                    >
                      <option value="">Copy to…</option>
                      {targets.map((store) => (
                        <option key={store.id} value={store.id}>
                          {store.storeUrl}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={target === '' || duplicate.isPending}
                      onClick={() => duplicate.mutate(target)}
                    >
                      Copy to store
                    </Button>
                  </>
                )}
              </>
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
