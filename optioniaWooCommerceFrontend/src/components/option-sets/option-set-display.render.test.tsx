import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PublishFinding, VersionSummary } from '@/lib/option-sets/api';
import {
  FindingList,
  HistoryControls,
  PricingExample,
  UnpublishedChangesNotice,
  VersionHistory,
} from './option-set-display';

/**
 * What the editor's presentational pieces render, asserted as output.
 *
 * 🔴 **These were unreachable until 20-1b.** Both lived inside
 * `option-sets/[id]/page.tsx`, one of them behind a `useQuery`, so no test in
 * this repository could reach either — the page is `'use client'` and needs
 * `useParams`, React Query and a session provider to mount.
 *
 * `renderToStaticMarkup` needs none of that, which is why the split was worth
 * making before adding a renderer dependency: the markup a merchant reads is
 * now testable at zero cost.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('UnpublishedChangesNotice', () => {
  /**
   * 🔴 **The version number is the actionable part.** "You have unpublished
   * changes" without it leaves a merchant unable to tell which version their
   * storefront is serving — the one question the notice exists to answer.
   */
  it('names the version the storefront is still serving', () => {
    expect(html(<UnpublishedChangesNotice version={7} canPublish />)).toContain('version 7');
  });

  /**
   * ⚠️ **Two audiences, two sentences.** An editor who cannot publish is told
   * *who* can; telling them to "publish again" would be an instruction they
   * cannot follow.
   */
  it('tells a publisher to publish', () => {
    const output = html(<UnpublishedChangesNotice version={3} canPublish />);

    expect(output).toContain('Publish again');
    expect(output).not.toContain('An owner or admin');
  });

  it('tells everyone else who can', () => {
    const output = html(<UnpublishedChangesNotice version={3} canPublish={false} />);

    expect(output).toContain('An owner or admin');
    expect(output).not.toContain('Publish again');
  });

  /** Both paths say the changes are saved — losing that reads as data loss. */
  it.each([true, false])('reassures that the work is saved (canPublish=%s)', (canPublish) => {
    expect(html(<UnpublishedChangesNotice version={1} canPublish={canPublish} />)).toContain(
      'saved but not live',
    );
  });
});

describe('FindingList', () => {
  const finding = (over: Partial<PublishFinding> = {}): PublishFinding =>
    ({
      subject: 'option:1',
      code: 'NO_VALUES',
      message: 'This option has no values.',
      ...over,
    }) as PublishFinding;

  it('renders every finding’s message', () => {
    const output = html(
      <FindingList
        findings={[
          finding(),
          finding({ subject: 'option:2', code: 'NO_PRICE', message: 'This option is free.' }),
        ]}
      />,
    );

    expect(output).toContain('This option has no values.');
    expect(output).toContain('This option is free.');
  });

  /**
   * ⚠️ **An empty list renders an empty list, not nothing.** The caller decides
   * whether to show the panel at all; a component that silently returned `null`
   * would make "no findings" and "not checked yet" look identical.
   */
  it('renders an empty list rather than nothing', () => {
    expect(html(<FindingList findings={[]} />)).toBe(
      '<ul class="list-disc space-y-1 pl-4"></ul>',
    );
  });

  /**
   * Two findings sharing a message both appear.
   *
   * ✏️ **This test does NOT prove the key is right, and an earlier docblock
   * here claimed it did.** Measured: changing the key to `finding.message` —
   * so two identical messages collide — leaves all eight tests passing, because
   * `renderToStaticMarkup` does not deduplicate on keys. React warns about
   * duplicates in development; static markup contains no trace of it.
   *
   * What this asserts is narrower and still worth having: the component renders
   * one `<li>` per finding rather than collapsing duplicates itself. The key's
   * correctness is a reconciliation property, and only a real renderer
   * (20-1d, if it is earned) can observe it.
   */
  it('keeps two findings that share a message', () => {
    const output = html(
      <FindingList
        findings={[
          finding({ subject: 'option:1', message: 'Needs a value.' }),
          finding({ subject: 'option:2', message: 'Needs a value.' }),
        ]}
      />,
    );

    expect(output.match(/Needs a value\./g)).toHaveLength(2);
  });
});

