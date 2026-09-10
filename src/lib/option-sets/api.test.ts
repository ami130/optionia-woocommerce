import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, setSession } from '@/lib/auth/token-store';
import { hasUnpublishedChanges, reorderOptions, updateSet } from './api';

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
});
