'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { GroupDescription } from '@/components/option-sets/group-description';
import {
  FindingList,
  HistoryControls,
  PortablePanel,
  PricingExample,
  UnpublishedChangesNotice,
  VersionHistory,
} from '@/components/option-sets/option-set-display';
import { GroupLayout } from '@/components/option-sets/group-layout';
import { OptionPreview } from '@/components/option-sets/option-preview';
import { RulesPanel } from '@/components/option-sets/rules-panel';
import { SetPreview } from '@/components/option-sets/set-preview';
import { listProducts } from '@/lib/products/api';
import { ProductPicker } from '@/components/products/product-picker';
import { useSession } from '@/components/providers/session-provider';
import {
  AsyncState,
  ConflictAwareError,
  ErrorState,
  FullPageLoading,
} from '@/components/layout/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { roleCan } from '@/lib/auth/capabilities';
import type { HistoryEntry } from '@/lib/option-sets/history';
import {
  optionPricingKinds,
  parseOptionPricing,
  readOptionPricing,
  type OptionPricingKind,
} from '@/lib/option-sets/option-pricing';
import { deriveDisplay } from '@/lib/option-sets/option-display';
import {
  optionValidationKind,
  parseOptionValidation,
  readOptionValidation,
} from '@/lib/option-sets/option-validation';
import { parsePortable } from '@/lib/option-sets/portable-import';
import { toPortable } from '@/lib/option-sets/portable';
import { parseTextRules, readTextRules } from '@/lib/option-sets/text-rules';
import { parseTiers, readTiers, type TierRow } from '@/lib/option-sets/tiers';
import {
  parsePastedValues,
  type PasteProblem,
  type PastedValue,
} from '@/lib/option-sets/paste-values';
import { SAMPLE_BASE_MINOR, sampleLines } from '@/lib/option-sets/sample-total';
import {
  invalidateAfterEdit,
  invalidateAfterPublish,
  optionSetKeys,
  patchTree,
  replaceGroupInTree,
  replaceItemInTree,
  replaceOptionInTree,
  replaceValueInTree,
} from '@/lib/option-sets/cache';
import { HelpNote } from '@/components/help/help-note';
import { invalidateActivation } from '@/lib/activation/cache';
import { HELP } from '@/lib/help/concepts';
import { useHistory } from '@/lib/hooks/use-history';
import {
  confirmGroupSwitch,
  setOptionFormDirty,
  setValueDirty,
  useUnsavedGuard,
} from '@/lib/hooks/use-unsaved-guard';
import { formatAmount, parseAmount } from '@/lib/money/money';
import { formatBasisPoints, parsePercent } from '@/lib/money/percent';
import {
  createGroup,
  createItem,
  createOption,
  createValue,
  deleteGroup,
  deleteItem,
  deleteOption,
  deleteValue,
  unpublishedChanges,
  loadSet,
  listVersions,
  publishCheck,
  publishSet,
  rollbackTo,
  reorderGroups,
  reorderItems,
  reorderOptions,
  importSet,
  loadSetVersion,
  updateGroup,
  updateItem,
  updateOption,
  updateValue,
  type AuthoringGroup,
  type AuthoringItem,
  type AuthoringOption,
  type AuthoringValue,
  type AuthoringSet,
  type ItemKind,
} from '@/lib/option-sets/api';
import {
  groupReorderPayload,
  mergedEntries,
  reorderPayloads,
  sortOrderFor,
} from '@/lib/option-sets/entries';
import {
  AUTHORABLE_TYPES,
  COLUMN_CHOICES,
  MAX_SELECTION_BOUND,
  MAX_TOOLTIP,
  PRICE_FRAMINGS,
  SWATCH_SIZES,
  acceptsColumns,
  acceptsLength,
  acceptsManyAnswers,
  configFor,
  acceptsSwatchSize,
  boundsContradict,
  optionFormSchema,
  type OptionFormValues,
  layoutFor,
  mergeConfig,
  presentationFor,
  priceFramingFor,
  selectionBoundsFor,
  swatchSizeFor,
  keyFromLabel,
  optionSchema,
  swatchFieldsFor,
  takesGroupLabel,
  takesValues,
  valueSchema,
} from '@/lib/schemas/option-sets';

/**
 * The minimal option editor (M13.5).
 *
 * ## One load, targeted writes
 *
 * `GET /:id/detail` returns the whole tree — set → groups → options → values —
 * and carries `rowVersion`. So this screen loads once and each write is a small
 * request against the piece it changed, rather than a waterfall per level.
 *
 * ## `rowVersion` travels with every set-level write
 *
 * 🔴 The API marks it optional, and `assertVersionMatches()` only throws when a
 * version is **sent** — so omitting it is silent last-write-wins, which the
 * entity's own comment calls *"unforgivable in an authoring tool"*. It is
 * required in this module's call signatures for that reason.
 *
 * ⚠️ **Groups, options and values have no version of their own.** A concurrent
 * edit *inside* a set is last-write-wins by construction, and this screen does
 * not pretend otherwise — the conflict notice names the set, which is the only
 * thing actually protected.
 */
