import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HELP } from '@/lib/help/concepts';
import type { AuthoringSet } from '@/lib/option-sets/api';
import { EditorHeader } from './[id]/page';

/**
 * Help that survives the merchant having content (M20b.7, ADR-098).
 *
 * 🔴 **The guard this replaces asserted position, not visibility.** It checked
 * that `HELP.hierarchy` appeared in the page source *before* the no-groups
 * notice — which proves the note is not nested inside that notice, and nothing
 * more. Verified by mutation: wrapping it in an unrelated condition, so it
 * renders almost never, left all 27 tests green.
 *
 * The milestone's requirement is about **when** the explanation renders, and only
 * a renderer can see that. `@testing-library/react` is already a dependency and
 * three sibling tests use it — the earlier guard read source because this markup
 * was inline, not because rendering was unavailable.
 */
const set = (groups: AuthoringSet['groups']): AuthoringSet =>
  ({
    id: 's-1',
    storeId: 'st-1',
    name: 'Hoodie options',
    status: 'draft',
    version: 0,
    rowVersion: 1,
    publishedAt: null,
    publishedConfigVersion: 0,
    groups,
    rules: [],
  }) as unknown as AuthoringSet;

/** A group, so the set is no longer empty. */
const group = {
  id: 'g-1',
  label: 'Size',
  description: null,
  sortOrder: 0,
  isEnabled: true,
  displayType: 'inline',
  isCollapsible: false,
  options: [],
  items: [],
} as unknown as AuthoringSet['groups'][number];

describe('EditorHeader', () => {
  /**
   * 🔴 **The property the milestone actually asks for.** The hierarchy was
   * explained only in the no-groups notice, which disappears the moment a
   * merchant adds a group — which is exactly when the difference between a group
   * and an option starts to matter.
   */
  it('explains the hierarchy when the set already has groups', () => {
    const { getByText } = render(<EditorHeader set={set([group])} />);

    expect(getByText(HELP.hierarchy.question)).toBeTruthy();
  });

  it('explains publishing when the set already has groups', () => {
    const { getByText } = render(<EditorHeader set={set([group])} />);

    expect(getByText(HELP.publishing.question)).toBeTruthy();
  });

  /** And on an empty set too — this is durable help, not a first-run greeting. */
  it('explains both on an empty set', () => {
    const { getByText } = render(<EditorHeader set={set([])} />);

    expect(getByText(HELP.hierarchy.question)).toBeTruthy();
    expect(getByText(HELP.publishing.question)).toBeTruthy();
  });

  /**
   * ⚠️ **Collapsed, so the answer is available and not in the way.** Rendered
   * open it would push the merchant's own set name down the page on every visit.
   */
  it('keeps the answers collapsed until asked for', () => {
    const { container } = render(<EditorHeader set={set([group])} />);
    const details = container.querySelectorAll('details');

    expect(details).toHaveLength(2);
    for (const element of details) {
      expect(element.hasAttribute('open')).toBe(false);
    }
  });

  /** The set's own identity still leads; help sits beneath it. */
  it('shows the set name and status', () => {
    const { getByText } = render(<EditorHeader set={set([group])} />);

    expect(getByText('Hoodie options')).toBeTruthy();
    expect(getByText('Draft')).toBeTruthy();
  });
});