describe('VersionHistory', () => {
  const version = (n: number, over: Partial<VersionSummary> = {}): VersionSummary => ({
    version: n,
    publishedAt: '2026-09-15T10:00:00.000Z',
    publishedBy: 'owner@example.com',
    note: null,
    ...over,
  });

  const render = (over: Partial<Parameters<typeof VersionHistory>[0]> = {}) =>
    html(
      <VersionHistory
        versions={[version(3), version(2), version(1)]}
        currentVersion={3}
        canPublish
        isRestoring={false}
        onRestore={() => {}}
        {...over}
      />,
    );

  it('lists every published version', () => {
    const output = render();

    expect(output).toContain('Version 3');
    expect(output).toContain('Version 2');
    expect(output).toContain('Version 1');
  });

  /**
   * 🔴 **A merchant must be able to tell which one their storefront is
   * serving.** A history of identical rows answers "what did I publish?" and not
   * "what is live?", which is the question a rollback starts from.
   */
  it('marks the version that is live', () => {
    expect(render()).toContain('live now');
  });

  /**
   * ⚠️ **No restore button on the live version.** Restoring what is already
   * serving publishes an identical version and bumps every storefront's
   * revision — telling them configuration changed when it did not.
   */
  it('offers no way to restore the version already live', () => {
    const output = html(
      <VersionHistory
        versions={[version(3)]}
        currentVersion={3}
        canPublish
        isRestoring={false}
        onRestore={() => {}}
      />,
    );

    expect(output).not.toContain('Restore');
  });

  it('offers a restore for every other version', () => {
    const restores = render().match(/Restore/g) ?? [];

    expect(restores).toHaveLength(2);
  });

  /** Publishing is gated by capability, and so is undoing a publish. */
  it('offers no restore to someone who cannot publish', () => {
    expect(render({ canPublish: false })).not.toContain('Restore');
  });

  /** An empty history says so rather than rendering an empty box. */
  it('explains an empty history', () => {
    const output = html(
      <VersionHistory
        versions={[]}
        currentVersion={0}
        canPublish
        isRestoring={false}
        onRestore={() => {}}
      />,
    );

    expect(output).toContain('Nothing published yet');
  });

  it('disables restoring while a restore is in flight', () => {
    expect(render({ isRestoring: true })).toContain('disabled');
  });
});

/**
 * The undo/redo toolbar (M20.10).
 *
 * 🔴 **Disabled, not hidden, when there is nothing to undo.** A control that
 * appears and disappears as a merchant edits moves the buttons beside it; one
 * that greys out says "this exists, there is nothing for it to do yet".
 */
describe('HistoryControls', () => {
  it('disables undo when there is nothing to undo', () => {
    const markup = renderToStaticMarkup(
      <HistoryControls canUndo={false} canRedo={false} onUndo={() => {}} onRedo={() => {}} />,
    );

    expect(markup).toMatch(/Undo/);

    /*
     * ⚠️ **`disabled=""` — the ATTRIBUTE, not the word.** Counting bare
     * "disabled" matched four times, because the Tailwind class
     * `disabled:opacity-40` carries it too. The first draft asserted 2 and got
     * 4, which is the assertion catching itself rather than the component.
     */
    expect(markup.match(/disabled=""/g)?.length).toBe(2);
  });

  it('enables undo when an operation can be reversed', () => {
    const markup = renderToStaticMarkup(
      <HistoryControls
        canUndo
        canRedo={false}
        undoLabel="Edit Matte"
        onUndo={() => {}}
        onRedo={() => {}}
      />,
    );

    expect(markup.match(/disabled=""/g)?.length).toBe(1);
  });

  /** ⚠️ The label names what would be undone, for the title attribute. */
  it('names the operation in the title', () => {
    const markup = renderToStaticMarkup(
      <HistoryControls
        canUndo
        canRedo={false}
        undoLabel="Edit Matte"
        onUndo={() => {}}
        onRedo={() => {}}
      />,
    );

    expect(markup).toMatch(/Undo Edit Matte/);
  });
});

/**
 * 🔴 **A failed undo must SAY so.** The page called `void history.undo()`,
 * which discards the rejected promise — the log's own test asserts that undo
 * rejects when the server refuses, and the page threw that rejection away. The
 * merchant clicked Undo, the entry stayed (correctly), the button re-enabled,
 * and nothing told them it had not worked.
 *
 * ⚠️ Most likely to fire exactly where it is least expected: after a delete,
 * whose 404 is the failure this whole boundary exists to avoid.
 */
