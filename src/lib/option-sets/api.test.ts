import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, setSession } from '@/lib/auth/token-store';
import {
  hasUnpublishedChanges,
  reorderGroups,
  reorderOptions,
  updateGroup,
  updateSet,
} from './api';

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ data, meta: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const bodyOf = (mock: ReturnType<typeof vi.spyOn>, call: number): Record<string, unknown> =>
  JSON.parse(String(((mock.mock.calls[call] as unknown[])[1] as RequestInit).body ?? '{}'));

describe('option-sets api', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    setSession({ accessToken: 'a', refreshToken: 'r' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('hasUnpublishedChanges', () => {
    /**
     * 🔴 **Key order is not stable between `preview` and a stored snapshot.**
     *
     * Measured against the live API: `preview` returns
     * `[id, version, assignments, groups, rules]` while the snapshot — round
     * -tripped through a JSON column at publish time — returns
     * `[id, rules, groups, version, assignments]`.
     *
     * A plain `JSON.stringify` comparison therefore reported "unpublished
     * changes" on a set nobody had touched, which is worse than saying nothing:
     * a warning that is always on is a warning merchants learn to ignore.
     */
    it('treats reordered keys as unchanged', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(ok({ id: 's', version: 1, groups: [], rules: [] }))
        .mockResolvedValueOnce(ok({ snapshot: { rules: [], groups: [], id: 's', version: 1 } }));

      expect(await hasUnpublishedChanges('s', 1)).toBe(false);
    });

    it('reports a real difference', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(ok({ id: 's', groups: [{ id: 'g', options: ['a', 'b'] }] }))
        .mockResolvedValueOnce(ok({ snapshot: { id: 's', groups: [{ id: 'g', options: ['a'] }] } }));

      expect(await hasUnpublishedChanges('s', 1)).toBe(true);
    });

    /**
     * Array order **is** significant: in this document it is `sort_order`, and
     * two options swapping places is a change a merchant should be told about.
     */
    it('treats a reordered array as a change', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(ok({ groups: [{ id: 'a' }, { id: 'b' }] }))
        .mockResolvedValueOnce(ok({ snapshot: { groups: [{ id: 'b' }, { id: 'a' }] } }));

      expect(await hasUnpublishedChanges('s', 1)).toBe(true);
    });

    /** A snapshot response without a `snapshot` wrapper is the document itself. */
    it('accepts an unwrapped snapshot', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(ok({ id: 's', groups: [] }))
        .mockResolvedValueOnce(ok({ groups: [], id: 's' }));

      expect(await hasUnpublishedChanges('s', 1)).toBe(false);
    });

    it('handles nulls without throwing', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(ok({ note: null }))
        .mockResolvedValueOnce(ok({ snapshot: { note: null } }));

      expect(await hasUnpublishedChanges('s', 1)).toBe(false);
    });
  });

  describe('updateSet', () => {
    /**
     * 🔴 `rowVersion` is `@IsOptional()` on the API, and
     * `assertVersionMatches()` throws **only when one is sent** — so omitting it
     * is silent last-write-wins. Required in this signature for that reason.
     */
    it('always sends rowVersion', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

      await updateSet('s-1', 7, { name: 'Renamed' });

      expect(bodyOf(fetchMock, 0)).toEqual({ name: 'Renamed', rowVersion: 7 });
    });
  });

  describe('reorderOptions', () => {
    /**
     * The API takes `{options: [{id, sortOrder}]}` — one write for the whole list.
     *
     * ✏️ The caller now supplies `sortOrder` rather than this function deriving
     * it from array index. When a group also holds presentational items the two
     * share one scale, and an index within this list alone cannot say where an
     * option sits relative to a heading — see `reorderPayloads`.
     */
    it('sends the sort orders it is given, unchanged', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

      await reorderOptions('g-1', [
        { id: 'a', sortOrder: 10 },
        { id: 'b', sortOrder: 20 },
        { id: 'c', sortOrder: 30 },
      ]);

      expect(bodyOf(fetchMock, 0)).toEqual({
        options: [
          { id: 'a', sortOrder: 10 },
          { id: 'b', sortOrder: 20 },
          { id: 'c', sortOrder: 30 },
        ],
      });
    });
  });

  describe('updateGroup', () => {
    /**
     * 🔴 **A group's `description` is its help text, and it was settable
     * nowhere** (ADR-064). Stored, published and rendered by the storefront in
     * both template branches since Phase 5 — `createGroup` sends only a label,
     * and there was no group edit form at all.
     */
    it('sends the description to the group endpoint', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

      await updateGroup('g-1', { description: 'Pick your finish.' });

      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/groups/g-1');
      expect(bodyOf(fetchMock, 0)).toEqual({ description: 'Pick your finish.' });
    });

    /**
     * ⚠️ **An emptied box clears it rather than being dropped.** A merchant
     * removing help text is making a choice; treating `''` as "no change" would
     * leave text on the storefront they had just deleted.
     */
    it('sends an empty description rather than omitting it', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

      await updateGroup('g-1', { description: '' });

      expect(bodyOf(fetchMock, 0)).toEqual({ description: '' });
    });

    /** Only what the caller names is sent — a patch, not a replace. */
    it('sends only the fields it is given', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

      await updateGroup('g-1', { displayType: 'accordion' });

      expect(bodyOf(fetchMock, 0)).toEqual({ displayType: 'accordion' });
    });
  });

  describe('reorderGroups', () => {
    /**
     * 🔴 **The URL and the body key are the whole risk.**
     *
     * Two reorder endpoints sit one level apart and read almost identically:
     * `POST /groups/:id/reorder` moves options **inside** a group, and
     * `POST /option-sets/:id/reorder` moves the groups. Sending a group list to
     * the first is rejected as `NOT_IN_GROUP` — so the mistake is caught, but
     * only by a merchant, in production, on a request that looks right.
     *
     * Asserted here because nothing else in the client can tell them apart.
     */
    it('posts to the SET, with the groups key', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

      await reorderGroups('s-1', [
        { id: 'g1', sortOrder: 10 },
        { id: 'g2', sortOrder: 20 },
      ]);

      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/option-sets/s-1/reorder');
      expect(bodyOf(fetchMock, 0)).toEqual({
        groups: [
          { id: 'g1', sortOrder: 10 },
          { id: 'g2', sortOrder: 20 },
        ],
      });
    });

    /**
     * ⚠️ **Not `/groups/...`** — the endpoint one level down, which would move
     * options within a group whose id happened to match a set's.
     */
    it('does not post to the group-level endpoint', () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({}));

      void reorderGroups('s-1', [{ id: 'g1', sortOrder: 10 }]);

      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).not.toMatch(/\/groups\/[^/]+\/reorder$/);
    });
  });
});