export default function OptionSetEditorPage() {
  const params = useParams<{ id: string }>();
  const setId = params.id;
  const { me } = useSession();
  const queryClient = useQueryClient();

  const canEdit = roleCan(me?.role, 'option_sets:edit');
  const canPublish = roleCan(me?.role, 'option_sets:publish');

  const query = useQuery({ queryKey: ['option-set', setId], queryFn: () => loadSet(setId) });

  /**
   * Undo and redo for this editing session (M20.10).
   *
   * ⚠️ **Declared above the reload callbacks that clear it.** Both are arrows
   * invoked later, so a lower declaration would work — but depending on that is
   * the kind of ordering nobody re-checks when the file is next edited.
   */
  const history = useHistory();

  /**
   * What a refused undo or redo tells the merchant.
   *
   * 🔴 **`void history.undo()` DISCARDED the rejection.** The log's own test
   * asserts that undo rejects when the server refuses, and the page threw that
   * away — the entry stayed (correctly, so it can be retried), the button
   * re-enabled, and nothing said anything. Silence is the worst outcome here
   * because a successful undo also leaves the button looking ready.
   */
  const [historyError, setHistoryError] = useState<string | undefined>(undefined);

  /*
   * 🔴 **Two channels, because they mean different things.** A single list
   * rendered a valid file's summary in `text-destructive` — success reported as
   * failure, because one prop carried both meanings.
   */
  const [importProblems, setImportProblems] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState<string | undefined>(undefined);

  const runHistory = async (step: () => Promise<void>) => {
    setHistoryError(undefined);

    try {
      await step();
    } catch (error) {
      setHistoryError(
        error instanceof Error && error.message !== ''
          ? `That could not be undone — ${error.message}`
          : 'That could not be undone. Try again.',
      );
    }
  };
  /*
   * 🔴 **Narrowed in M20.10's groundwork.** This invalidated the bare prefix
   * `['option-set', setId]`, which took its three siblings with it — the
   * publish-check, the published history, and the draft-versus-live comparison
   * that costs two full-document fetches by itself. Five requests per edit,
   * three of them whole documents, from twenty-nine call sites.
   *
   * `invalidateAfterEdit` refreshes the tree and the one sibling an edit really
   * changes. See `lib/option-sets/cache.ts` for which, and why.
   */
  const reload = () => {
    invalidateAfterEdit(queryClient, setId);

    /*
     * 🔴 **A shape change ENDS the undo log, and this is the only place that
     * has to remember it.** `reload` is what every create, delete and reorder
     * already calls; wiring the four delete sites individually would leave the
     * fifth — added later — to be remembered by whoever adds it.
     *
     * Undoing across a delete would `PATCH` a soft-deleted row: `findOne`
     * throws `notFound`, so the merchant would meet a **404** where they
     * expected their edit back. `history.ts` claimed this was handled before it
     * was, which is worse than not claiming it — the docblock read as a
     * guarantee.
     *
     * ⚠️ **Creates and reorders clear it too**, deliberately. An entry recorded
     * against a tree whose ordering has since changed can still *succeed* and
     * put the wrong thing back, which is harder to notice than a 404.
     */
    history.clear();
  };

  /**
   * Refresh after a **reorder** — a shape change the log CAN survive.
   *
   * 🔴 **The reorder endpoints write the COMPLETE ordering by id**, not a
   * relative move, so the inverse is the previous ordering and stays valid
   * whatever else changed since. That is exactly what a create or a delete
   * cannot promise, which is why those clear the log and this does not.
   *
   * ⚠️ **The first version of this fix cleared on every shape change**, which
   * would have recorded a reorder and erased it in the same handler — two fixes
   * contradicting each other, caught by writing the test before the code.
   */
  const reorderChanged = () => invalidateAfterEdit(queryClient, setId);

  /*
   * 🔴 **A publish needs the BROAD refresh, and narrowing it would have made
   * the history stale.** Publishing moves the version, writes a history row and
   * settles the draft-versus-live question — so everything about the set really
   * has changed. It happens once, not once per keystroke, which is what makes
   * the cost acceptable here and not above.
   */
  const reloadAfterPublish = () => {
    invalidateAfterPublish(queryClient, setId);

    /*
     * 🔴 **Publish IS activation.** `published` is the funnel step the whole of
     * Phase 20b is built to reach, so leaving the dashboard checklist stale here
     * is the worst case of the staleness: a merchant completes the thing the
     * product measures and is told they have not. Rollback routes through here
     * too, and can move a set back out of `published`.
     */
    invalidateActivation(queryClient);

    /*
     * 🔴 **The log clears at a publish.** Undoing *through* one is rollback,
     * which M20.9 already built and which operates on published versions rather
     * than editor operations. Leaving entries undoable across a publish would
     * let "Undo" appear to revert what a storefront is currently serving.
     */
    history.clear();
  };

  /*
   * 🔴 **An edit in place patches the cache; it does not refetch the tree.**
   *
   * Every update endpoint answers with the entity it changed, so refetching the
   * whole set afterwards discards data the server just sent and asks for it
   * again. `patchTree` applies the response instead — one request per edit
   * becomes zero.
   *
   * ⚠️ **Only for edits in place.** Creates, deletes and reorders change the
   * tree's *shape* and still go through `reload`; reproducing an ordering or a
   * parent change by hand is where a cache and a database quietly diverge.
   */
  const patch: TreePatch = {
    option: (option) =>
      patchTree(queryClient, setId, (current) => replaceOptionInTree(current, option)),
    value: (value) =>
      patchTree(queryClient, setId, (current) => replaceValueInTree(current, value)),
    group: (group) =>
      patchTree(queryClient, setId, (current) => replaceGroupInTree(current, group)),
    item: (item) => patchTree(queryClient, setId, (current) => replaceItemInTree(current, item)),
    record: history.record,
  };

  if (query.isLoading) {
    return <FullPageLoading />;
  }

  if (query.error !== null || query.data === undefined) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const set = query.data;

  return (
    <div className="space-y-6">
      <EditorHeader set={set} />

      <UnpublishedNotice set={set} canPublish={canPublish} />

      {set.groups.length === 0 ? (
        <Alert>
          <AlertTitle>Nothing here yet</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>A group holds related options — “Finish”, “Size”. Add one to begin.</span>

            {/*
              🔴 **"Add one to begin" instructed an action it did not offer.**
              M20b.5 asks every empty state for "one button that fills it", and
              this had none — the add-group field is two hundred lines further
              down a four-thousand-line screen, which is the merchant's first
              view of a set they have just created.
              *
              ⚠️ **Focuses the existing field rather than repeating the form.**
              A second way to create a group is a second thing to keep in step;
              this is the same control, brought to the merchant's attention.
            */}
            {canEdit ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const field = document.getElementById(NEW_GROUP_FIELD_ID);

                  field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  (field as HTMLInputElement | null)?.focus();
                }}
              >
                Add a group
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {canEdit ? (
        <HistoryControls
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          undoLabel={history.undoLabel}
          redoLabel={history.redoLabel}
          error={historyError}
          onUndo={() => {
            void runHistory(() => history.undo());
          }}
          onRedo={() => {
            void runHistory(() => history.redo());
          }}
        />
      ) : null}

      {/*
        🔴 **The preview belongs beside the work, not beneath it.**
        A merchant builds an option set *in order to* see it — and the preview
        sat below the groups, the rules and a border, which on a set with more
        than two groups means below the fold. They were editing blind and
        scrolling to check, which is the loop this pane exists to remove.

        ⚠️ **One column under `lg`, deliberately.** A 24rem preview beside a
        cramped editor is worse than a preview underneath it, so the
        small-screen answer is to stack rather than to shrink.

        🔴 **And the column costs two of the three widths, which is why the
        docked frame exists (F55).** The first version of this layout cited
        ADR-108's phone/tablet/desktop presets as *justification* for the
        column. That inverts the reasoning: the storefront ships no `@media`
        queries precisely because resizing the frame **is** the feature, so a
        fixed 24rem column is the thing that breaks it — tablet overflows by
        22rem, desktop clamps while its button still says *Desktop*. The
        presets were the cost, never the excuse. The column therefore docks to
        phone and the dialog below restores the other two.
      */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="min-w-0 space-y-6">
          <GroupList
            setId={setId}
            groups={set.groups}
            canEdit={canEdit}
            onChanged={reload}
            onReordered={reorderChanged}
            patch={patch}
          />

          {canEdit ? <AddGroup setId={setId} onAdded={reload} /> : null}

          {/*
           * Rules sit below the groups because they act **on** them: a merchant
           * cannot write "hide Engraving Text" before Engraving Text exists, and the
           * target picker is built from what is above it.
           *
           * ⚠️ Shown to a viewer as well, read-only. A rule decides what a customer
           * sees, so someone diagnosing a storefront needs to read them without
           * being able to change them.
           */}
          <RulesPanel set={set} canEdit={canEdit} />
        </div>

        {/*
          📌 **Sticky, so it stays visible while the merchant works down a long
          set.** `top-6` clears the header; `max-h`/`overflow-y-auto` keep a
          preview taller than the viewport scrollable within itself rather
          than pushing the page.
        */}
        <aside className="space-y-2 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          <SetPreviewSection set={set} docked />

          {/*
            🔴 **The docked picker promises this, so it has to exist.**
            Replacing a Desktop button that silently rendered at phone width
            with a sentence that pointed nowhere would have been the same
            defect wearing different words.

            📌 **A dialog rather than a route**, because the merchant is
            checking their work mid-edit: a navigation would lose scroll
            position and the answers they have typed into the preview.
          */}
          <Dialog>
            <DialogTrigger
              className="text-muted-foreground hover:text-foreground w-full rounded-md border border-dashed py-2 text-xs transition-colors"
            >
              Open full width
            </DialogTrigger>
            <DialogContent className="max-w-5xl">
              <DialogHeader>
                <DialogTitle>Preview — {set.name}</DialogTitle>
              </DialogHeader>
              <div className="max-h-[75vh] overflow-y-auto">
                <SetPreviewSection set={set} />
              </div>
            </DialogContent>
          </Dialog>
        </aside>
      </div>

      {/*
       * The live preview sits at **set scope**, beside the rules rather than as a
       * third column (ADR-104). It shows the whole set — every enabled group, in
       * order, with real prices — where the per-option `OptionPreview` inside the
       * editor form shows one control's shape.
       *
       * ⚠️ **Below the rules deliberately.** A rule changes what a customer
       * sees, so the preview reads as the result of everything above it.
       */}

      {/*
       * Assignment is a property of the set, so it sits with the set's own
       * controls rather than on a separate screen: choosing which products an
       * option applies to is part of authoring it, and a merchant who publishes
       * without assigning anything has shipped something no customer will see.
       */}
      <div className="border-t pt-6">
        <ProductPicker
          optionSetId={setId}
          storeId={set.storeId}
          isDraft={set.status !== 'published'}
        />
      </div>

      {canPublish ? <PublishPanel set={set} onPublished={reloadAfterPublish} /> : null}

      {/*
        * 🔴 **Export is read-only; import is a WRITE path** (M20.8). The file is
        * validated in full before anything is created — a document failing
        * halfway would leave a set nobody authored, and a create is a shape
        * change that clears the undo log.
        */}
      <PortablePanel
        canEdit={canEdit}
        filename={`${set.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'option-set'}.json`}
        href={`data:application/json;charset=utf-8,${encodeURIComponent(
          JSON.stringify(toPortable(set), null, 2),
        )}`}
        problems={importProblems}
        summary={importSummary}
        onFile={(file) => {
          void file.text().then((raw) => {
            const parsed = parsePortable(raw);

            /*
             * ⚠️ **Validated, and the tree not yet rebuilt.** Creating a set
             * from a document is a long sequence of writes — group, option,
             * value, item, then rules remapped from index paths — and doing it
             * without a transaction is the part-write this validation exists to
             * prevent. Reporting what a file contains is the half that is safe
             * today; the rebuild is its own change, and the panel says so
             * *before* a merchant chooses a file.
             */
            setImportProblems(parsed.ok ? [] : parsed.problems);
            setImportSummary(parsed.ok ? 'Importing…' : undefined);

            if (!parsed.ok) {
              return;
            }

            /*
             * 🔴 **One request, because the server builds it in one
             * transaction.** Rebuilding from here as a sequence of creates
             * would leave a set nobody authored when a document failed
             * halfway — and a create clears the undo log, so there would be no
             * way back.
             *
             * ⚠️ **Into this set's own store**, never a store the file names: a
             * document carries no store, and inventing one from a file would be
             * a tenant surface opened by a merchant's download folder.
             */
            void importSet(set.storeId, parsed.set as unknown as Record<string, unknown>)
              .then((created) => {
                setImportSummary(`Imported as "${created.name}".`);

                /*
                 * 🔴 **This invalidated nothing at all.** The import creates a
                 * whole new option set, and neither the sets list nor the
                 * dashboard checklist was told — so the merchant was shown
                 * "Imported as …" and then could not find it, and the checklist
                 * kept saying "create your first option set" for its 30-second
                 * `staleTime`.
                 */
                void queryClient.invalidateQueries({ queryKey: ['option-sets'] });
                invalidateActivation(queryClient);
              })
              .catch((error: unknown) => {
                setImportSummary(undefined);
                setImportProblems([
                  error instanceof Error
                    ? `That file could not be imported — ${error.message}`
                    : 'That file could not be imported.',
                ]);
              });
          });
        }}
      />
    </div>
  );
}

/**
 * "Your storefront is still serving the last published version."
 *
 * 🔴 Without this a merchant edits a published set, sees the change in the
 * dashboard, and reasonably concludes it is live — while the storefront serves
 * the old snapshot. Measured: adding a value leaves `status: published` and
 * `configVersion` unchanged, and the published snapshot kept one value while the
 * editor showed two.
 *
 * Only asked for a **published** set: a draft has nothing live to differ from,
 * and asking would be two requests answering a question nobody has.
 */
/**
 * The add-group field's id, shared by the three places that need it.
 *
 * 🔴 **A bare string here fails silently.** The empty-state button focuses this
 * field by id, and the field is **216 lines** further down: rename one and
 * `getElementById` returns null, both calls are optional-chained, and the button
 * becomes a no-op with no error, no warning, and an empty state that once again
 * instructs an action it does not perform — the exact defect M20b.5 fixed,
 * reachable by an unrelated edit.
 *
 * ⚠️ Also the `htmlFor`/`id` pair: an unbound label names nothing to a screen
 * reader, which this file already records having got wrong once.
 */
const NEW_GROUP_FIELD_ID = 'new-group-label';

/**
 * The editor's title, status and the help a merchant can open beside them.
 *
 * ## Why this is a component
 *
 * ✏️ **Exported so the help can be *rendered*, not located.** The guard written
 * for M20b.7 asserted that `HELP.hierarchy` appeared in this file **before** the
 * no-groups notice — which proves it is not nested inside that notice and
 * nothing more. Verified by mutation: wrapping it in an unrelated condition so it
 * renders almost never left all 27 tests green.
 *
 * The milestone's requirement — *"the explanation survives the merchant having
 * content"* — is about **when** it renders, and only a renderer can see that.
 * `@testing-library/react` is already a dependency and three sibling tests use
 * it; the earlier guard read source because this markup was inline, not because
 * rendering was unavailable.
 */
export function EditorHeader({ set }: { set: AuthoringSet }) {
  return (
    <div className="space-y-1">
      <Link href="/option-sets" className="text-muted-foreground text-sm hover:underline">
        ← All option sets
      </Link>

      {/*
        🔴 **Draft versus published is a state, and it read as a sentence.**
        It is the single fact that decides whether a merchant's work is live,
        and it sat in muted body text below the title — the same weight as the
        version number beside it. A badge is read before it is parsed.

        ⚠️ **`secondary` for draft rather than a warning colour.** A draft is
        the normal state of work in progress, not a problem; the unpublished
        notice below already raises the case that needs attention.
      */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{set.name}</h1>
        {set.status === 'published' ? (
          <Badge variant="secondary" className="border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400">
            Published · v{set.version}
          </Badge>
        ) : (
          <Badge variant="secondary">Draft</Badge>
        )}
      </div>

      {/*
        🔴 **Where the merchant builds, not only where they start** (ADR-098).
        The hierarchy was explained in the no-groups notice — which disappears
        once they add a group, which is exactly when the difference between a
        group and an option starts to matter.

        ⚠️ **Unconditional, deliberately.** No `set.groups.length` here: the note
        must survive the merchant having content, which is the whole point.

        📌 Publishing is already explained at the two moments it bites — the
        unpublished notice and the empty version history. This is the durable
        version, for a merchant looking at neither.
      */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1">
        <HelpNote concept={HELP.hierarchy} />
        <HelpNote concept={HELP.publishing} />
      </div>
    </div>
  );
}

function UnpublishedNotice({ set, canPublish }: { set: AuthoringSet; canPublish: boolean }) {
  /*
   * 🔴 **Named changes, not a boolean** (M20.9's `diff-vs-published`). This
   * asked `hasUnpublishedChanges`, which fetched *both* documents and reduced
   * them to `true` — so a merchant publishing to a live storefront was told
   * something differed and never what. `unpublishedChanges` makes the same two
   * requests and keeps the comparison.
   */
  const dirty = useQuery({
    queryKey: ['option-set', set.id, 'unpublished', set.rowVersion],
    queryFn: () => unpublishedChanges(set.id, set.version),
    enabled: set.status === 'published' && set.version > 0,
    /*
     * Keyed on `rowVersion` so every edit re-asks: the answer changes the moment
     * a merchant changes anything, and a cached "no changes" is exactly the
     * wrong thing to keep showing.
     */
    retry: false,
  });

  /*
   * ⚠️ **An empty array is "nothing changed"; `undefined` is "not asked yet".**
   * Treating the two alike would flash the notice on every load.
   */
  if (dirty.data === undefined || dirty.data.length === 0) {
    return null;
  }

  /*
   * The markup lives in `option-set-display`, where it can be rendered from a
   * test. What stays here is the only part that cannot: the network question
   * above deciding whether to show it at all.
   */
  return (
    <UnpublishedChangesNotice
      version={set.version}
      canPublish={canPublish}
      changes={dirty.data}
    />
  );
}

/**
 * The live preview, with the products a merchant can price against.
 *
 * ⚠️ **The fetch lives here, not in `SetPreview`.** That component is a pure
 * function of a set, a chosen product and a width — calling `useQuery` inside it
 * coupled the one thing whose job is to be predictable to the network, and broke
 * every render test with *"No QueryClient set"*. This wrapper is where a page
 * already does its fetching.
 *
 * 📌 **A failed or empty fetch is not an error state.** The preview falls back
 * to the stated sample price, which is what a set with no assignment shows
 * anyway — so a merchant still gets an answer rather than a spinner.
 */
function SetPreviewSection({ set, docked = false }: { set: AuthoringSet; docked?: boolean }) {
  const products = useQuery({
    queryKey: ['products', 'preview', set.storeId],
    queryFn: () => listProducts({ storeId: set.storeId, limit: 50 }),
  });

  return <SetPreview set={set} products={products.data?.items ?? []} docked={docked} />;
}

function AddGroup({ setId, onAdded }: { setId: string; onAdded: () => void }) {
  const [label, setLabel] = useState('');

  const add = useMutation({
    mutationFn: () => createGroup(setId, label.trim()),
    onSuccess: () => {
      setLabel('');
      onAdded();
    },
  });

  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 pt-6">
        <div className="flex-1 space-y-1.5">
          {/*
            🔴 **`htmlFor`/`id`, not a bare `<label>`.** An unbound label names
            nothing: a screen reader announces the input as unlabelled, and a
            click on the text does not focus it. It also left the E2E with only
            the placeholder to address this by — example copy that changes
            whenever a writer picks a friendlier word, which is exactly how the
            canonical suite came to time out here unnoticed.
          */}
          <label className="text-sm font-medium" htmlFor={NEW_GROUP_FIELD_ID}>
            New group
          </label>
          <Input
            id={NEW_GROUP_FIELD_ID}
            value={label}
            placeholder="Finish"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <Button
          disabled={label.trim() === '' || add.isPending}
          onClick={() => add.mutate()}
        >
          {add.isPending ? 'Adding…' : 'Add group'}
        </Button>
        {add.error === null || add.error === undefined ? null : <ErrorState error={add.error} />}
      </CardContent>
    </Card>
  );
}

/**
 * The set's groups, in order, with the controls to move them.
 *
 * 🔴 **A merchant could not reorder groups at all until M18.6.** The endpoint
 * `POST /option-sets/:id/reorder` shipped fully built and the dashboard never
 * called it, so on a product with three sections their order was whatever order
 * they happened to be created in — permanently. Options *within* a group could
 * always be moved, which made the gap easy to miss.
 *
 * ⚠️ **Move up / move down rather than drag-and-drop**, matching the choice
 * already made one level down: drag needs a library, does not work from a
 * keyboard without extra handling, and is awkward on the phones merchants
 * actually use. The plan's row for this stage said "drag-and-drop"; doing that
 * would have traded working, accessible controls for a regression.
 *
 * A separate component because the mutation needs a hook, and the page's own
 * body returns early while the set is loading.
 */
/**
 * ⚠️ **Exported for test** (20-2d). The page renders it directly; nothing else
 * imports it. Without the keyword no test can mount **two** groups at once —
 * and one group is exactly the case that hides `AddOption`'s duplicate ids.
 */
/**
 * The three in-place patches, bundled so one prop threads where three would.
 *
 * 📌 **Bundled rather than three props** because they travel together through
 * five component layers and are always passed as a unit; a component that
 * edits values still forwards the option and group patches to its children.
 */
type TreePatch = {
  option: (option: AuthoringOption) => void;
  value: (value: AuthoringValue) => void;
  group: (group: AuthoringGroup) => void;
  item: (item: AuthoringItem) => void;

  /**
   * Record a reversible operation (M20.10).
   *
   * 📌 **Bundled with the patches rather than threaded separately** because it
   * travels the same five layers to the same components — every editor that
   * patches the cache is also one whose edit should be undoable.
   */
  record: (entry: HistoryEntry) => void;
};

export function GroupList({
  setId,
  groups,
  canEdit,
  onChanged,
  onReordered,
  patch,
}: {
  setId: string;
  groups: AuthoringSet['groups'];
  canEdit: boolean;
  onChanged: () => void;

  /**
   * Refresh after a reorder.
   *
   * ⚠️ **Separate from `onChanged` because that one CLEARS the undo log.** A
   * reorder is the shape change the log survives, so routing it through the
   * same callback would erase the entry the reorder had just recorded.
   */
  onReordered: () => void;

  patch: TreePatch;
}) {
  const move = useMutation({
    mutationFn: async ({ index, direction }: { index: number; direction: -1 | 1 }) => {
      const payload = groupReorderPayload(groups, index, direction);

      /*
       * `null` means the move runs off an end. The buttons are disabled there,
       * so this is unreachable from the UI — but a payload that reorders
       * nothing would still be a write, an audit entry and a `configVersion`
       * bump, telling every storefront its configuration changed when it did
       * not.
       */
      if (payload === null) {
        return;
      }

      const previous = groups.map((group, position) => ({
        id: group.id,
        sortOrder: sortOrderFor(position),
      }));

      await reorderGroups(setId, payload);

      return { previous, payload };
    },
    onSuccess: (result) => {
      onReordered();

      if (result === undefined) {
        return;
      }

      /*
       * 🔴 **The inverse is the ORDERING THAT EXISTED**, written in full.
       * `reorderGroups` takes a complete `SortEntry[]` rather than a relative
       * move, so replaying the previous ordering is correct whatever else has
       * changed — which is what makes a reorder undoable when a delete is not.
       */
      patch.record({
        label: 'Reorder groups',
        inverse: async () => {
          await reorderGroups(setId, result.previous);
          onReordered();
        },
        replay: async () => {
          await reorderGroups(setId, result.payload);
          onReordered();
        },
      });
    },
  });

  /**
   * Which group the editor pane is showing.
   *
   * 🔴 **`undefined` until a merchant chooses, then sticky.** Defaulting to the
   * first group in *state* would fight the list: a set that loads empty and
   * gains its first group later would never advance past `undefined`. So the
   * fallback is computed at render — first group when nothing is chosen — and
   * the state only records a deliberate choice.
   *
   * ⚠️ **A chosen group that disappears falls back rather than blanking.**
   * Deleting the selected group leaves `selectedId` naming a row that is gone;
   * `find` returns `undefined` and the `??` puts the editor on the first
   * remaining group instead of showing an empty pane.
   */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const selected =
    groups.find((group) => group.id === selectedId) ?? groups[0];

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(12rem,18rem)_1fr]">
      {/*
        * The **structure** pane (M20.1).
        *
        * 🔴 **This is the change that makes the editor scale.** Every group
        * used to render its full editor inline, so a set at `AUTHORING_LIMITS`
        * scale — 20 groups of 30 options — mounted **600** `OptionBlock`s at
        * once. Selecting means one editor exists however long the list grows.
        *
        * ⚠️ **Ordering stays here, beside the names**, because move-up/down is
        * a *structural* action: a merchant reordering groups is looking at the
        * list, not at one group's fields (ADR-085 re-affirmed these controls
        * over drag).
        */}
      <nav aria-label="Groups" className="space-y-1">
        {groups.map((group, index) => (
          <div key={group.id} className="flex items-center gap-1">
            <button
              type="button"
              data-group-select={group.id}
              aria-current={group.id === selectedId ? 'true' : undefined}
              onClick={() => {
                /* Asks only when there is something to lose — see `confirmDiscard`. */
                if (confirmGroupSwitch()) {
                  setSelectedId(group.id);
                }
              }}
              className={[
                'flex-1 truncate rounded-md px-3 py-2 text-left text-sm transition',
                group.id === selectedId
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'hover:bg-accent/50',
              ].join(' ')}
            >
              {group.label}
            </button>

            {canEdit && groups.length > 1 ? (
              <span className="flex shrink-0 flex-col">
                <button
                  type="button"
                  aria-label={`Move ${group.label} up`}
                  disabled={index === 0 || move.isPending}
                  onClick={() => move.mutate({ index, direction: -1 })}
                  className="text-muted-foreground px-1 text-xs disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${group.label} down`}
                  disabled={index === groups.length - 1 || move.isPending}
                  onClick={() => move.mutate({ index, direction: 1 })}
                  className="text-muted-foreground px-1 text-xs disabled:opacity-30"
                >
                  ↓
                </button>
              </span>
            ) : null}
          </div>
        ))}

        {move.isError ? (
          <p className="text-destructive text-sm">That group could not be moved. Try again.</p>
        ) : null}
      </nav>

      {/*
        * The **editor** pane — the selected group, and only it.
        *
        * 📌 `key` on the group id so switching groups remounts rather than
        * reusing: `AddOption`'s form state belongs to the group being edited,
        * and carrying a half-typed option across a selection change would be a
        * surprise, not a convenience.
        */}
      <div>
        {selected === undefined ? null : (
          <GroupCard
            key={selected.id}
            group={selected}
            canEdit={canEdit}
            onChanged={onChanged}
            patch={patch}
          />
        )}
      </div>
    </div>
  );
}function GroupCard({
  group,
  canEdit,
  onChanged,
  patch,
  onMove,
  isFirst,
  isLast,
  isMoving,
}: {
  group: AuthoringSet['groups'][number];
  canEdit: boolean;
  onChanged: () => void;
  patch: TreePatch;

  /*
   * Undefined when the set has one group, so the buttons are absent rather
   * than present-and-always-disabled — the same shape `OptionBlock` uses one
   * level down.
   */
  onMove?: (direction: -1 | 1) => void;
  isFirst?: boolean;
  isLast?: boolean;
  isMoving?: boolean;
}) {
  /**
   * Reorder in **one** write, as M13.5 asks.
   *
   * `POST /groups/:id/reorder` takes the whole sibling list, so a move is a
   * single request carrying the new order rather than two writes that could
   * half-apply. The server assigns gap-tolerant `sortOrder` steps; the client
   * only says what order it wants.
   */
  /**
   * The group's options and items as one ordered sequence.
   *
   * The ordering itself lives in `mergedEntries` so it can be tested against
   * the storefront's rule directly, rather than only through this component.
   */
  const entries = useMemo(() => mergedEntries(group), [group])

  /**
   * Move one entry past its neighbour, in the merged order.
   *
   * 🔴 **Both lists are renumbered from their positions in the *merged*
   * sequence**, because options and items share one `sortOrder` scale. The
   * arithmetic lives in `reorderPayloads`, where it is tested: numbering each
   * list by its own index was silently broken — a cross-kind move wrote two
   * successful requests and changed nothing.
   *
   * ⚠️ Two writes when the swap crosses kinds, one when it does not. The tables
   * are separate and so are the endpoints, so a single call cannot express the
   * new interleaving.
   */
  const move = useMutation({
    mutationFn: async ({ index, direction }: { index: number; direction: -1 | 1 }) => {
      const payload = reorderPayloads(entries, index, direction);

      if (payload.options !== null) {
        await reorderOptions(group.id, payload.options);
      }

      if (payload.items !== null) {
        await reorderItems(group.id, payload.items);
      }
    },
    onSuccess: onChanged,
  });

  /**
   * Deleting a group.
   *
   * 🔴 Options and values were removable and a group was not — an arbitrary
   * asymmetry that left a merchant unable to undo a mistyped group. Mild, since
   * no publish finding covers an empty group, but the tree should be as
   * reversible as it is editable.
   *
   * The confirmation names what goes with it: deleting a group takes its options
   * and their values, which is not obvious from a button beside a label.
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /*
   * 🔴 **Disabling does not cascade, unlike deleting.** It is a flag the
   * publish serializer reads, and the publish checks already skip disabled
   * entities — so a disabled group raises no findings about its own options.
   */
  const toggleEnabled = useMutation({
    mutationFn: () => updateGroup(group.id, { isEnabled: !group.isEnabled }),
    onSuccess: patch.group,
  });

  const remove = useMutation({
    mutationFn: () => deleteGroup(group.id),
    onSuccess: () => {
      setConfirmingDelete(false);
      onChanged();
    },
  });

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">{group.label}</h2>

          <div className="flex flex-wrap items-center gap-2">
            {/*
              ⚠️ **Labelled by the group's own name, not "up" and "down".**
              A screen reader announcing four identical "Move up" buttons on a
              four-group set says nothing about which group moves — the same
              reason `OptionBlock` names the option in its label.
            */}
            {/*
              * ✏️ **Unreachable since 2d-d, and kept deliberately.** Ordering moved into
              * the structure pane, so `GroupList` no longer passes `onMove` — this
              * renders nothing. Verified by test rather than assumed: a grep still finds
              * move buttons here, and deleting them on that count alone would have been
              * a guess.
              *
              * Left in place because `GroupCard` is the editor pane's contract: a caller
              * that *does* want inline ordering gets it by passing the prop, and the
              * guard is what makes that safe.
              */}
            {onMove === undefined ? null : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${group.label} up`}
                  disabled={isFirst === true || isMoving === true}
                  onClick={() => onMove(-1)}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${group.label} down`}
                  disabled={isLast === true || isMoving === true}
                  onClick={() => onMove(1)}
                >
                  ↓
                </Button>
              </>
            )}

            <GroupLayout
              group={group}
              canEdit={canEdit}
              onPatched={patch.group}
              onRecord={patch.record}
            />

            {/*
              * 🔴 **The reversible alternative to deleting** (Phase 20 audit).
              * The publish serializer filters disabled groups out, so taking one
              * off sale for a fortnight is a flag — where a delete is a shape
              * change that clears the undo log, with no restore endpoint. The
              * destructive path was available and this was not.
              */}
            {canEdit ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={toggleEnabled.isPending}
                  onClick={() => toggleEnabled.mutate()}
                >
                  {group.isEnabled ? 'Disable group' : 'Enable group'}
                </Button>
              </>
            ) : null}

            {canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete group
              </Button>
            ) : null}
          </div>
        </div>

        {/*
          * ⚠️ **A disabled thing must LOOK disabled**, or a merchant cannot tell
          * why their option is missing from the storefront — the publish
          * serializer filters it out silently.
          */}
        {group.isEnabled ? null : (
          <p className="text-muted-foreground text-xs">
            Disabled — this group is not published to the storefront.
          </p>
        )}

        <GroupDescription
          group={group}
          canEdit={canEdit}
          onPatched={patch.group}
          onRecord={patch.record}
        />

        {!confirmingDelete ? null : (
          <Alert variant="destructive">
            <AlertDescription className="space-y-3">
              <p>
                {/*
                 * Counts both, because deleting a group cascades to both. A
                 * confirmation that named only options would understate what
                 * goes -- and the merchant's headings would vanish unmentioned.
                 */}
                {entries.length === 0
                  ? `Delete "${group.label}"?`
                  : `Delete "${group.label}" and its ${entries.length} ${
                      entries.length === 1 ? 'entry' : 'entries'
                    }?`}
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
                <Button variant="outline" size="sm" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {remove.error === null || remove.error === undefined ? null : (
          <ErrorState error={remove.error} />
        )}

        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing in this group yet.</p>
        ) : (
          <ul className="space-y-4">
            {entries.map((entry, index) => (
              <li key={entry.id}>
                {/*
                 * Move up / move down rather than drag-and-drop.
                 *
                 * Drag needs a library, does not work from a keyboard without
                 * extra handling, and is awkward on the phones merchants
                 * actually use. Two buttons are usable everywhere and say
                 * exactly what they do -- and M13.5 asks for "functional, not
                 * beautiful".
                 */}
                {entry.kind === 'option' ? (
                  <OptionBlock
                    option={entry.option}
                    canEdit={canEdit}
                    onChanged={onChanged}
                    patch={patch}
                    onMove={
                      canEdit && entries.length > 1
                        ? (direction) => move.mutate({ index, direction })
                        : undefined
                    }
                    isFirst={index === 0}
                    isLast={index === entries.length - 1}
                    isMoving={move.isPending}
                  />
                ) : (
                  <ItemBlock
                    item={entry.item}
                    canEdit={canEdit}
                    onChanged={onChanged}
                    onPatched={patch.item}
                    onRecord={patch.record}
                    onMove={
                      canEdit && entries.length > 1
                        ? (direction) => move.mutate({ index, direction })
                        : undefined
                    }
                    isFirst={index === 0}
                    isLast={index === entries.length - 1}
                    isMoving={move.isPending}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {move.error === null || move.error === undefined ? null : (
          <ErrorState error={move.error} />
        )}

        {canEdit ? (
          <>
            <AddOption groupId={group.id} onAdded={onChanged} />
            <AddItem groupId={group.id} onAdded={onChanged} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * ⚠️ **Exported for test only** (20-2c). Nothing else imports it; the page
 * renders it directly. Without the keyword no test can mount it, and this is a
 * 430-line form whose fields appear and disappear with `presentation` — the
 * part a source contract provably cannot see.
 */
export function AddOption({ groupId, onAdded }: { groupId: string; onAdded: () => void }) {
  /**
   * 🔴 **One form object rather than fifteen `useState` hooks** (20-2c).
   *
   * The names below are kept identical to the state they replace, so the 430
   * lines of markup underneath did not have to move to make this change. What
   * changes is where the values live and how they are cleared: `form.reset()`
   * instead of a fifteen-line block that a sixteenth field would have been left
   * out of.
   *
   * ⚠️ **`mode: 'onBlur'`**, matching `AuthForm`'s reasoning — *"an email
   * flagged invalid while it is still being typed is noise, not help"*. The
   * submit button stays gated on a live parse, so a merchant is never told a
   * field is wrong while typing it, and never able to add an invalid option.
   */
  const form = useForm<OptionFormValues>({
    resolver: zodResolver(optionFormSchema),
    defaultValues: {
      key: '',
      label: '',
      presentation: 'radio',
      isRequired: false,
      takesMany: false,
      columns: 1,
      priceFraming: 'delta',
      swatchSize: 'medium',
      collapsed: false,
      tooltip: '',
      minSelText: '',
      maxSelText: '',
      maxLengthText: '',
      minLengthText: '',
    },
    mode: 'onBlur',
  });

  /*
   * Watched individually because the markup below reads them as plain values —
   * watching the whole object would re-render every field on every keystroke,
   * which is the cost this form can least afford at fifteen fields.
   *
   * ⚠️ **`useWatch`, not `form.watch()`.** The React Compiler refuses to
   * memoize any component that calls `watch()` — *"returns functions which
   * cannot be memoized without leading to stale UI"* — and silently skipping
   * optimisation on a 561-line form is a real cost. `useWatch` subscribes
   * through `control` and carries no such warning.
   */
  const key = useWatch({ control: form.control, name: 'key' });
  const label = useWatch({ control: form.control, name: 'label' });
  const presentation = useWatch({ control: form.control, name: 'presentation' });
  const isRequired = useWatch({ control: form.control, name: 'isRequired' });
  const takesMany = useWatch({ control: form.control, name: 'takesMany' });
  const columns = useWatch({ control: form.control, name: 'columns' });
  const priceFraming = useWatch({ control: form.control, name: 'priceFraming' });
  const swatchSize = useWatch({ control: form.control, name: 'swatchSize' });
  const collapsed = useWatch({ control: form.control, name: 'collapsed' });
  const tooltip = useWatch({ control: form.control, name: 'tooltip' });
  const minSelText = useWatch({ control: form.control, name: 'minSelText' });
  const maxSelText = useWatch({ control: form.control, name: 'maxSelText' });
  const maxLengthText = useWatch({ control: form.control, name: 'maxLengthText' });
  const minLengthText = useWatch({ control: form.control, name: 'minLengthText' });

  /*
   * ⚠️ **`keyTouched` stays a plain `useState` and must.** It records whether
   * the merchant has edited the key so the label stops auto-filling it — UI
   * bookkeeping, not data. `optionFormExtrasSchema`'s docblock says the same:
   * a form model that carried it would validate it, reset it, and eventually
   * send it.
   */
  const [keyTouched, setKeyTouched] = useState(false);

  /*
   * 🔴 **Fourteen fields, lost silently until M20.10.** A merchant part-way
   * through an option who reloads, closes the tab or types a URL gets the
   * browser's own warning now. The in-app cases — leaving the page, switching
   * groups — cannot reach `beforeunload` and are guarded at their click sites.
   */
  /*
   * 🔴 **Destructured during render, and it has to be.** `formState` is a
   * Proxy: React Hook Form only tracks the fields a component *reads while
   * rendering*, so reading `form.formState.isDirty` inside a callback or an
   * effect subscribes to nothing and the value never updates. Measured — the
   * guard never fired until this line existed.
   */
  const { isDirty } = form.formState;

  useUnsavedGuard(isDirty);

  /*
   * ⚠️ **Published for the group switch, which `beforeunload` cannot see.**
   * Switching groups remounts this form and clears it — correct, and proven by
   * M110 — but doing it silently is the loss M20.10 exists to prevent.
   */
  setOptionFormDirty(isDirty);

  /*
   * The derived numbers the payload and the bounds check use. Kept exactly as
   * they were: `''` means "unset", and the `accepts*` guard decides whether the
   * value applies to the chosen type at all.
   */
  const minSel = minSelText.trim() === '' ? null : Number(minSelText);
  const maxSel = maxSelText.trim() === '' ? null : Number(maxSelText);

  /*
   * A minimum above the maximum. Live on every keystroke, because it colours a
   * hint and gates the add button — not a parse failure at submit (20-2c
   * step 2 records why this stayed outside the schema).
   */
  const boundsWrong = boundsContradict(minSel, maxSel);

  /**
   * A field id unique to this group's add-option form.
   *
   * 🔴 **Fixed ids collided the moment a set had two groups.** `AddOption`
   * renders once per `GroupCard`, so `#option-label` appeared as many times as
   * the merchant had groups — invalid HTML, and `<label htmlFor>` binds to
   * whichever the browser resolves first, which can label the wrong group's
   * field. Proven by `group-list.render.test.tsx` before this existed: three
   * ids collided on a two-group set while every other gate stayed green.
   *
   * 📌 **The pattern is `ValueRow`'s**, a few hundred lines below — it has
   * scoped six ids per row as `` `label-${value.id}` `` since it was written.
   * This is the same idea applied to the form that was missed.
   */
  const fieldId = (name: string) => `${name}-${groupId}`;

  /* Setters, so the markup's `onChange` handlers read exactly as they did. */
  const setKey = (value: string) => form.setValue('key', value, { shouldDirty: true, shouldValidate: true });
  const setLabel = (value: string) => form.setValue('label', value, { shouldDirty: true, shouldValidate: true });
  const setPresentation = (value: string) => form.setValue('presentation', value, { shouldDirty: true });
  const setIsRequired = (value: boolean) => form.setValue('isRequired', value, { shouldDirty: true });
  const setTakesMany = (value: boolean) => form.setValue('takesMany', value, { shouldDirty: true });
  const setColumns = (value: number) => form.setValue('columns', value, { shouldDirty: true });
  const setPriceFraming = (value: string) => form.setValue('priceFraming', value, { shouldDirty: true });
  const setSwatchSize = (value: string) => form.setValue('swatchSize', value, { shouldDirty: true });
  const setCollapsed = (value: boolean) => form.setValue('collapsed', value, { shouldDirty: true });
  const setTooltip = (value: string) => form.setValue('tooltip', value, { shouldDirty: true });
  const setMinSelText = (value: string) => form.setValue('minSelText', value, { shouldDirty: true });
  const setMaxSelText = (value: string) => form.setValue('maxSelText', value, { shouldDirty: true });
  /*
   * 🔴 **Both length fields re-validate the WHOLE form, not just themselves.**
   * Their contradiction — *"a minimum of 50 cannot fit inside a limit of 10"* —
   * is a `superRefine` issue reported at `path: ['minLength']`, which is
   * **neither** field being edited. `shouldValidate: true` validates only the
   * field it is given, so the message never reached `formState` and the hint
   * stayed grey. Measured: the text was present before 20-2c's migration and
   * absent after, until this.
   */
  const revalidate = () => void form.trigger();

  const setMaxLengthText = (value: string) => {
    form.setValue('maxLengthText', value, { shouldDirty: true, shouldValidate: true });
    revalidate();
  };

  const setMinLengthText = (value: string) => {
    form.setValue('minLengthText', value, { shouldDirty: true, shouldValidate: true });
    revalidate();
  };

  const maxLength = acceptsLength(presentation) && maxLengthText.trim() !== ''
    ? Number(maxLengthText)
    : null;
  const minLength = acceptsLength(presentation) && minLengthText.trim() !== ''
    ? Number(minLengthText)
    : null;

  const parsed = optionSchema.safeParse({
    key,
    label,
    presentation,
    isRequired,
    maxLength,
    minLength,
  });

  const add = useMutation({
    mutationFn: () =>
      createOption(groupId, {
        key,
        label,
        presentation,
        isRequired,

        /*
         * Sent only when it is both meaningful and chosen. The API refuses
         * `many` for a type its registry does not allow, and sending `one`
         * explicitly would be the same as the default it already applies.
         */
        ...(acceptsManyAnswers(presentation) && takesMany ? { cardinality: 'many' } : {}),
        /*
         * ⚠️ **Merged, not spread.** Both helpers return a `display` object,
         * and `{ ...a, ...b }` would replace it wholesale rather than combining
         * — losing `characterCounter`, which M14.4b requires whenever
         * `maxLength` is set.
         */
        ...mergeConfig(
          configFor(presentation, maxLength, minLength),
          layoutFor(presentation, columns),
          priceFramingFor(presentation, priceFraming),
          swatchSizeFor(presentation, swatchSize),
          presentationFor(collapsed, tooltip),
          selectionBoundsFor(presentation, takesMany, minSel, maxSel),
        ),
      }),
    onSuccess: () => {
      /*
       * 🔴 **One call, where fifteen `set*('')` lines used to be.** The old
       * block was correct — every declared field appeared in it — and it was
       * exactly the list a sixteenth field would have been left out of.
       * `form.reset()` restores the `defaultValues` above, so a new field is
       * cleared by virtue of having a default.
       */
      form.reset();

      /* Still by hand: `keyTouched` is UI state, deliberately outside the form. */
      setKeyTouched(false);
      onAdded();
    },
  });

  /**
   * A field's error message, if it has one.
   *
   * 🔴 **Now every field can have one.** This read `parsed.error.issues` and
   * was rendered for **three** of fifteen fields — `key`, `label`,
   * `minLength` — because wiring the other twelve by hand was work nobody had
   * done. Reading `form.formState.errors` costs nothing per field, so the
   * twelve that showed no message can now show theirs.
   *
   * ⚠️ **Errors surface on blur, not on every keystroke** (`mode: 'onBlur'`),
   * while the add button stays gated on a live parse. So a merchant is never
   * scolded mid-word and never able to submit something invalid.
   */
  const issue = (field: string) =>
    (form.formState.errors as Record<string, { message?: string } | undefined>)[field]?.message;

  const selected = AUTHORABLE_TYPES.find((type) => type.value === presentation);

  return (
    <div className="border-t pt-5">
      <div className="space-y-5">
        {/*
          🔴 **A visual picker, not a `<select>` of eight names.**

          The names alone do not say that `radio` and `dropdown` ask the same
          question drawn differently, or that a text field and a text area differ
          only in height. The shapes do, at a glance — and choosing the type
          first is what decides which fields below are even relevant.
        */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What kind of option?</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {AUTHORABLE_TYPES.map((type) => {
              const active = type.value === presentation;

              return (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setPresentation(type.value)}
                  aria-pressed={active}
                  /*
                   * 🔴 **Keyed by the type's stored value, not its display
                   * copy.** This grid replaced a `<select>` before Phase 13
                   * shipped, and the canonical E2E still reached for
                   * `getByLabel('Type').selectOption('dropdown')` — a control
                   * that has never existed, so the suite timed out here.
                   * Matching "Dropdown" instead would tie the test to wording
                   * a writer may improve; `dropdown` is the value the API
                   * stores and the plugin renders by, so it cannot drift
                   * without the contract drifting with it.
                   */
                  data-option-type={type.value}
                  className={[
                    'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition',
                    'hover:border-foreground/30 hover:bg-accent/50',
                    active
                      ? 'border-foreground/60 bg-accent ring-foreground/20 ring-2'
                      : 'border-border',
                  ].join(' ')}
                >
                  <span aria-hidden="true" className="text-lg leading-none">
                    {type.icon}
                  </span>
                  <span className="text-sm font-medium">{type.label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-muted-foreground text-xs">{selected?.hint ?? ''}</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={fieldId('option-label')}>
              Label
            </label>
            <Input
              id={fieldId('option-label')}
              value={label}
              placeholder="Colour"
              onChange={(e) => {
                setLabel(e.target.value);

                /*
                 * The key follows the label until a merchant edits it directly.
                 * Asking someone to invent a machine identifier beside a name
                 * they just typed is a question with one sensible answer — but
                 * the field stays editable, because a key is permanent once
                 * published and renaming a label must not silently change what
                 * the storefront resolves against.
                 */
                if (!keyTouched) {
                  setKey(keyFromLabel(e.target.value));
                }
              }}
            />
            <p className="text-muted-foreground text-xs">What the customer reads.</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor={fieldId('option-key')}>
              Key
            </label>
            <Input
              id={fieldId('option-key')}
              value={key}
              placeholder="colour"
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
            <p className={issue('key') && key !== '' ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
              {(key !== '' && issue('key')) || 'Filled in from the label. Permanent once published.'}
            </p>
          </div>
        </div>

        {/*
          Length rules appear only for the types that have them — a character
          limit on a radio would be a number with nothing to count.
        */}
        {acceptsLength(presentation) ? (
          <fieldset className="bg-muted/40 space-y-3 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Length</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor={fieldId('option-min-length')}>
                  Minimum
                </label>
                <Input
                  id={fieldId('option-min-length')}
                  type="number"
                  min={1}
                  value={minLengthText}
                  placeholder="3"
                  onChange={(e) => setMinLengthText(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor={fieldId('option-max-length')}>
                  Maximum
                </label>
                <Input
                  id={fieldId('option-max-length')}
                  type="number"
                  min={1}
                  value={maxLengthText}
                  placeholder="20"
                  onChange={(e) => setMaxLengthText(e.target.value)}
                />
              </div>
            </div>
            <p className={issue('minLength') ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
              {issue('minLength') ??
                'Both optional. A maximum shows the customer a live counter as they type.'}
            </p>
          </fieldset>
        ) : null}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
          />
          Required — the customer cannot add to cart without answering
        </label>

        {/*
          🔴 **Several answers, offered only where the API allows it.**

          Shown for `checkbox` alone, because that is the one type whose
          registry entry lists `MANY`. Offering it elsewhere would let a
          merchant author an option the API refuses with `INCOMPATIBLE_AXIS`.

          ⚠️ **Warned about, because it cannot be undone.** `cardinality` is
          absent from the API's `OptionChanges`, so it is immutable after
          creation — the same reason `key` is. A merchant who wants a
          multi-select and does not tick this has to delete the option and make
          another, and nothing later in the editor will tell them why.
        */}
        {/*
          🔴 **`columns` was published, read by thirteen storefront files, and
          authorable nowhere** (ADR-064). A merchant with eight colour swatches
          got one long vertical list and no way to make it a grid.

          ⚠️ **Offered only for the types whose registry entry accepts it** —
          the five choice presentations. A column count on a text field would be
          a grid with one cell.
        */}
        {!acceptsColumns(presentation) ? null : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">How many columns?</legend>
            <div className="flex flex-wrap gap-2">
              {COLUMN_CHOICES.map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setColumns(count)}
                  aria-pressed={count === columns}
                  className={[
                    'rounded-lg border px-3 py-2 text-sm transition',
                    'hover:border-foreground/30 hover:bg-accent/50',
                    count === columns
                      ? 'border-foreground/60 bg-accent ring-foreground/20 ring-2'
                      : 'border-border',
                  ].join(' ')}
                >
                  {count}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              {columns === 1 ? 'A vertical list.' : `Choices laid out in ${columns} columns.`}
            </p>
          </fieldset>
        )}

        {/*
          🔴 **`price_display` was normalised by the storefront and read by
          nothing** — the state ADR-064 kept it out of withdrawal to fix.

          ⚠️ **Two framings, not the API's three** (ADR-065). `total` is
          `base + option`, and a printed total would be stale the moment a
          customer picks a variation, because the storefront runtime listens to
          no variation events by design. Phase 21's server-quoted preview owns
          it, and offering it now would be a third choice that behaves like the
          first.
        */}
        {!acceptsColumns(presentation) ? null : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Show a price beside each choice?</legend>
            <div className="flex flex-wrap gap-2">
              {PRICE_FRAMINGS.map((framing) => (
                <button
                  key={framing.value}
                  type="button"
                  onClick={() => setPriceFraming(framing.value)}
                  aria-pressed={framing.value === priceFraming}
                  className={[
                    'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition',
                    'hover:border-foreground/30 hover:bg-accent/50',
                    framing.value === priceFraming
                      ? 'border-foreground/60 bg-accent ring-foreground/20 ring-2'
                      : 'border-border',
                  ].join(' ')}
                >
                  <span className="text-sm font-medium">{framing.label}</span>
                  <span className="text-muted-foreground text-xs">{framing.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {/*
          🔴 **`swatch_size` was read by both swatch templates and settable
          nowhere** — one of five fields M18.8's exit audit found in that state.

          ⚠️ **Offered for the two swatch types only**, though the shared choice
          schema accepts it for all five. A radio has no swatch to size.
        */}
        {!acceptsSwatchSize(presentation) ? null : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">How large are the swatches?</legend>
            <div className="flex flex-wrap gap-2">
              {SWATCH_SIZES.map((size) => (
                <button
                  key={size.value}
                  type="button"
                  onClick={() => setSwatchSize(size.value)}
                  aria-pressed={size.value === swatchSize}
                  className={[
                    'rounded-lg border px-3 py-2 text-sm transition',
                    'hover:border-foreground/30 hover:bg-accent/50',
                    size.value === swatchSize
                      ? 'border-foreground/60 bg-accent ring-foreground/20 ring-2'
                      : 'border-border',
                  ].join(' ')}
                >
                  {size.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {!acceptsManyAnswers(presentation) ? null : (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={takesMany}
              onChange={(e) => setTakesMany(e.target.checked)}
            />
            <span>
              Let customers pick several
              <span className="text-muted-foreground block text-xs">
                Permanent once created, like the key.
              </span>
            </span>
          </label>
        )}

        {/*
          🔴 **M18.3a enforced these bounds and left them unauthorable.** That
          stage closed a finding — "minSelections/maxSelections enforced
          nowhere" — by teaching the resolver to refuse an out-of-bounds
          selection, and no merchant could set one. By its own standard it was
          half-delivered.

          Measured before this: eight toppings at 1.50 with no way to say "pick
          up to three" — all eight accepted, at 22.00.

          ⚠️ **Only for an option that takes several answers.** A bound on a
          single-value option is a count over one thing, and the resolver
          enforces it — a `min_selections: 2` there refuses every selection, so
          offering it would let a merchant build an unsellable option.
        */}
        {!(acceptsManyAnswers(presentation) && takesMany) ? null : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">How many may they pick?</legend>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs" htmlFor={fieldId('option-min-sel')}>
                  At least
                </label>
                <Input
                  id={fieldId('option-min-sel')}
                  type="number"
                  min={0}
                  max={MAX_SELECTION_BOUND}
                  className="w-24"
                  value={minSelText}
                  placeholder="any"
                  onChange={(e) => setMinSelText(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs" htmlFor={fieldId('option-max-sel')}>
                  At most
                </label>
                <Input
                  id={fieldId('option-max-sel')}
                  type="number"
                  min={1}
                  max={MAX_SELECTION_BOUND}
                  className="w-24"
                  value={maxSelText}
                  placeholder="any"
                  onChange={(e) => setMaxSelText(e.target.value)}
                />
              </div>
            </div>
            <p className={boundsWrong ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
              {boundsWrong
                ? 'The minimum cannot be more than the maximum.'
                : 'Leave either empty for no limit.'}
            </p>
          </fieldset>
        )}

        {/*
          🔴 **A live preview, so the merchant sees the customer's view.**

          Every field above describes something the merchant cannot otherwise
          picture until they publish, assign a product and open a storefront
          page. Showing it here is the difference between authoring and guessing.
        */}
        <div className="space-y-2 rounded-lg border border-dashed p-4">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Your customer sees
          </p>
          <OptionPreview
            label={label}
            presentation={presentation}
            isRequired={isRequired}
            maxLength={maxLength}
          />
        </div>

        {/*
          🔴 **Both were read by the storefront and settable nowhere.**
          `collapsed_by_default` is rendered by all fourteen option templates,
          and `tooltip` reaches every control through
          `OptionView::describedby_blocks()`.

          ⚠️ **A tooltip is announced, not hovered.** The plugin is explicit
          that a hover-only tooltip "is invisible to a large group of
          customers", so it is joined to the control by `aria-describedby`
          rather than a `title`. That makes it a sentence a screen reader reads
          with the field, which is what the hint says.
        */}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Presentation</legend>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={collapsed}
              onChange={(e) => setCollapsed(e.target.checked)}
            />
            Start folded — the customer opens it
          </label>

          <div className="space-y-1">
            <label className="text-muted-foreground text-xs" htmlFor={fieldId('option-tooltip')}>
              Tooltip
            </label>
            <Input
              id={fieldId('option-tooltip')}
              value={tooltip}
              maxLength={MAX_TOOLTIP}
              placeholder="Read out with the field, so write a sentence."
              onChange={(e) => setTooltip(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Announced with the control, not shown on hover. Leave empty for none.
            </p>
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <Button disabled={!parsed.success || boundsWrong || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? 'Adding…' : 'Add option'}
          </Button>
          {!parsed.success && label !== '' ? (
            <span className="text-muted-foreground text-xs">
              {issue('label') ?? issue('key') ?? issue('minLength') ?? 'Fill in a label to continue.'}
            </span>
          ) : null}
        </div>
      </div>

      {add.error === null || add.error === undefined ? null : (
        <div className="mt-3">
          <ErrorState error={add.error} />
        </div>
      )}
    </div>
  );
}

function OptionBlock({
  option,
  canEdit,
  onChanged,
  patch,
  onMove,
  isFirst,
  isLast,
  isMoving,
}: {
  option: AuthoringOption;
  canEdit: boolean;
  onChanged: () => void;
  patch: TreePatch;
  /** Absent when there is nothing to reorder, or the role may not. */
  onMove?: (direction: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
}) {
  /*
   * 🔴 **Patches the cached option instead of refetching the tree.** The
   * endpoint answers with the row it wrote, so a toggled "required" flag costs
   * no further request.
   */
  const toggleRequired = useMutation({
    mutationFn: () => updateOption(option.id, { isRequired: !option.isRequired }),
    onSuccess: (updated) => {
      patch.option(updated);

      /*
       * 📌 **The one inverse that needs no captured state.** Required is a
       * boolean, so putting it back is writing the value it held — which is
       * still on `option` in this closure.
       */
      patch.record({
        label: `${option.isRequired ? 'Make optional' : 'Make required'}: ${option.label}`,
        inverse: async () =>
          void patch.option(await updateOption(option.id, { isRequired: option.isRequired })),
        replay: async () =>
          void patch.option(await updateOption(option.id, { isRequired: !option.isRequired })),
      });
    },
  });

  const toggleEnabled = useMutation({
    mutationFn: () => updateOption(option.id, { isEnabled: !option.isEnabled }),
    onSuccess: patch.option,
  });

  const remove = useMutation({
    mutationFn: () => deleteOption(option.id),
    onSuccess: onChanged,
  });

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">
            {option.label}{' '}
            <span className="text-muted-foreground text-xs">({option.key})</span>
          </p>
          <p className="text-muted-foreground text-xs">
            {option.presentation}
            {option.isRequired ? ' · required' : ''}
          </p>
        </div>

        {canEdit ? (
          <div className="flex gap-2">
            {onMove === undefined ? null : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${option.label} up`}
                  disabled={isFirst || isMoving}
                  onClick={() => onMove(-1)}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${option.label} down`}
                  disabled={isLast || isMoving}
                  onClick={() => onMove(1)}
                >
                  ↓
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={toggleRequired.isPending}
              onClick={() => toggleRequired.mutate()}
            >
              {option.isRequired ? 'Make optional' : 'Make required'}
            </Button>

            {/* 🔴 Reversible, where Remove is not — see the group toggle above. */}
            <Button
              variant="outline"
              size="sm"
              disabled={toggleEnabled.isPending}
              onClick={() => toggleEnabled.mutate()}
            >
              {option.isEnabled ? `Disable ${option.label}` : `Enable ${option.label}`}
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>

      <ul className="space-y-1 text-sm">
        {option.values.map((value) => (
          <li key={value.id}>
            <ValueRow
              value={value}
              presentation={option.presentation}
              canEdit={canEdit}
              onChanged={onChanged}
              onPatched={patch.value}
              onRecord={patch.record}
            />
          </li>
        ))}
      </ul>

      {/*
        * 🔴 **The worked example M20.6 asks for**, computed by the SHARED
        * evaluators — `priceConfigDelta` and `sumDeltas`, the same functions the
        * cloud and the plugin run, proven by 157 shared fixture cases.
        *
        * ⚠️ **A stated sample base, not a real product's price.** Pricing
        * against a chosen product is M21.4; showing a total a merchant reads as
        * "what my customer pays" would be worse than showing nothing, so the
        * base is named on every render.
        */}
      <PricingExample lines={sampleLines(option)} baseMinor={SAMPLE_BASE_MINOR} />

      {/*
        * 🔴 **Pricing for the types that price per OPTION** (Phase 20 audit).
        * A text option charges per character and a number option per unit —
        * both chargeable by the storefront since M16.2 and unauthorable until
        * now. A choice option prices per value and gets nothing here.
        */}
      {canEdit ? <OptionPricing option={option} onPatched={patch.option} /> : null}

      {/*
        * 🔴 **The wording a customer reads** (Phase 20 audit F1). The plugin's
        * templates draw `description`, `placeholder` and `help_text`, and the
        * published document has always carried them — no merchant could set
        * one, because this type declared nine of the projection's nineteen
        * fields.
        */}
      {canEdit ? <OptionWording option={option} onPatched={patch.option} /> : null}

      {/*
        * A text option has no values — the customer types the answer — so the
        * "add value" form is not offered for one. The rule lives in
        * `takesValues()` beside the schema rather than as a condition here,
        * because a rule expressed only in JSX is one no test can mutate.
        */}
      {canEdit && takesValues(option.presentation) ? (
        <>
          <AddValue
            optionId={option.id}
            presentation={option.presentation}
            onAdded={onChanged}
          />
          <PasteValues
            optionId={option.id}
            existingKeys={option.values.map((value) => value.valueKey)}
            onAdded={onChanged}
          />
        </>
      ) : null}

      {toggleRequired.error === null || toggleRequired.error === undefined ? null : (
        <ErrorState error={toggleRequired.error} />
      )}
      {remove.error === null || remove.error === undefined ? null : <ErrorState error={remove.error} />}
    </div>
  );
}

/**
 * One heading, paragraph or divider in the editor.
 *
 * Deliberately plainer than `OptionBlock`: an item has no key, no type axes, no
 * required flag and no values, because it asks the customer nothing. Giving it
 * the same chrome would imply settings that do not exist.
 */
/**
 * Pricing for an option that prices per option rather than per value.
 *
 * 🔴 **Which kinds are offered is the REGISTRY's decision** — `per_char` for a
 * text option, `per_unit` for a number one, nothing for a choice option, whose
 * `noTypeLevelPricing` schema accepts only `null`. Offering a kind the API
 * would refuse is a form that fails on save.
 *
 * ⚠️ **An explicit Save, not autosave.** `ValueRow` autosaves because its five
 * fields describe one value a merchant is editing in place; this is two fields
 * that change what every customer is charged, and a price committed by tabbing
 * away is the wrong default for that.
 *
 * 📌 **A stored `tiered` is named rather than shown as unpriced**, because this
 * editor cannot author brackets and blanking them would invite a merchant to
 * overwrite a set they cannot see.
 */
function OptionPricing({
  option,
  onPatched,
}: {
  option: AuthoringOption;
  onPatched: (option: AuthoringOption) => void;
}) {
  const kinds = optionPricingKinds(option.presentation);
  const stored = readOptionPricing(option.pricing);
  const [kind, setKind] = useState<OptionPricingKind>(
    (kinds as string[]).includes(stored.kind) ? (stored.kind as OptionPricingKind) : kinds[0]!,
  );
  const [amount, setAmount] = useState(stored.amount);
  const [free, setFree] = useState(stored.free);
  const [rows, setRows] = useState<TierRow[]>(() => readTiers(option.pricing));
  const [problems, setProblems] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: (pricing: Record<string, unknown> | null) =>
      updateOption(option.id, { pricing }),
    onSuccess: onPatched,
  });

  if (kinds.length === 0) {
    return null;
  }

  const perChar = kind === 'per_char';
  const tiered = kind === 'tiered';

  const setRow = (index: number, patch: Partial<TierRow>) => {
    setRows((current) =>
      current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  };

  const submit = () => {
    /*
     * 🔴 **Brackets are validated as a SET, by the API's own schema.** Six of
     * the rules — gaps, overlaps, an unbounded bracket in the middle, a set not
     * starting at 1 — are invisible from the row a merchant is typing into, and
     * each is a wrong charge rather than a malformed document.
     */
    const parsed = tiered
      ? parseTiers(rows)
      : parseOptionPricing(kind, { amount, free });

    if (!parsed.ok) {
      setProblems('problems' in parsed ? parsed.problems : [parsed.message]);

      return;
    }

    setProblems([]);
    save.mutate(parsed.pricing);
  };

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border p-3">
      {/*
        * ⚠️ **Only when there is a choice to make.** A text option prices per
        * character and nothing else; offering a picker with one entry is a
        * question with one answer.
        */}
      {kinds.length < 2 ? null : (
        <div className="w-40 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`optkind-${option.id}`}>
            Price type
          </label>
          <select
            id={`optkind-${option.id}`}
            value={kind}
            onChange={(event) => setKind(event.target.value as OptionPricingKind)}
            className="border-input h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="per_unit">Per unit</option>
            <option value="tiered">Quantity brackets</option>
          </select>
        </div>
      )}

      {tiered ? (
        <div className="w-full space-y-2">
          {rows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="w-24 space-y-1.5">
                <label className="text-xs font-medium" htmlFor={`tmin-${option.id}-${index}`}>
                  {`From quantity ${index + 1}`}
                </label>
                <Input
                  id={`tmin-${option.id}-${index}`}
                  value={row.min}
                  onChange={(event) => setRow(index, { min: event.target.value })}
                />
              </div>
              <div className="w-24 space-y-1.5">
                <label className="text-xs font-medium" htmlFor={`tmax-${option.id}-${index}`}>
                  {`To quantity ${index + 1}`}
                </label>
                {/* Blank is open-ended, which the last bracket must be. */}
                <Input
                  id={`tmax-${option.id}-${index}`}
                  value={row.max}
                  placeholder="any"
                  onChange={(event) => setRow(index, { max: event.target.value })}
                />
              </div>
              <div className="w-28 space-y-1.5">
                <label className="text-xs font-medium" htmlFor={`tamt-${option.id}-${index}`}>
                  {`Amount ${index + 1}`}
                </label>
                <Input
                  id={`tamt-${option.id}-${index}`}
                  value={row.amount}
                  placeholder="5.00"
                  onChange={(event) => setRow(index, { amount: event.target.value })}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove bracket ${index + 1}`}
                onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
              >
                ×
              </Button>
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setRows((current) => [...current, { min: '', max: '', amount: '' }])}
          >
            Add bracket
          </Button>
        </div>
      ) : (
      <div className="w-32 space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`optprice-${option.id}`}>
          {perChar ? 'Price per character' : 'Price per unit'}
        </label>
        <Input
          id={`optprice-${option.id}`}
          value={amount}
          placeholder="0.50"
          onChange={(event) => setAmount(event.target.value)}
        />
      </div>
      )}

      {/*
        * ⚠️ **The allowance belongs to `per_char` alone.** `per_unit` has none
        * deliberately — a free-unit allowance is a volume discount, which
        * `tiered` expresses with brackets a merchant can reason about.
        */}
      {perChar ? (
        <div className="w-32 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`optfree-${option.id}`}>
            Free characters
          </label>
          <Input
            id={`optfree-${option.id}`}
            value={free}
            placeholder="0"
            onChange={(event) => setFree(event.target.value)}
          />
        </div>
      ) : null}

      <Button size="sm" disabled={save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save pricing'}
      </Button>

      {/*
        * 📌 **Every problem at once, each naming its bracket.** A merchant
        * fixing a five-bracket set one error at a time would save five times.
        */}
      {problems.length === 0 ? null : (
        <ul className="text-destructive w-full space-y-0.5 text-xs">
          {problems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {save.error === null || save.error === undefined ? null : (
        <div className="w-full">
          <ErrorState error={save.error} />
        </div>
      )}
    </div>
  );
}

/**
 * The wording a customer reads beside an option.
 *
 * 🔴 **This is what "without reading documentation" rests on.** Phase 20's exit
 * criterion asks that a merchant build a set without consulting docs; an option
 * that cannot carry its own help text pushes the explaining out of the product
 * and onto a support page — for the *customer*, not the merchant.
 *
 * ⚠️ **Behind a toggle, not always open.** Four more fields on every option
 * would bury the two that matter most — label and type — under wording most
 * options never need.
 *
 * 📌 **An emptied field CLEARS**, following `GroupDescription`: a merchant
 * deleting help text is making a choice, and treating `''` as "no change" would
 * leave text on the storefront they had just removed.
 */
/**
 * The catastrophic shape, mirroring `NESTED_QUANTIFIER` in the publish check.
 *
 * ⚠️ **A warning here, a BLOCKER there.** This tells a merchant what publish
 * will say; `patternsAreSafe` is what actually refuses. Duplicated rather than
 * fetched because the warning must appear as they type, and a shape check is
 * cheap — the cost of it drifting is a warning that disagrees with the blocker,
 * which is visible, unlike a missing one.
 */
const UNSAFE_PATTERN = /\([^)]*[+*}][^)]*\)\s*[+*]|\([^)]*[+*][^)]*\)\s*\{\d+,\}?/;

function OptionWording({
  option,
  onPatched,
}: {
  option: AuthoringOption;
  onPatched: (option: AuthoringOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(option.description ?? '');
  const [placeholder, setPlaceholder] = useState(option.placeholder ?? '');
  const [helpText, setHelpText] = useState(option.helpText ?? '');
  const [defaultValue, setDefaultValue] = useState(option.defaultValue ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * 🔴 **The limits, beside the wording that describes them.** This form let a
   * merchant write "Up to 20 characters" and not enforce twenty — advisory text
   * with no rule behind it, which is worse than neither, because the customer
   * reads a limit that does not hold.
   */
  const boundKind = optionValidationKind(option.presentation);

  /** Only a text answer has characters to pattern-match or words to refuse. */
  const textRules = option.presentation === 'text_field' || option.presentation === 'textarea';
  const storedBounds = boundKind === null
    ? { lower: '', upper: '' }
    : readOptionValidation(boundKind, option.validation);
  const [lower, setLower] = useState(storedBounds.lower);
  const [upper, setUpper] = useState(storedBounds.upper);

  /*
   * 🔴 **The three text rules, one of which is a security boundary.** M14.4
   * calls merchant-authored regex exactly that: it runs on every add-to-cart,
   * and a catastrophically backtracking one is a denial-of-service vector.
   */
  const storedRules = readTextRules(option.validation);
  const [pattern, setPattern] = useState(storedRules.pattern);
  const [charset, setCharset] = useState(storedRules.charset);
  const [words, setWords] = useState(storedRules.words);

  const save = useMutation({
    mutationFn: ({
      validation,
      display,
    }: {
      validation: Record<string, unknown> | null | undefined;
      display: Record<string, unknown> | null | undefined;
    }) =>
      updateOption(option.id, {
        description: description.trim(),
        /* Not sent for a choice option — there is no box to place it in. */
        placeholder: takesValues(option.presentation) ? undefined : placeholder.trim(),
        helpText: helpText.trim(),
        defaultValue: defaultValue.trim(),
        validation,
        display,
      }),
    onSuccess: (updated) => {
      setProblem(null);
      setOpen(false);
      onPatched(updated);
    },
  });

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        Wording
      </Button>
    );
  }

  /*
   * ⚠️ **The API's own limits, restated so the form refuses before the wire.**
   * A 400 after typing five hundred characters is a worse message than one
   * beside the field.
   */
  const tooLong =
    description.trim().length > 2000
      ? 'That description is too long.'
      : placeholder.trim().length > 200
        ? 'That placeholder is too long.'
        : helpText.trim().length > 500
          ? 'That help text is too long.'
          : defaultValue.trim().length > 255
            ? 'That default is too long.'
            : null;

  const submit = () => {
    if (tooLong !== null) {
      setProblem(tooLong);

      return;
    }

    /*
     * 🔴 **`stored` is passed so untouched rules SURVIVE.** The schemas are
     * `.strict()`, so a validation object sent without a merchant's `pattern`
     * would delete it — a length limit silently removing a rule they set last
     * week and never opened.
     */
    const bounds =
      boundKind === null
        ? undefined
        : parseOptionValidation(boundKind, { lower, upper }, option.validation);

    if (bounds !== undefined && !bounds.ok) {
      setProblem(bounds.message);

      return;
    }

    /*
     * 🔴 **Layered onto the bounds, not beside them.** Both write `validation`,
     * and `textValidationSchema` is `.strict()` — two independent objects would
     * mean whichever saved last deleted the other's fields.
     */
    const rules = textRules
      ? parseTextRules({ pattern, charset, words }, bounds?.ok === true ? bounds.validation : option.validation)
      : undefined;

    if (rules !== undefined && !rules.ok) {
      setProblem(rules.message);

      return;
    }

    const nextValidation =
      rules !== undefined && rules.ok
        ? rules.validation
        : bounds === undefined
          ? undefined
          : bounds.validation;

    /*
     * 🔴 **The counter is DERIVED from the limit, at the one call site that
     * sets both.** `text_field.php` states the contract: *"The dashboard
     * derives `character_counter` from the limit rather than offering it as a
     * separate switch, so the two cannot disagree."*
     *
     * Making `maxLength` authorable without this produced the defect M14.4b
     * names — a customer meeting a twenty-character limit with no warning,
     * *"a support ticket and often an abandoned cart"*.
     */
    const nextDisplay =
      boundKind === null ? undefined : deriveDisplay(boundKind, nextValidation, option.display);

    setProblem(null);
    save.mutate({ validation: nextValidation, display: nextDisplay });
  };

  return (
    <div className="mt-3 space-y-2 rounded-md border p-3">
      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`optdesc-${option.id}`}>
          Description — shown above the field
        </label>
        <Input
          id={`optdesc-${option.id}`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      {/*
        * ⚠️ **A placeholder means nothing on a choice option** — there is no box
        * to type into — so it is not offered, rather than offered and ignored.
        */}
      {takesValues(option.presentation) ? null : (
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`optph-${option.id}`}>
            Placeholder — greyed text inside the field
          </label>
          <Input
            id={`optph-${option.id}`}
            value={placeholder}
            onChange={(event) => setPlaceholder(event.target.value)}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`opthelp-${option.id}`}>
          Help text — shown below the field
        </label>
        <Input
          id={`opthelp-${option.id}`}
          value={helpText}
          onChange={(event) => setHelpText(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`optdef-${option.id}`}>
          Default — what the field starts with
        </label>
        <Input
          id={`optdef-${option.id}`}
          value={defaultValue}
          onChange={(event) => setDefaultValue(event.target.value)}
        />
      </div>

      {/*
        * ⚠️ **Only where an answer HAS bounds.** A choice option's answer is a
        * value id — there is nothing to limit, and `choiceValidationSchema`
        * accepts neither length nor range.
        */}
      {boundKind === null ? null : (
        <div className="flex flex-wrap gap-2">
          <div className="w-32 space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`optlo-${option.id}`}>
              {boundKind === 'length' ? 'Shortest answer' : 'Smallest number'}
            </label>
            <Input
              id={`optlo-${option.id}`}
              value={lower}
              onChange={(event) => setLower(event.target.value)}
            />
          </div>
          <div className="w-32 space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`opthi-${option.id}`}>
              {boundKind === 'length' ? 'Longest answer' : 'Largest number'}
            </label>
            <Input
              id={`opthi-${option.id}`}
              value={upper}
              onChange={(event) => setUpper(event.target.value)}
            />
          </div>
        </div>
      )}

      {/*
        * 🔴 **The three text rules.** `pattern` is the one a merchant writes as
        * code, and M14.4 calls it a security boundary — it runs on every
        * add-to-cart.
        */}
      {!textRules ? null : (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`optpat-${option.id}`}>
              Pattern the answer must match
            </label>
            <Input
              id={`optpat-${option.id}`}
              value={pattern}
              placeholder="^[A-Za-z ]+$"
              className="font-mono"
              onChange={(event) => setPattern(event.target.value)}
            />

            {/*
              * 🔴 **Saved, and the merchant is TOLD publish will refuse it.**
              * Blocking the save would stop a draft mid-edit — the registry is
              * explicit that authoring accepts an unsafe pattern — but saying
              * nothing would let them meet the blocker with no idea why.
              */}
            {pattern.trim() === '' || !UNSAFE_PATTERN.test(pattern) ? null : (
              <p className="text-destructive text-xs">
                A repetition inside a repetition can hang on some answers. This saves, but
                publish will refuse it.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <div className="w-44 space-y-1.5">
              <label className="text-xs font-medium" htmlFor={`optcs-${option.id}`}>
                Allowed characters
              </label>
              <select
                id={`optcs-${option.id}`}
                value={charset}
                onChange={(event) => setCharset(event.target.value)}
                className="border-input h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">Any</option>
                <option value="alpha">Letters only</option>
                <option value="alphanumeric">Letters and numbers</option>
                <option value="numeric">Numbers only</option>
                <option value="latin">Latin characters</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`optfw-${option.id}`}>
              Words to refuse — one per line
            </label>
            <textarea
              id={`optfw-${option.id}`}
              rows={3}
              value={words}
              onChange={(event) => setWords(event.target.value)}
              className="border-input w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" disabled={save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save wording'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      {problem === null ? null : <p className="text-destructive text-xs">{problem}</p>}

      {save.error === null || save.error === undefined ? null : <ErrorState error={save.error} />}
    </div>
  );
}

function ItemBlock({
  item,
  canEdit,
  onChanged,
  onPatched,
  onRecord,
  onMove,
  isFirst,
  isLast,
  isMoving,
}: {
  item: AuthoringItem;
  canEdit: boolean;

  /** Deletion changes the tree's shape, so it still refetches. */
  onChanged: () => void;

  /** 🔴 The saved item, so an edit patches the cache rather than refetching. */
  onPatched: (item: AuthoringItem) => void;

  /** Record the edit so it can be undone (M20.10). */
  onRecord: (entry: HistoryEntry) => void;
  onMove?: (direction: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);

  const save = useMutation({
    mutationFn: () => updateItem(item.id, { content: draft }),
    onSuccess: (updated) => {
      setEditing(false);
      onPatched(updated);

      /* The inverse is the content this item held, still on `item` here. */
      onRecord({
        label: 'Edit item',
        inverse: async () =>
          void onPatched(await updateItem(item.id, { content: item.content })),
        replay: async () =>
          void onPatched(await updateItem(item.id, { content: updated.content })),
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteItem(item.id),
    onSuccess: onChanged,
  });

  /**
   * A divider has no content to edit, and `rich_text` must not be edited here.
   *
   * ⚠️ The API refuses to create a `rich_text` item until M5.4c's sanitizer
   * exists, but a set authored by a future release could carry one. Offering an
   * editor for markup this dashboard cannot sanitise would be the wrong half of
   * that feature -- so it renders read-only.
   */
  const editable = item.kind === 'heading' || item.kind === 'paragraph';

  const label = item.kind === 'divider' ? 'Divider' : item.content;

  return (
    <div className="bg-muted/30 space-y-3 rounded-md border border-dashed p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {item.kind === 'divider' ? (
            <p className="text-muted-foreground text-sm">— Divider —</p>
          ) : (
            <p className="truncate font-medium">{label}</p>
          )}
          <p className="text-muted-foreground text-xs">
            {item.kind}
            {editable ? '' : ' · read-only'}
          </p>
        </div>

        {canEdit ? (
          <div className="flex gap-2">
            {onMove === undefined ? null : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${item.kind} up`}
                  disabled={isFirst || isMoving}
                  onClick={() => onMove(-1)}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Move ${item.kind} down`}
                  disabled={isLast || isMoving}
                  onClick={() => onMove(1)}
                >
                  ↓
                </Button>
              </>
            )}

            {!editable || editing ? null : (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}

            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        ) : null}
      </div>

      {!editing ? null : (
        <div className="space-y-2">
          <Input
            value={draft}
            aria-label={`${item.kind} text`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              /*
               * Blank is refused by the API for these kinds, so the button is
               * disabled rather than letting the merchant submit and be told no.
               */
              disabled={save.isPending || draft.trim() === ''}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(item.content);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {save.error === null || save.error === undefined ? null : <ErrorState error={save.error} />}
      {remove.error === null || remove.error === undefined ? null : (
        <ErrorState error={remove.error} />
      )}
    </div>
  );
}

/**
 * Add a heading, paragraph or divider.
 *
 * ⚠️ **`rich_text` is absent**, matching `AUTHORABLE_ITEM_KINDS` on the server.
 * The dashboard may lag the API, never lead it: offering a kind the API refuses
 * is a merchant choosing something and being handed an error.
 */
const ITEM_KINDS: ReadonlyArray<{ value: ItemKind; label: string; hint: string }> = [
  { value: 'heading', label: 'Heading', hint: 'A short title above the controls that follow.' },
  { value: 'paragraph', label: 'Paragraph', hint: 'Explanatory text. Shown as written — no markup.' },
  { value: 'divider', label: 'Divider', hint: 'A horizontal rule. No text.' },
];

/**
 * The three divider styles the API accepts (M21c.5, ADR-113).
 *
 * 🔴 **Authored here or nowhere.** The style shipped to the storefront and the
 * preview before this control existed (F37), reachable only by a raw API call —
 * a storefront field the dashboard could not set, which is the mirror image of
 * the *"setting that does nothing"* this project refuses elsewhere.
 */
const DIVIDER_STYLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

function AddItem({ groupId, onAdded }: { groupId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ItemKind>('heading');
  const [content, setContent] = useState('');
  const [dividerStyle, setDividerStyle] = useState('solid');

  const add = useMutation({
    /*
     * A divider carries no content, and the API requires the field while
     * allowing it to be empty for that kind alone. Sending the merchant's
     * half-typed heading text on a divider would store something invisible.
     */
    mutationFn: () =>
      createItem(groupId, {
        kind,
        content: kind === 'divider' ? '' : content,
        /*
         * ⚠️ **Only a divider carries `display`**, and the API's schema is
         * `.strict()` per kind — sending `{ style }` on a heading would be a
         * 400 rather than a field quietly ignored.
         */
        ...(kind === 'divider' ? { display: { style: dividerStyle } } : {}),
      }),
    onSuccess: () => {
      setContent('');
      setDividerStyle('solid');
      setKind('heading');
      setOpen(false);
      onAdded();
    },
  });

  const needsContent = kind !== 'divider';
  const hint = ITEM_KINDS.find((entry) => entry.value === kind)?.hint ?? '';

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add heading or text
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-dashed p-4">
      <p className="text-sm font-medium">Add a heading, paragraph or divider</p>

      <div className="flex flex-wrap gap-2">
        {ITEM_KINDS.map((entry) => (
          <Button
            key={entry.value}
            type="button"
            variant={kind === entry.value ? 'default' : 'outline'}
            size="sm"
            aria-pressed={kind === entry.value}
            onClick={() => setKind(entry.value)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      <p className="text-muted-foreground text-xs">{hint}</p>

      {!needsContent ? null : (
        <Input
          value={content}
          aria-label="Text"
          placeholder={kind === 'heading' ? 'Personalisation' : 'Add a short message below.'}
          onChange={(event) => setContent(event.target.value)}
        />
      )}

      {kind !== 'divider' ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">Style</span>
          {DIVIDER_STYLES.map((entry) => (
            <Button
              key={entry.value}
              type="button"
              variant={dividerStyle === entry.value ? 'default' : 'outline'}
              size="sm"
              aria-pressed={dividerStyle === entry.value}
              onClick={() => setDividerStyle(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={add.isPending || (needsContent && content.trim() === '')}
          onClick={() => add.mutate()}
        >
          {add.isPending ? 'Adding…' : 'Add'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
            setContent('');
          }}
        >
          Cancel
        </Button>
      </div>

      {add.error === null || add.error === undefined ? null : <ErrorState error={add.error} />}
    </div>
  );
}

/**
 * One value: read-only, or an inline edit form.
 *
 * 🔴 **Values were write-once.** `PATCH /values/:id` has existed since Phase 7 and
 * nothing called it, so correcting a mistyped label or price meant deleting the
 * value and recreating it — losing its id and its place in the order.
 *
 * ⚠️ **`valueKey` is shown but not editable.** It is the identifier a published
 * document, a cart line and an order line all carry: changing it would orphan
 * every order already placed under the old key. Renaming is a delete plus a
 * create, which is what it actually is — and the form says so rather than
 * leaving a merchant to wonder why the field is missing.
 */
/**
 * ⚠️ **Exported for test** (M20.10). The page renders it directly; nothing else
 * imports it. Autosave-on-row-close cannot be asserted without mounting it.
 */
export function ValueRow({
  value,
  presentation,
  canEdit,
  onChanged,
  onPatched,
  onRecord,
}: {
  value: AuthoringValue;
  /** Decides whether this value shows a colour, an image or a group. */
  presentation: string;
  canEdit: boolean;

  /** Deletion changes the tree's shape, so it still refetches. */
  onChanged: () => void;

  /** 🔴 The saved value, so an edit patches the cache rather than refetching. */
  onPatched: (value: AuthoringValue) => void;

  /**
   * Record the edit so it can be undone (M20.10).
   *
   * 🔴 **The inverse is the five previous field values**, which this row already
   * holds in order to render the form — not a snapshot of the tree, which
   * reaches 12,000 values at `AUTHORING_LIMITS` scale.
   */
  onRecord: (entry: HistoryEntry) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(value.label);
  const [amount, setAmount] = useState(formatAmount(value.priceAmountMinor));
  const [colorHex, setColorHex] = useState(value.colorHex ?? '');
  const [imageUrl, setImageUrl] = useState(value.imageUrl ?? '');
  const [groupLabel, setGroupLabel] = useState(value.groupLabel ?? '');

  /*
   * 🔴 **How this value is priced** (M20.6 audit F1). Four of five price types
   * were implemented end-to-end and unauthorable — the storefront charged a
   * percentage, the evaluators priced one, 157 shared cases proved it, and no
   * merchant could create one.
   *
   * 📌 **`fixed` and `percentage` only, because those are the VALUE-level
   * types.** `pricingConfigSchema` accepts exactly these two; `per_char`,
   * `per_unit` and `tiered` price an *option* that has no values, and belong
   * with the option editor rather than here.
   */
  const storedKind = value.priceConfig?.type === 'percentage' ? 'percentage' : 'fixed';
  const [priceKind, setPriceKind] = useState<'fixed' | 'percentage'>(storedKind);
  /*
   * 🔴 **What this choice does to fulfilment** (Phase 20 audit). `sku_suffix`
   * composes the cart item's SKU and `weight_delta_grams` changes the shipping
   * weight — both reach the cart, and neither could be set.
   */
  const [skuSuffix, setSkuSuffix] = useState(value.skuSuffix ?? '');
  const [weight, setWeight] = useState(
    typeof value.weightDeltaGrams === 'number' ? String(value.weightDeltaGrams) : '',
  );
  const [isDefault, setIsDefault] = useState(value.isDefault === true);

  const [percent, setPercent] = useState(
    typeof value.priceConfig?.basisPoints === 'number'
      ? formatBasisPoints(value.priceConfig.basisPoints)
      : '',
  );

  const { color: needsColor, image: needsImage } = swatchFieldsFor(presentation);
  const takesGroup = takesGroupLabel(presentation);

  const parsed = valueSchema.safeParse({
    valueKey: value.valueKey,
    label,
    amount,
    colorHex,
    imageUrl,
    groupLabel,
  });

  const save = useMutation({
    mutationFn: () => {
      const money = amount.trim() === '' ? null : parseAmount(amount);

      const points = priceKind === 'percentage' ? parsePercent(percent) : null;

      return updateValue(value.id, {
        label: label.trim(),
        priceAmountMinor: money !== null && money.ok ? money.minor : undefined,
        /*
         * 🔴 **`null` CLEARS a stored percentage**, and that matters: switching
         * back to a flat amount without clearing would leave the storefront
         * charging the percentage the merchant just abandoned, while the editor
         * showed the flat figure.
         *
         * ⚠️ **`basisPoints` — the STORED shape, camelCase.** The API validates
         * `pricingConfigSchema`, which is written in the stored dialect; the
         * wire shape is the serializer's job, not this form's.
         */
        priceConfig:
          points !== null && points.ok
            ? { type: 'percentage', basisPoints: points.basisPoints }
            : null,
        /*
         * `null` clears; `undefined` leaves unchanged. A field this type does
         * not use is left alone rather than cleared — a merchant switching a
         * radio to a swatch should not find the colour they set has gone.
         */
        colorHex: needsColor ? (colorHex.trim() === '' ? null : colorHex.trim()) : undefined,
        imageUrl: needsImage ? (imageUrl.trim() === '' ? null : imageUrl.trim()) : undefined,
        groupLabel: takesGroup ? (groupLabel.trim() === '' ? null : groupLabel.trim()) : undefined,
        /*
         * ⚠️ **A blank weight CLEARS rather than saving zero.** "No change" and
         * "exactly 0g" are the same number and different intents, and the
         * column is nullable for that reason.
         */
        skuSuffix: skuSuffix.trim() === '' ? null : skuSuffix.trim(),
        weightDeltaGrams: weight.trim() === '' ? null : Number(weight.trim()),
        isDefault,
      });
    },
    onSuccess: (updated) => {
      setEditing(false);
      onPatched(updated);

      /*
       * 🔴 **Recorded only on SUCCESS.** A refused save changed nothing, and an
       * entry for it would offer to undo an edit the server never applied.
       *
       * 📌 Both directions are plain `updateValue` calls over values captured
       * here, so undo and redo cost one small request each and cannot drift
       * from what the row actually wrote.
       */
      const before = {
        label: value.label,
        priceAmountMinor: value.priceAmountMinor,
        colorHex: needsColor ? (value.colorHex ?? null) : undefined,
        imageUrl: needsImage ? (value.imageUrl ?? null) : undefined,
        groupLabel: takesGroup ? (value.groupLabel ?? null) : undefined,
      };

      const after = {
        label: updated.label,
        priceAmountMinor: updated.priceAmountMinor,
        colorHex: needsColor ? (updated.colorHex ?? null) : undefined,
        imageUrl: needsImage ? (updated.imageUrl ?? null) : undefined,
        groupLabel: takesGroup ? (updated.groupLabel ?? null) : undefined,
      };

      onRecord({
        label: `Edit ${value.label}`,
        inverse: async () => void onPatched(await updateValue(value.id, before)),
        replay: async () => void onPatched(await updateValue(value.id, after)),
      });
    },
  });

  /**
   * Whether the draft differs from what is stored.
   *
   * 🔴 **Autosave must not write an untouched row.** Opening a value to read it
   * and clicking away is not an edit; writing there would bump the row version
   * and mark the set as differing from what the storefront serves, for nothing.
   */
  /*
   * 🔴 **A signed integer, or blank.** A lighter variant is real — hollow
   * rather than solid — and `@IsInt()` accepts a negative, so refusing one here
   * would be the form disagreeing with the API.
   */
  const weightOk = weight.trim() === '' || /^-?\d+$/.test(weight.trim());
  const skuOk = skuSuffix.trim().length <= 40;

  const isDirty =
    skuSuffix !== (value.skuSuffix ?? '') ||
    weight !== (typeof value.weightDeltaGrams === 'number' ? String(value.weightDeltaGrams) : '') ||
    isDefault !== (value.isDefault === true) ||
    priceKind !== storedKind ||
    percent !==
      (typeof value.priceConfig?.basisPoints === 'number'
        ? formatBasisPoints(value.priceConfig.basisPoints)
        : '') ||
    label !== value.label ||
    amount !== formatAmount(value.priceAmountMinor) ||
    colorHex !== (value.colorHex ?? '') ||
    imageUrl !== (value.imageUrl ?? '') ||
    groupLabel !== (value.groupLabel ?? '');

  /*
   * 🔴 **Publish this row's dirty state, for the two paths that destroy it.**
   *
   * `useUnsavedGuard` covers closing the tab; the registry covers the group
   * switch, which `beforeunload` cannot see. Both were blind to `ValueRow`
   * until M20.10's audit — measured, with a half-typed edit: `confirmCalled=0
   * rowDestroyed=true` on a switch, and `unloadPrevented=false` on unload.
   *
   * ⚠️ **Deregisters on unmount**, so a row that is saved, cancelled or
   * remounted stops being asked about. A stale id would make the guard warn
   * about work that no longer exists.
   */
  useUnsavedGuard(editing && isDirty);

  useEffect(() => {
    setValueDirty(value.id, editing && isDirty);

    return () => setValueDirty(value.id, false);
  }, [value.id, editing, isDirty]);

  /**
   * Commit when focus leaves the **row** — the interaction that replaced Save.
   *
   * 🔴 **The save unit is the row, not the field.** These five fields describe
   * one value and `updateValue` writes them as one request. Saving per-field
   * would be five writes and five failure surfaces for one edit — and it would
   * make Cancel a lie, because tabbing from Label to Price would already have
   * committed the label. Focus moving *within* the row is therefore not a
   * close, which is what keeps Cancel meaningful.
   *
   * ⚠️ **A null `relatedTarget` means two different things**, and only
   * `document.hasFocus()` tells them apart: clicking a heading, a paragraph or
   * blank space (not focusable, so no new target) versus switching window.
   *
   * 🔴 **Treating both as a window switch lost edits.** Skipping the save
   * whenever `relatedTarget` was null also skipped it for the most ordinary way
   * to leave a row — clicking somewhere else on the page. The canonical E2E
   * caught it: the row still open, "Matte black" typed, nothing written. A
   * window switch still does not commit, so an alt-tab mid-thought is safe.
   */
  const closeRow = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;

    if (next !== null && event.currentTarget.contains(next)) {
      return;
    }

    if (next === null && !document.hasFocus()) {
      return;
    }

    /*
     * 🔴 **A percentage must PARSE before autosave writes.** `valueSchema`
     * validates the flat amount field and knows nothing about this one, so
     * without this a malformed percentage would be sent as `null` — silently
     * turning a priced value free.
     */
    const percentOk = priceKind !== 'percentage' || parsePercent(percent).ok;

    if (isDirty && parsed.success && percentOk && weightOk && skuOk && !save.isPending) {
      save.mutate();
    }
  };

  /*
   * 🔴 **The reversible alternative to removing a value** (Phase 20 audit). The
   * publish serializer filters disabled values out, so taking a colour off sale
   * for a fortnight is a flag — where a delete is a shape change that clears the
   * undo log, with no restore endpoint.
   */
  const toggleEnabled = useMutation({
    mutationFn: () => updateValue(value.id, { isEnabled: value.isEnabled === false }),
    onSuccess: onPatched,
  });

  /** Reset the draft to what is stored, so Cancel really cancels. */
  const cancel = () => {
    setLabel(value.label);
    setAmount(formatAmount(value.priceAmountMinor));
    setColorHex(value.colorHex ?? '');
    setImageUrl(value.imageUrl ?? '');
    setGroupLabel(value.groupLabel ?? '');
    setSkuSuffix(value.skuSuffix ?? '');
    setWeight(typeof value.weightDeltaGrams === 'number' ? String(value.weightDeltaGrams) : '');
    setIsDefault(value.isDefault === true);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span>
          {value.label}{' '}
          <span className="text-muted-foreground text-xs">({value.valueKey})</span>
          {/*
            Shown so a merchant can see which heading a value sits under without
            opening the form -- grouping is invisible in a flat list otherwise,
            and two values under different headings look identical.
          */}
          {value.groupLabel === null ||
          value.groupLabel === undefined ||
          value.groupLabel === '' ? null : (
            <span className="text-muted-foreground ml-2 rounded border px-1.5 py-0.5 text-xs">
              {value.groupLabel}
            </span>
          )}
        </span>
        <span className="flex items-center gap-3">
          {/* Stored in minor units; shown as a merchant would write it. */}
          <span className="font-medium">{formatAmount(value.priceAmountMinor)}</span>
          {canEdit ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Edit ${value.label}`}
                onClick={() => {
                  /*
                   * 🔴 **Reseed from the tree, because the drafts may be
                   * stale.** These five fields are seeded from the prop once
                   * and `key={value.id}` does not change on an edit, so a row
                   * closed while its value changed elsewhere — an undo, another
                   * editor — would reopen showing what it held last time.
                   * Measured: prop "Gloss", reopened editor "Matte".
                   *
                   * ⚠️ **On OPEN, not on every prop change.** Resyncing
                   * whenever the prop moved would discard a half-typed edit the
                   * moment a background refetch landed.
                   */
                  setLabel(value.label);
                  setAmount(formatAmount(value.priceAmountMinor));
                  setColorHex(value.colorHex ?? '');
                  setImageUrl(value.imageUrl ?? '');
                  setGroupLabel(value.groupLabel ?? '');
                  setSkuSuffix(value.skuSuffix ?? '');
                  setWeight(
                    typeof value.weightDeltaGrams === 'number'
                      ? String(value.weightDeltaGrams)
                      : '',
                  );
                  setIsDefault(value.isDefault === true);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              {/* 🔴 Reversible, where × is not — see the group toggle above. */}
              <Button
                variant="ghost"
                size="sm"
                disabled={toggleEnabled.isPending}
                onClick={() => toggleEnabled.mutate()}
              >
                {value.isEnabled === false ? `Enable ${value.label}` : `Disable ${value.label}`}
              </Button>
              <RemoveValue id={value.id} onRemoved={onChanged} />
            </>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3" data-value-row onBlur={closeRow}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`label-${value.id}`}>
            Label
          </label>
          <Input
            id={`label-${value.id}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        {/*
          * 🔴 **How this value is priced** (M20.6 audit F1). A percentage was
          * chargeable by the storefront, priceable by the evaluators and proven
          * by 157 shared cases — and unauthorable, because this form offered a
          * flat amount and nothing else.
          */}
        <div className="w-32 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`pricekind-${value.id}`}>
            Price type
          </label>
          <select
            id={`pricekind-${value.id}`}
            value={priceKind}
            onChange={(e) => setPriceKind(e.target.value as 'fixed' | 'percentage')}
            className="border-input h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="fixed">Flat amount</option>
            <option value="percentage">Percentage</option>
          </select>
        </div>

        {/*
          * ⚠️ **One price field at a time.** Showing both would leave a merchant
          * unsure which one the storefront reads — and the answer, that
          * `priceConfig` wins, is not something a form should make them learn.
          */}
        {priceKind === 'fixed' ? (
          <div className="w-28 space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`amount-${value.id}`}>
              Price
            </label>
            <Input
              id={`amount-${value.id}`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        ) : (
          <div className="w-28 space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`percent-${value.id}`}>
              Percent
            </label>
            <Input
              id={`percent-${value.id}`}
              value={percent}
              placeholder="2.5"
              onChange={(e) => setPercent(e.target.value)}
            />
          </div>
        )}

        {takesGroup ? (
          <div className="w-40 space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`egroup-${value.id}`}>
              Group
            </label>
            <Input
              id={`egroup-${value.id}`}
              value={groupLabel}
              placeholder="Standard sizes"
              onChange={(e) => setGroupLabel(e.target.value)}
            />
          </div>
        ) : null}

        {needsColor ? (
          <div className="w-32 space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`ecolor-${value.id}`}>
              Colour
            </label>
            <Input
              id={`ecolor-${value.id}`}
              value={colorHex}
              placeholder="#1a2b3c"
              onChange={(e) => setColorHex(e.target.value)}
            />
          </div>
        ) : null}

        {needsImage ? (
          <div className="w-48 space-y-1.5">
            <label className="text-xs font-medium" htmlFor={`eimage-${value.id}`}>
              Image URL
            </label>
            <Input
              id={`eimage-${value.id}`}
              value={imageUrl}
              placeholder="https://…"
              onChange={(e) => setImageUrl(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      {/*
        * 🔴 **What this choice does to fulfilment.** `sku_suffix` composes the
        * cart item's SKU and `weight_delta_grams` changes the shipping weight —
        * both have reached the cart since M14 and neither could be set.
        */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-36 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`sku-${value.id}`}>
            SKU suffix
          </label>
          <Input
            id={`sku-${value.id}`}
            value={skuSuffix}
            placeholder="-ENG"
            onChange={(e) => setSkuSuffix(e.target.value)}
          />
        </div>

        <div className="w-36 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`weight-${value.id}`}>
            Weight change (g)
          </label>
          {/* Signed: a lighter variant is as real as a heavier one. */}
          <Input
            id={`weight-${value.id}`}
            value={weight}
            placeholder="50"
            onChange={(e) => setWeight(e.target.value)}
          />
        </div>

        <label className="flex items-center gap-2 pb-2 text-xs font-medium">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          Chosen by default
        </label>
      </div>

      {weightOk ? null : (
        <p className="text-destructive text-xs">
          A weight change must be a whole number of grams, or blank.
        </p>
      )}

      {skuOk ? null : (
        <p className="text-destructive text-xs">That SKU suffix is longer than 40 characters.</p>
      )}

      <p className="text-muted-foreground text-xs">
        Key <code>{value.valueKey}</code> cannot be changed — orders already placed carry it.
      </p>

      {/*
        * 🔴 **No Save button: leaving the row commits.** What replaces it is a
        * statement of that rule, because an autosaving form that says nothing
        * leaves a merchant unsure whether their edit was kept.
        */}
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <span className="text-muted-foreground text-xs" aria-live="polite">
          {save.isPending ? 'Saving…' : 'Changes save when you leave this row'}
        </span>
      </div>

      {parsed.success || !parsed.error.issues[0] ? null : (
        <p className="text-destructive text-xs">{parsed.error.issues[0].message}</p>
      )}

      {/*
        * 🔴 **A refused percentage has to say so.** Autosave writes on leaving
        * the row, so an unparseable one produces no request and no error — the
        * edit simply does not happen, which reads as a broken editor rather
        * than a wrong value.
        */}
      {priceKind !== 'percentage' || percent === '' || parsePercent(percent).ok ? null : (
        <p className="text-destructive text-xs">
          Enter a percentage like 2.5, up to two decimal places.
        </p>
      )}

      {save.error === null || save.error === undefined ? null : <ErrorState error={save.error} />}
    </div>
  );
}

function RemoveValue({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  const remove = useMutation({ mutationFn: () => deleteValue(id), onSuccess: onRemoved });

  return (
    <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
      ×
    </Button>
  );
}

/**
 * Bulk paste (M20.4) — "merchants have existing lists".
 *
 * 🔴 **Parsed and refused up front; a bad paste writes NOTHING.** The API
 * checks `valuesPerOption` and key uniqueness on **each** create, so a list that
 * breaks either rule fails partway and leaves values the merchant never
 * confirmed — and cannot undo, because a create is a shape change and shape
 * changes clear the undo log. `parsePastedValues` applies every one of those
 * rules to the whole list before a single request goes out.
 *
 * ⚠️ **Written sequentially rather than in parallel.** `chunk()` exists for the
 * product picker, where the API takes many targets per request; values are one
 * create each, and firing five hundred at once would trip the rate limiter that
 * signs a merchant out — the exact failure that cost four attempts to diagnose
 * in Phase 19.
 */
function PasteValues({
  optionId,
  existingKeys,
  onAdded,
}: {
  optionId: string;
  /** What the option already holds — both limits count against it. */
  existingKeys: string[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<PasteProblem[]>([]);

  const create = useMutation({
    mutationFn: async (values: PastedValue[]) => {
      /*
       * 🔴 **One at a time, and stopping at the first refusal.** Nothing here
       * can be rolled back, so continuing past an error would widen a
       * part-write the validation is meant to have prevented entirely.
       */
      for (const value of values) {
        await createValue(optionId, {
          valueKey: value.valueKey,
          label: value.label,
          priceAmountMinor: value.priceAmountMinor,
        });
      }
    },
    onSuccess: () => {
      setText('');
      setProblems([]);
      setOpen(false);
      onAdded();
    },
  });

  const submit = () => {
    const parsed = parsePastedValues(text, existingKeys);

    if (!parsed.ok) {
      setProblems(parsed.problems);

      return;
    }

    setProblems([]);
    create.mutate(parsed.values);
  };

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        Paste a list
      </Button>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border p-3">
      <label className="text-xs font-medium" htmlFor={`paste-${optionId}`}>
        One value per line — <code>Label</code> or <code>Label,10.50</code>
      </label>

      <textarea
        id={`paste-${optionId}`}
        rows={6}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={'Small,0.00\nMedium,2.50\nLarge,5.00'}
        className="border-input w-full rounded-md border px-3 py-2 font-mono text-sm"
      />

      <div className="flex gap-2">
        <Button size="sm" disabled={create.isPending} onClick={submit}>
          {create.isPending ? 'Adding…' : 'Add values'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
            setProblems([]);
          }}
        >
          Cancel
        </Button>
      </div>

      {/*
        * 🔴 **Every problem at once, each naming its line.** A merchant fixing a
        * hundred-line paste one error at a time would paste a hundred times.
        */}
      {problems.length === 0 ? null : (
        <ul className="text-destructive space-y-0.5 text-xs">
          {problems.map((problem) => (
            <li key={`${problem.line}-${problem.message}`}>
              Line {problem.line}: {problem.message}
            </li>
          ))}
        </ul>
      )}

      {create.error === null || create.error === undefined ? null : (
        <ErrorState error={create.error} />
      )}
    </div>
  );
}

function AddValue({
  optionId,
  presentation,
  onAdded,
}: {
  optionId: string;
  /** Decides whether this value needs a colour or an image. */
  presentation: string;
  onAdded: () => void;
}) {
  const [valueKey, setValueKey] = useState('');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [colorHex, setColorHex] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [groupLabel, setGroupLabel] = useState('');

  /*
   * 🔴 **A swatch without its swatch renders as a plain radio.**
   *
   * The storefront template drops a chip it has no colour for — deliberately,
   * since a blank or malformed colour must not reach a `style` attribute. So a
   * merchant who authors a colour swatch and cannot set colours publishes
   * something that looks broken and is technically correct.
   *
   * The field appears only where it means something: asking a radio's values for
   * a hex code is noise, and noise is how a form teaches merchants to ignore it.
   *
   * ⚠️ **The rule lives in `swatchFieldsFor`, not here.** Inlined, it was
   * untestable — this component needs a QueryClient provider — and two mutants
   * survived: hiding the field, and sending the colour for every type.
   */
  const { color: needsColor, image: needsImage } = swatchFieldsFor(presentation);

  /*
   * Grouping is a `<select>` affordance, so the field appears for `dropdown`
   * alone -- the same rule as the swatch fields, and in a helper for the same
   * reason: inlined it cannot be tested without a QueryClient provider.
   */
  const takesGroup = takesGroupLabel(presentation);

  const parsed = valueSchema.safeParse({ valueKey, label, amount, colorHex, imageUrl, groupLabel });

  const add = useMutation({
    mutationFn: () => {
      /*
       * The merchant typed pounds; the API stores minor units. `parseAmount` is
       * string-based -- `17.9 * 100` is `1789` -- and a blank amount means no
       * price change rather than zero, which the API treats as its default.
       */
      const money = amount.trim() === '' ? null : parseAmount(amount);

      return createValue(optionId, {
        valueKey,
        label,
        priceAmountMinor: money !== null && money.ok ? money.minor : undefined,
        /* Sent only when this type uses it, and never as an empty string: the
         * API's `@IsOptional` skips an absent field and rejects a blank one. */
        colorHex: needsColor && colorHex.trim() !== '' ? colorHex.trim() : undefined,
        imageUrl: needsImage && imageUrl.trim() !== '' ? imageUrl.trim() : undefined,
        groupLabel: takesGroup && groupLabel.trim() !== '' ? groupLabel.trim() : undefined,
      });
    },
    onSuccess: () => {
      setValueKey('');
      setLabel('');
      setAmount('');
      setColorHex('');
      setImageUrl('');
      /*
       * Deliberately NOT cleared: a merchant adding "Small", "Medium", "Large"
       * under one heading types it once. The other fields identify a single
       * value; this one identifies a run of them.
       */
      onAdded();
    },
  });

  return (
    <div className="flex flex-wrap items-end gap-2 border-t pt-3">
      {/*
        🔴 **Scoped by `optionId`, because this form renders once per option.**
        A bare `id="value-label"` would repeat on every option in the set, and a
        duplicated id makes `htmlFor` ambiguous — the browser binds the first,
        so every later label points at the wrong input. That is the same
        per-instance shape `group-${optionId}` below already uses.

        ⚠️ These three were unbound `<label>` elements until M19.1'. A screen
        reader announced them as unlabelled, and the E2E could only address them
        by placeholder — example copy, which is how the canonical suite drifted
        out of sync with this page unnoticed.
      */}
      <div className="flex-1 space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`value-label-${optionId}`}>
          Value label
        </label>
        <Input
          id={`value-label-${optionId}`}
          value={label}
          placeholder="Luxury"
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="flex-1 space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`value-key-${optionId}`}>
          Key
        </label>
        <Input
          id={`value-key-${optionId}`}
          value={valueKey}
          placeholder="lux"
          onChange={(e) => setValueKey(e.target.value)}
        />
      </div>
      <div className="w-28 space-y-1.5">
        <label className="text-xs font-medium" htmlFor={`value-price-${optionId}`}>
          Price
        </label>
        <Input
          id={`value-price-${optionId}`}
          value={amount}
          placeholder="10.50"
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      {takesGroup ? (
        <div className="w-40 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`group-${optionId}`}>
            Group (optional)
          </label>
          {/*
            Blank means "not grouped", which is what every dropdown authored
            before grouping existed has. Values sharing a heading render under
            one `<optgroup>` -- see `takesGroupLabel`.
          */}
          <Input
            id={`group-${optionId}`}
            value={groupLabel}
            placeholder="Standard sizes"
            onChange={(e) => setGroupLabel(e.target.value)}
          />
        </div>
      ) : null}

      {needsColor ? (
        <div className="w-32 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`color-${optionId}`}>
            Colour
          </label>
          {/*
            A `type="color"` picker would be friendlier and cannot express
            "unset" — it always holds a value, so every swatch would silently
            default to black. A text field can be left blank, which is what a
            merchant who has not chosen yet actually means.
          */}
          <Input
            id={`color-${optionId}`}
            value={colorHex}
            placeholder="#1a2b3c"
            onChange={(e) => setColorHex(e.target.value)}
          />
        </div>
      ) : null}

      {needsImage ? (
        <div className="w-48 space-y-1.5">
          <label className="text-xs font-medium" htmlFor={`image-${optionId}`}>
            Image URL
          </label>
          <Input
            id={`image-${optionId}`}
            value={imageUrl}
            placeholder="https://…/swatch.png"
            onChange={(e) => setImageUrl(e.target.value)}
          />
        </div>
      ) : null}

      <Button size="sm" disabled={!parsed.success || add.isPending} onClick={() => add.mutate()}>
        {add.isPending ? 'Adding…' : 'Add value'}
      </Button>

      {parsed.success || (valueKey === '' && label === '' && amount === '') ? null : (
        <p className="text-destructive w-full text-xs">{parsed.error.issues[0].message}</p>
      )}
      {add.error === null || add.error === undefined ? null : (
        <div className="w-full">
          <ErrorState error={add.error} />
        </div>
      )}
    </div>
  );
}

/**
 * Publish, after asking what would stop it.
 *
 * `publish-check` returns findings with a `subject` (`option:<id>`), so a blocker
 * names the thing rather than being one line in a list. Warnings do not block and
 * are shown again after success, because a merchant should know what shipped.
 */
function PublishPanel({ set, onPublished }: { set: AuthoringSet; onPublished: () => void }) {
  const check = useQuery({
    queryKey: ['option-set', set.id, 'publish-check'],
    queryFn: () => publishCheck(set.id),
  });

  /**
   * The **authoritative** lock token, refetched after every patched edit.
   *
   * 🔴 **`set.rowVersion` goes stale the moment an edit is patched rather than
   * refetched.** The backend advances the parent set's version on every child
   * edit, and the edit response carries only the entity — so the tree in cache
   * keeps the version it loaded with. Sending that stale number answered **409
   * "This option set was changed by someone else."** after a merchant edited a
   * value and pressed Publish, naming a conflict they had caused themselves.
   *
   * ⚠️ **Refetched rather than incremented.** Adding one would usually be right
   * and is the wrong fix: under a concurrent edit a guessed version can
   * coincidentally match the row, the write succeeds, and another merchant's
   * work is lost with no error — the failure the lock exists to prevent.
   *
   * 📌 Falls back to the tree's copy until it resolves, which is correct on
   * first load: nothing has been patched yet, so the two agree.
   */
  const version = useQuery({
    queryKey: optionSetKeys.version(set.id),
    queryFn: () => loadSetVersion(set.id),
    initialData: set.rowVersion,
  });

  const rowVersion = version.data;

  const publish = useMutation({
    mutationFn: () => publishSet(set.id, rowVersion),
    onSuccess: onPublished,
  });

  /**
   * The set's published history, and the way back to any of it (M20.9).
   *
   * 🔴 **Keyed on `rowVersion` so a publish refreshes it.** The history gains a
   * row every time this panel publishes; a cached list would leave a merchant
   * looking at a version that is no longer the newest, and "live now" would
   * point at the wrong one.
   */
  const history = useQuery({
    queryKey: optionSetKeys.versions(set.id, rowVersion),
    queryFn: () => listVersions(set.id),
  });

  /*
   * ⚠️ **`rowVersion` goes with the request.** Two people looking at the same
   * history, both choosing a version, must not have the second silently win —
   * the API refuses a stale one rather than applying it.
   */
  const restore = useMutation({
    mutationFn: (target: number) => rollbackTo(set.id, target, rowVersion),
    onSuccess: onPublished,
  });

  const blockers = (check.data ?? []).filter((f) => f.severity === 'blocker');
  const warnings = (check.data ?? []).filter((f) => f.severity === 'warning');

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <h2 className="font-medium">Publish</h2>

        {blockers.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>Fix these first</AlertTitle>
            <AlertDescription>
              <FindingList findings={blockers} />
            </AlertDescription>
          </Alert>
        ) : null}

        {warnings.length > 0 ? (
          <Alert>
            <AlertTitle>Worth knowing</AlertTitle>
            <AlertDescription>
              <FindingList findings={warnings} />
            </AlertDescription>
          </Alert>
        ) : null}

        {publish.data === undefined ? null : (
          <Alert>
            <AlertDescription>
              Published version {publish.data.version}. Your storefront reaches configuration{' '}
              v{publish.data.configVersion} within a few minutes.
            </AlertDescription>
          </Alert>
        )}

        {publish.error === null || publish.error === undefined ? null : (
          <ConflictAwareError error={publish.error} />
        )}

        <Button
          disabled={blockers.length > 0 || publish.isPending || check.isLoading}
          onClick={() => publish.mutate()}
        >
          {publish.isPending ? 'Publishing…' : 'Publish to storefront'}
        </Button>

        {/*
          * The history, and the way back (M20.9).
          *
          * 🔴 **Phase 20's exit says "publish is reversible".** The endpoint has
          * existed since Phase 7 with no caller: a merchant could be told their
          * changes were unpublished and had no way to see what *was* live, let
          * alone return to it.
          */}
        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Published history</h3>

          {restore.error === null || restore.error === undefined ? null : (
            <ConflictAwareError error={restore.error} />
          )}

          <AsyncState
            isLoading={history.isLoading}
            error={history.error}
            data={history.data}
            onRetry={() => void history.refetch()}
            empty={
              <p className="text-muted-foreground text-sm">
                Nothing published yet. Publishing writes the first version.
              </p>
            }
          >
            {(versions) => (
              <VersionHistory
                versions={versions}
                currentVersion={set.version}
                canPublish
                isRestoring={restore.isPending}
                onRestore={(version) => restore.mutate(version)}
              />
            )}
          </AsyncState>
        </div>
      </CardContent>
    </Card>
  );
}