describe('HistoryControls errors', () => {
  it('renders nothing extra when there is no error', () => {
    const markup = renderToStaticMarkup(
      <HistoryControls canUndo canRedo={false} onUndo={() => {}} onRedo={() => {}} />,
    );

    expect(markup).not.toMatch(/could not be undone/i);
  });

  it('shows the failure when an undo is refused', () => {
    const markup = renderToStaticMarkup(
      <HistoryControls
        canUndo
        canRedo={false}
        error="That could not be undone. Try again."
        onUndo={() => {}}
        onRedo={() => {}}
      />,
    );

    expect(markup).toMatch(/could not be undone/i);
  });

  /** ⚠️ Announced, so a merchant who is not watching the toolbar still hears it. */
  it('announces the failure politely', () => {
    const markup = renderToStaticMarkup(
      <HistoryControls
        canUndo
        canRedo={false}
        error="That could not be undone. Try again."
        onUndo={() => {}}
        onRedo={() => {}}
      />,
    );

    expect(markup).toMatch(/aria-live="polite"/);
  });
});

/**
 * The worked example M20.6 asks for.
 *
 * 🔴 **Every number is the shared evaluators' answer**, handed in as props —
 * this component computes nothing, which is what keeps M21.1's rule intact:
 * *"never a second set of rules"*.
 */
describe('PricingExample', () => {
  const line = (
    over: Partial<{
      id: string;
      label: string;
      deltaMinor: number;
      totalMinor: number;
      unpriced: string | null;
    }> = {},
  ) => ({
    id: 'v1',
    label: 'Matte',
    deltaMinor: 500,
    totalMinor: 5500,
    unpriced: null,
    ...over,
  });

  it('renders nothing when no value changes the price', () => {
    const markup = renderToStaticMarkup(<PricingExample lines={[]} baseMinor={5000} />);

    expect(markup).toBe('');
  });

  it('shows what a value adds', () => {
    const markup = renderToStaticMarkup(<PricingExample lines={[line()]} baseMinor={5000} />);

    expect(markup).toMatch(/Matte/);
    expect(markup).toMatch(/5\.00/);
  });

  /**
   * 🔴 **The base is stated, never implied.** A total a merchant mistakes for
   * "what my customer pays" is worse than no total — pricing against a real
   * product is M21.4, and this example is explicitly a sample.
   */
  it('states the base it priced against', () => {
    const markup = renderToStaticMarkup(<PricingExample lines={[line()]} baseMinor={5000} />);

    expect(markup).toMatch(/50\.00/);
    expect(markup).toMatch(/example|sample/i);
  });

  /** ⚠️ A value the evaluator could not price says so, rather than showing £0. */
  it('names a value it could not price', () => {
    const markup = renderToStaticMarkup(
      <PricingExample lines={[line({ unpriced: 'percentage', deltaMinor: 0 })]} baseMinor={5000} />,
    );

    expect(markup).toMatch(/could not be priced|not priced/i);
  });

  /** A discount reads as a discount, not as a smaller surcharge. */
  it('shows a discount with its sign', () => {
    const markup = renderToStaticMarkup(
      <PricingExample lines={[line({ deltaMinor: -250 })]} baseMinor={5000} />,
    );

    expect(markup).toMatch(/−|-/);
  });
});


/**
 * 🔴 **The notice said *that* something changed, never *what*** — M20.9's
 * `diff-vs-published` clause, which shipped as a boolean. A merchant about to
 * publish to a live storefront could not see which options they had touched.
 */
describe('UnpublishedChangesNotice with a diff', () => {
  it('lists what changed', () => {
    const markup = renderToStaticMarkup(
      <UnpublishedChangesNotice
        version={3}
        canPublish
        changes={['Group added: Size', 'Option changed: Finish → Colour']}
      />,
    );

    expect(markup).toMatch(/Group added: Size/);
    expect(markup).toMatch(/Option changed/);
  });

  /** ⚠️ Still useful with no list — a diff that failed must not blank the notice. */
  it('still tells a merchant their changes are unpublished with no list', () => {
    const markup = renderToStaticMarkup(
      <UnpublishedChangesNotice version={3} canPublish changes={[]} />,
    );

    expect(markup).toMatch(/still serving version 3/);
  });

  /** 📌 A viewer sees what changed and is told who can publish it. */
  it('lists changes for a viewer too', () => {
    const markup = renderToStaticMarkup(
      <UnpublishedChangesNotice version={3} canPublish={false} changes={['Group added: Size']} />,
    );

    expect(markup).toMatch(/Group added: Size/);
    expect(markup).toMatch(/owner or admin/i);
  });
});
