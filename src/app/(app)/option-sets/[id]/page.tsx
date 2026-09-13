'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { GroupLayout } from '@/components/option-sets/group-layout';
import { OptionPreview } from '@/components/option-sets/option-preview';
import { RulesPanel } from '@/components/option-sets/rules-panel';
import { ProductPicker } from '@/components/products/product-picker';
import { useSession } from '@/components/providers/session-provider';
import { ConflictAwareError, ErrorState, FullPageLoading } from '@/components/layout/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { roleCan } from '@/lib/auth/capabilities';
import { formatAmount, parseAmount } from '@/lib/money/money';
import {
  createGroup,
  createItem,
  createOption,
  createValue,
  deleteGroup,
  deleteItem,
  deleteOption,
  deleteValue,
  hasUnpublishedChanges,
  loadSet,
  publishCheck,
  publishSet,
  reorderItems,
  reorderOptions,
  updateItem,
  updateOption,
  updateValue,
  type AuthoringItem,
  type AuthoringOption,
  type AuthoringValue,
  type AuthoringSet,
  type ItemKind,
  type PublishFinding,
} from '@/lib/option-sets/api';
import { mergedEntries, reorderPayloads } from '@/lib/option-sets/entries';
import {
  AUTHORABLE_TYPES,
  acceptsLength,
  configFor,
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
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['option-set', setId] });

  if (query.isLoading) {
    return <FullPageLoading />;
  }

  if (query.error !== null || query.data === undefined) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const set = query.data;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/option-sets" className="text-muted-foreground text-sm hover:underline">
          ← All option sets
        </Link>
        <h1 className="text-2xl font-semibold">{set.name}</h1>
        <p className="text-muted-foreground text-sm">
          {set.status === 'published' ? `Published, version ${set.version}` : 'Draft'}
        </p>
      </div>

      <UnpublishedNotice set={set} canPublish={canPublish} />

      {set.groups.length === 0 ? (
        <Alert>
          <AlertTitle>Nothing here yet</AlertTitle>
          <AlertDescription>
            A group holds related options — “Finish”, “Size”. Add one to begin.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-4">
        {set.groups.map((group) => (
          <GroupCard key={group.id} group={group} canEdit={canEdit} onChanged={reload} />
        ))}
      </div>

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

      {canPublish ? <PublishPanel set={set} onPublished={reload} /> : null}
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
function UnpublishedNotice({ set, canPublish }: { set: AuthoringSet; canPublish: boolean }) {
  const dirty = useQuery({
    queryKey: ['option-set', set.id, 'unpublished', set.rowVersion],
    queryFn: () => hasUnpublishedChanges(set.id, set.version),
    enabled: set.status === 'published' && set.version > 0,
    /*
     * Keyed on `rowVersion` so every edit re-asks: the answer changes the moment
     * a merchant changes anything, and a cached "no changes" is exactly the
     * wrong thing to keep showing.
     */
    retry: false,
  });

  if (dirty.data !== true) {
    return null;
  }

  return (
    <Alert>
      <AlertTitle>Your storefront is still serving version {set.version}</AlertTitle>
      <AlertDescription>
        {canPublish
          ? 'These changes are saved but not live. Publish again to send them to your store.'
          : 'These changes are saved but not live. An owner or admin can publish them.'}
      </AlertDescription>
    </Alert>
  );
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
          <label className="text-sm font-medium">New group</label>
          <Input
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

function GroupCard({
  group,
  canEdit,
  onChanged,
}: {
  group: AuthoringSet['groups'][number];
  canEdit: boolean;
  onChanged: () => void;
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
            <GroupLayout group={group} canEdit={canEdit} onChanged={onChanged} />

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

function AddOption({ groupId, onAdded }: { groupId: string; onAdded: () => void }) {
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [presentation, setPresentation] = useState<string>('radio');
  const [isRequired, setIsRequired] = useState(false);
  /* The raw field, not a number: an empty box is "no limit", and coercing as
   * they type would turn a half-deleted "20" into a limit of 2. */
  const [maxLengthText, setMaxLengthText] = useState('');
  const [minLengthText, setMinLengthText] = useState('');

  /*
   * Whether the merchant has edited the key themselves. Until they do it
   * follows the label; afterwards it is theirs and must not be overwritten.
   */
  const [keyTouched, setKeyTouched] = useState(false);

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
        ...configFor(presentation, maxLength, minLength),
      }),
    onSuccess: () => {
      setKey('');
      setLabel('');
      setPresentation('radio');
      setIsRequired(false);
      setMaxLengthText('');
      setMinLengthText('');
      setKeyTouched(false);
      onAdded();
    },
  });

  const issue = (field: string) =>
    parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === field)?.message;

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
            <label className="text-sm font-medium" htmlFor="option-label">
              Label
            </label>
            <Input
              id="option-label"
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
            <label className="text-sm font-medium" htmlFor="option-key">
              Key
            </label>
            <Input
              id="option-key"
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
                <label className="text-sm font-medium" htmlFor="option-min-length">
                  Minimum
                </label>
                <Input
                  id="option-min-length"
                  type="number"
                  min={1}
                  value={minLengthText}
                  placeholder="3"
                  onChange={(e) => setMinLengthText(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="option-max-length">
                  Maximum
                </label>
                <Input
                  id="option-max-length"
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

        <div className="flex items-center gap-3">
          <Button disabled={!parsed.success || add.isPending} onClick={() => add.mutate()}>
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
  onMove,
  isFirst,
  isLast,
  isMoving,
}: {
  option: AuthoringOption;
  canEdit: boolean;
  onChanged: () => void;
  /** Absent when there is nothing to reorder, or the role may not. */
  onMove?: (direction: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
}) {
  const toggleRequired = useMutation({
    mutationFn: () => updateOption(option.id, { isRequired: !option.isRequired }),
    onSuccess: onChanged,
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
            />
          </li>
        ))}
      </ul>

      {/*
        * A text option has no values — the customer types the answer — so the
        * "add value" form is not offered for one. The rule lives in
        * `takesValues()` beside the schema rather than as a condition here,
        * because a rule expressed only in JSX is one no test can mutate.
        */}
      {canEdit && takesValues(option.presentation) ? (
        <AddValue
          optionId={option.id}
          presentation={option.presentation}
          onAdded={onChanged}
        />
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
function ItemBlock({
  item,
  canEdit,
  onChanged,
  onMove,
  isFirst,
  isLast,
  isMoving,
}: {
  item: AuthoringItem;
  canEdit: boolean;
  onChanged: () => void;
  onMove?: (direction: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
  isMoving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);

  const save = useMutation({
    mutationFn: () => updateItem(item.id, { content: draft }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
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

function AddItem({ groupId, onAdded }: { groupId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ItemKind>('heading');
  const [content, setContent] = useState('');

  const add = useMutation({
    /*
     * A divider carries no content, and the API requires the field while
     * allowing it to be empty for that kind alone. Sending the merchant's
     * half-typed heading text on a divider would store something invisible.
     */
    mutationFn: () => createItem(groupId, { kind, content: kind === 'divider' ? '' : content }),
    onSuccess: () => {
      setContent('');
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
function ValueRow({
  value,
  presentation,
  canEdit,
  onChanged,
}: {
  value: AuthoringValue;
  /** Decides whether this value shows a colour, an image or a group. */
  presentation: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(value.label);
  const [amount, setAmount] = useState(formatAmount(value.priceAmountMinor));
  const [colorHex, setColorHex] = useState(value.colorHex ?? '');
  const [imageUrl, setImageUrl] = useState(value.imageUrl ?? '');
  const [groupLabel, setGroupLabel] = useState(value.groupLabel ?? '');

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

      return updateValue(value.id, {
        label: label.trim(),
        priceAmountMinor: money !== null && money.ok ? money.minor : undefined,
        /*
         * `null` clears; `undefined` leaves unchanged. A field this type does
         * not use is left alone rather than cleared — a merchant switching a
         * radio to a swatch should not find the colour they set has gone.
         */
        colorHex: needsColor ? (colorHex.trim() === '' ? null : colorHex.trim()) : undefined,
        imageUrl: needsImage ? (imageUrl.trim() === '' ? null : imageUrl.trim()) : undefined,
        groupLabel: takesGroup ? (groupLabel.trim() === '' ? null : groupLabel.trim()) : undefined,
      });
    },
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });

  /** Reset the draft to what is stored, so Cancel really cancels. */
  const cancel = () => {
    setLabel(value.label);
    setAmount(formatAmount(value.priceAmountMinor));
    setColorHex(value.colorHex ?? '');
    setImageUrl(value.imageUrl ?? '');
    setGroupLabel(value.groupLabel ?? '');
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
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              <RemoveValue id={value.id} onRemoved={onChanged} />
            </>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
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

      <p className="text-muted-foreground text-xs">
        Key <code>{value.valueKey}</code> cannot be changed — orders already placed carry it.
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={save.isPending || !parsed.success} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="outline" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>

      {parsed.success || !parsed.error.issues[0] ? null : (
        <p className="text-destructive text-xs">{parsed.error.issues[0].message}</p>
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
      <div className="flex-1 space-y-1.5">
        <label className="text-xs font-medium">Value label</label>
        <Input value={label} placeholder="Luxury" onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="flex-1 space-y-1.5">
        <label className="text-xs font-medium">Key</label>
        <Input value={valueKey} placeholder="lux" onChange={(e) => setValueKey(e.target.value)} />
      </div>
      <div className="w-28 space-y-1.5">
        <label className="text-xs font-medium">Price</label>
        <Input value={amount} placeholder="10.50" onChange={(e) => setAmount(e.target.value)} />
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

  const publish = useMutation({
    mutationFn: () => publishSet(set.id, set.rowVersion),
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
      </CardContent>
    </Card>
  );
}

function FindingList({ findings }: { findings: PublishFinding[] }) {
  return (
    <ul className="list-disc space-y-1 pl-4">
      {findings.map((finding) => (
        <li key={`${finding.subject}:${finding.code}`}>{finding.message}</li>
      ))}
    </ul>
  );
}
