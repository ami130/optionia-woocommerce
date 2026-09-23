import type { ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { HelpNote } from '@/components/help/help-note';
import { HELP } from '@/lib/help/concepts';
import { formatAmount } from '@/lib/money/money';
import type { PublishFinding, VersionSummary } from '@/lib/option-sets/api';
import type { SampleLine } from '@/lib/option-sets/sample-total';

/**
 * The editor's presentational pieces — props in, markup out.
 *
 * ## Why this module exists
 *
 * `option-sets/[id]/page.tsx` is 1,997 lines in which **every** component owns
 * its own `useQuery`/`useMutation`. There was no layer that could be rendered
 * from a test, so nothing was: the only assertion touching the page checked
 * that text-only `<label>`s carry `htmlFor`.
 *
 * 📌 **The split is the one `product-display.tsx` already proves.** That module
 * holds three components and **zero** hooks, and earns twenty render tests;
 * `product-picker.tsx` keeps the ten hooks beside it. Phase 20 decomposes this
 * editor into a three-pane builder, and the panes need the same seam — pure
 * rendering here, data-fetching in the page.
 *
 * ⚠️ **Nothing here may take a hook.** The moment one does, this file stops
 * being renderable from a test and the reason it exists is gone.
 */

/**
 * What a merchant is told when saved work is not yet live.
 *
 * 🔴 **The decision to show this is NOT here.** `hasUnpublishedChanges()` is a
 * network question keyed on `rowVersion`, and it stays in the page — this
 * renders only once the answer is known. Mixing the two back together is what
 * made the original untestable.
 */
export function UnpublishedChangesNotice({
  version,
  canPublish,
  changes,
}: {
  version: number;
  canPublish: boolean;

  /**
   * What differs from the published version, named.
   *
   * 🔴 **This notice once said only *that* something changed.** M20.9 asks for
   * `diff-vs-published`, and a merchant publishing to a live storefront needs to
   * know **where to look** — "something differs" sends them through the whole
   * set.
   *
   * ⚠️ **Optional, and an empty list still renders the notice.** A diff that
   * failed to load must not blank the warning that changes are unpublished.
   */
  changes?: readonly string[];
}) {
  return (
    <Alert>
      <AlertTitle>Your storefront is still serving version {version}</AlertTitle>
      <AlertDescription>
        {canPublish
          ? 'These changes are saved but not live. Publish again to send them to your store.'
          : 'These changes are saved but not live. An owner or admin can publish them.'}

        {changes === undefined || changes.length === 0 ? null : (
          <ul className="mt-2 space-y-0.5 text-xs">
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The pre-publish findings, listed.
 *
 * ⚠️ **Keyed on `subject:code`, not on the index.** Two findings can share a
 * message — the same rule reported against two options — and an index key makes
 * React reuse the wrong node when the list reorders between checks.
 */
export function FindingList({ findings }: { findings: readonly PublishFinding[] }) {
  return (
    <ul className="list-disc space-y-1 pl-4">
      {findings.map((finding) => (
        <li key={`${finding.subject}:${finding.code}`}>{finding.message}</li>
      ))}
    </ul>
  );
}

/**
 * What this set has published, and the way back to any of it (M20.9).
 *
 * 🔴 **Phase 20's exit says "publish is reversible", and it was not.** The
 * rollback endpoint has existed since Phase 7 with no caller — a merchant could
 * be told their changes were unpublished and had no way to see what *was* live,
 * let alone return to it. The backend was complete; only this was missing.
 *
 * ⚠️ **A rollback publishes a NEW version rather than rewriting one.** The
 * button says *"Restore"*, not *"Revert"*, because the history keeps growing:
 * restoring version 2 while 4 is live produces version **5**. A storefront that
 * received 4 can still be explained afterwards, which a rewrite would destroy.
 *
 * 📌 **Pure, like the rest of this module** — the query and the mutation stay in
 * the page. A component that fetched its own history could not be rendered from
 * a test, which is the whole reason this file exists.
 */
export function VersionHistory({
  versions,
  currentVersion,
  canPublish,
  isRestoring,
  onRestore,
}: {
  versions: VersionSummary[];
  currentVersion: number;
  canPublish: boolean;
  isRestoring: boolean;
  onRestore: (version: number) => void;
}) {
  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing published yet. Publishing writes the first version.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {versions.map((entry) => (
        <li key={entry.version} className="flex items-center justify-between gap-4 p-3 text-sm">
          <span className="min-w-0">
            <span className="block font-medium">
              Version {entry.version}
              {entry.version === currentVersion ? (
                <span className="text-muted-foreground font-normal"> — live now</span>
              ) : null}
            </span>

            <span className="text-muted-foreground block truncate text-xs">
              {new Date(entry.publishedAt).toLocaleString()}
              {entry.publishedBy === null ? '' : ` · ${entry.publishedBy}`}
              {entry.note === null ? '' : ` · ${entry.note}`}
            </span>
          </span>

          {/*
            * ⚠️ **No button on the live version.** Restoring what is already
            * serving would publish an identical version, bump every storefront's
            * revision and tell them configuration changed when it did not.
            */}
          {canPublish && entry.version !== currentVersion ? (
            <button
              type="button"
              disabled={isRestoring}
              onClick={() => onRestore(entry.version)}
              className="shrink-0 rounded-md border px-3 py-1 text-xs disabled:opacity-50"
            >
              Restore
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Undo and redo, as two buttons (M20.10).
 *
 * 🔴 **Disabled rather than hidden.** A control that appears and disappears as
 * a merchant edits shifts everything beside it; one that greys out says "this
 * exists, there is nothing for it to do yet" — and keeps the toolbar's shape
 * stable while the log fills and empties.
 *
 * ⚠️ **The title names the operation**, because "Undo" alone asks a merchant to
 * remember what they last did. `undoLabel` comes from the log's own entry, so
 * it always matches what would actually be reversed.
 *
 * 📌 Pure, like everything else here — the log is a hook, and it stays in the
 * page.
 */
export function HistoryControls({
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  error,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;

  /**
   * 🔴 **Why a failed undo needs its own message.** The entry stays in the log
   * when the server refuses — correct, so the merchant can retry — which means
   * the button simply re-enables and looks exactly as it did before. Without
   * this line the only evidence of failure is that nothing changed.
   */
  error?: string;

  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title={canUndo && undoLabel !== undefined ? `Undo ${undoLabel}` : 'Nothing to undo'}
        className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
      >
        ↺ Undo
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        title={canRedo && redoLabel !== undefined ? `Redo ${redoLabel}` : 'Nothing to redo'}
        className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
      >
        ↻ Redo
      </button>

      {/*
        * ⚠️ **`aria-live` so it is announced, not just drawn.** A merchant
        * whose attention is on the row they just changed would otherwise never
        * learn the undo was refused.
        */}
      <span className="text-destructive text-xs" aria-live="polite">
        {error ?? ''}
      </span>
    </div>
  );
}


/**
 * The worked example M20.6 asks for: what each value would add, and to what.
 *
 * 🔴 **Computes NOTHING.** Every number arrives as a prop, already answered by
 * `priceConfigDelta` and `sumDeltas` — the same functions the cloud and the
 * plugin run, proven by 157 shared fixture cases. M21.1's rule is *"never a
 * second set of rules"*, and a display component doing its own arithmetic is
 * how a second set arrives without anyone deciding to write one.
 *
 * ⚠️ **The base is STATED on every render.** Pricing against a real product is
 * M21.4; this is a sample, and a total a merchant reads as "what my customer
 * pays" would be worse than showing nothing.
 *
 * 📌 **Absent rather than empty when nothing is priced.** An option of twelve
 * free colours should not render a panel saying so.
 */
export function PricingExample({
  lines,
  baseMinor,
}: {
  lines: readonly SampleLine[];
  baseMinor: number;
}) {
  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="bg-muted/40 mt-3 rounded-md border p-3">
      <p className="text-muted-foreground text-xs">
        Example on a <strong>{formatAmount(baseMinor)}</strong> product
      </p>

      <ul className="mt-2 space-y-1">
        {lines.map((line) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span>{line.label}</span>

            {line.unpriced === null ? (
              <span className="tabular-nums">
                {/*
                  * ⚠️ **The sign is explicit for a surcharge too.** "+5.00" and
                  * "5.00" read differently beside a discount, and a column
                  * mixing the two is read as absolute prices rather than deltas.
                  */}
                {line.deltaMinor < 0 ? '−' : '+'}
                {formatAmount(Math.abs(line.deltaMinor))}
                {/*
                  * 🔴 **`line.totalMinor`, not `base + delta`.** The inline sum
                  * written here first was a second set of rules: `sumDeltas`
                  * clamps once at the end and `+` does not, so the two disagree
                  * on any discount larger than the base.
                  */}
                <span className="text-muted-foreground ml-2">
                  = {formatAmount(line.totalMinor)}
                </span>
              </span>
            ) : (
              /*
               * 🔴 **Named, not shown as free.** A malformed amount priced
               * silently at zero is indistinguishable from a deliberate zero,
               * and the merchant would ship the giveaway believing they had
               * configured a charge.
               */
              <span className="text-destructive text-xs">
                could not be priced ({line.unpriced})
              </span>
            )}
          </li>
        ))}
      </ul>

      {/*
        🔴 **The one concept M20b.7 names that nothing explained** (ADR-098). A
        merchant reads a worked total and reasonably asks whether it is what their
        customer actually pays — and the honest answer is the reason the pricing
        architecture exists. This is where the question is asked, so this is where
        it is answered.
      */}
      <HelpNote concept={HELP.pricing} className="mt-3" />
    </div>
  );
}

/**
 * Export and import, as a merchant meets them (M20.8).
 *
 * 🔴 **Export is read-only; import is a WRITE path**, and the panel says which
 * is which. An import **creates a new set** rather than replacing the one on
 * screen: overwriting it would destroy work with no undo, and a merchant
 * choosing the wrong file would lose everything they had authored.
 *
 * ⚠️ **A viewer may export and not import.** Reading a set they can already see
 * costs nothing; writing one is `option_sets:edit`.
 *
 * 📌 Pure, like everything here — the download is a prepared `href`, and the
 * file reading lives in the page.
 */
export function PortablePanel({
  canEdit,
  filename,
  href,
  problems,
  summary,
  onFile,
}: {
  canEdit: boolean;
  filename: string;
  /** A prepared `data:` URL — built in the page, where the set is. */
  href: string;

  /** Why a file was refused. Rendered as errors, because they are. */
  problems: readonly string[];

  /**
   * What an accepted file turned out to contain.
   *
   * 🔴 **Its own channel, because one prop carried two meanings.** The summary
   * went through `problems` — styled `text-destructive` — so a merchant who
   * picked a **valid** file saw success reported in red.
   */
  summary?: string;

  onFile?: (file: File) => void;
}) {
  return (
    <div className="space-y-2 border-t pt-6">
      <p className="text-sm font-medium">Export and import</p>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={href}
          download={filename}
          className="rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
        >
          Export {filename}
        </a>

        {!canEdit ? null : (
          <label className="text-xs">
            <span className="rounded-md border px-2.5 py-1 hover:bg-accent">Import a file</span>
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (file !== undefined) {
                  onFile?.(file);
                }
              }}
            />
          </label>
        )}
      </div>

      {/*
        * 🔴 **This sentence was once false, and the history is worth keeping.**
        * It read "An import creates a new set" while the import path created
        * nothing — a merchant picked a file and got a message, having been told
        * what would happen. It was corrected to describe validation, and is now
        * true again: `POST /v1/option-sets/import` builds the whole tree in one
        * transaction.
        *
        * ⚠️ **"Never replaces" is the half that always mattered.** Overwriting
        * the set on screen would destroy work with no undo, so an import always
        * creates.
        */}
      {!canEdit ? null : (
        <p className="text-muted-foreground text-xs">
          An import creates a new set — it never replaces this one.
        </p>
      )}

      {summary === undefined ? null : <p className="text-xs">{summary}</p>}

      {/*
        * 🔴 **Every problem at once, each naming where it is.** A merchant
        * fixing a hundred-line file one error at a time would import a hundred
        * times — and a refused import writes nothing at all.
        */}
      {problems.length === 0 ? null : (
        <ul className="text-destructive space-y-0.5 text-xs">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Choosing a starter template (M20.7).
 *
 * 🔴 **"A merchant's first option set should be a template they adapt, never a
 * blank canvas."** Phase 20b names the failure this prevents: blank-canvas
 * first runs are where builders lose people, because the merchant does not yet
 * know what "option group" means and an empty screen does not teach them.
 *
 * ⚠️ **Offered beside "create from scratch", never instead of it.** A merchant
 * who knows exactly what they want should not have to delete a template first.
 *
 * 🔴 **`unavailable` exists because a template needs a store and the picker
 * cannot know that.** An option set belongs to a store, so importing a template
 * needs one connected. The page used to render this picker unconditionally and
 * reject the click with "Connect a store before using a template." — a dead end
 * reached by exactly the merchant templates are meant to help. The funnel proves
 * they exist: more tenants have created a set than have a connected store.
 *
 * Offering a choice that cannot be taken is worse than not offering it, so the
 * reason is shown in place of the cards rather than discovered by clicking.
 *
 * 📌 Pure, like everything here — creating the set is the page's job.
 */
export function TemplatePicker({
  templates,
  busy,
  unavailable,
  onChoose,
}: {
  templates: readonly { id: string; name: string; description: string }[];
  /** True while one is being created, so a second click cannot start another. */
  busy?: boolean;
  /**
   * Why a template cannot be used right now, or null when one can.
   *
   * A node rather than a string so the caller can point somewhere useful — with
   * no store connected the only helpful thing is a link to `/stores`.
   */
  unavailable?: ReactNode;
  onChoose: (id: string) => void;
}) {
  if (templates.length === 0) {
    return null;
  }

  if (unavailable !== undefined && unavailable !== null) {
    return <div className="text-muted-foreground text-sm">{unavailable}</div>;
  }

  return (
    <div className="space-y-2">
      {/*
        * ⚠️ **Not "Or start from a template".** That wording was written when the
        * picker sat *below* a "create from scratch" button; ADR-087 put templates
        * first, and a leading "Or" points back at an alternative the merchant has
        * not been offered yet.
        */}
      <p className="text-muted-foreground text-sm">Start from a template and adapt it:</p>

      <ul className="grid gap-2 sm:grid-cols-2">
        {templates.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              disabled={busy === true}
              onClick={() => onChoose(template.id)}
              className="hover:bg-accent w-full rounded-md border p-3 text-left disabled:opacity-50"
            >
              <span className="block text-sm font-medium">{template.name}</span>
              <span className="text-muted-foreground block text-xs">{template.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
