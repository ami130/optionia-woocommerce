import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { activationKeys, invalidateActivation } from './cache';

/**
 * What refreshes the dashboard checklist, asserted against a real cache.
 *
 * 🔴 **Nothing invalidated this key at all.** `GET /activation/me` is cached
 * with the app's `staleTime: 30_000` and `refetchOnWindowFocus: false`, so a
 * merchant who connected a store, created a set, assigned it or published, then
 * returned to the dashboard inside that window, was told they had not.
 */
const invalidated = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.isInvalidated)
    .map((query) => query.queryKey.join('/'))
    .sort();

describe('invalidateActivation', () => {
  it('refreshes the funnel position', async () => {
    const client = new QueryClient();

    client.setQueryData(activationKeys.me(), { seeded: true });
    invalidateActivation(client);
    await Promise.resolve();

    expect(invalidated(client)).toContain('activation');
  });

  /**
   * ⚠️ It refreshes the funnel and nothing else — it is called *alongside* each
   * screen's own invalidation, never in place of it. A broad sweep here would
   * refetch every list on the app after any edit.
   */
  it('leaves other queries alone', async () => {
    const client = new QueryClient();

    client.setQueryData(activationKeys.me(), { seeded: true });
    client.setQueryData(['option-sets'], { seeded: true });
    client.setQueryData(['stores'], { seeded: true });
    invalidateActivation(client);
    await Promise.resolve();

    expect(invalidated(client)).toEqual(['activation']);
  });

  /**
   * 🔴 **The collision the test above could not see.**
   *
   * `invalidateQueries` matches by **prefix**, and the preferences query was
   * first keyed `['activation', 'preferences']` — underneath the funnel's own
   * key. Every publish, assign, create, disconnect and verification therefore
   * refetched a preference that cannot have changed.
   *
   * ⚠️ The earlier test seeded `['option-sets']` and `['stores']` — keys that
   * could **never** collide — so it passed throughout while the one realistic
   * collision went unasserted. Its assertion was already exactly right; it was
   * the fixture that was wrong.
   */
  it('does not reach the preferences query, which shares no prefix', async () => {
    const client = new QueryClient();

    client.setQueryData(activationKeys.me(), { seeded: true });
    client.setQueryData(activationKeys.preferences(), { seeded: true });
    invalidateActivation(client);
    await Promise.resolve();

    expect(invalidated(client)).toEqual(['activation']);
  });

  /**
   * The property that makes the above true, asserted on the keys themselves.
   *
   * A future key added under `['activation', …]` would pass the test above only
   * by accident of not being seeded; this fails the moment the two roots nest
   * again.
   */
  it('keeps the two keys on separate roots', () => {
    expect(activationKeys.preferences()[0]).not.toBe(activationKeys.me()[0]);
  });

  it('is safe when the funnel has never been read', async () => {
    const client = new QueryClient();

    expect(() => invalidateActivation(client)).not.toThrow();
  });
});

/**
 * Every screen that can move the funnel refreshes it.
 *
 * 🔴 **This is the guard that would have caught the original omission.** The
 * defect was not a wrong invalidation — it was a *missing* one, at four call
 * sites across four files, and no test of any single screen could see that.
 *
 * Read from source for the reason `editor-contracts` gives: these are client
 * components behind React Query and a session provider, and this repository has
 * no renderer for them. A source contract protects the wiring today.
 *
 * ⚠️ **Comments are stripped first** — a file explaining why it needs
 * `invalidateActivation` would otherwise satisfy a guard looking for the call.
 */
describe('every funnel-moving screen refreshes the checklist', () => {
  const read = (path: string) =>
    readFileSync(join(process.cwd(), path), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  const SCREENS: ReadonlyArray<[string, string]> = [
    // Disconnecting moves `connected`, which asks about *current* state.
    ['stores', 'src/app/(app)/stores/page.tsx'],
    // Create, import-from-template and delete move `created`.
    ['option-sets list', 'src/app/(app)/option-sets/page.tsx'],
    // Publish, rollback and import move `published` and `created`.
    ['option-set editor', 'src/app/(app)/option-sets/[id]/page.tsx'],
    // Assign and unassign move `assigned`.
    ['product picker', 'src/components/products/product-picker.tsx'],
    /*
     * 🔴 **Verification moves `verified`, the FIRST step a merchant completes.**
     *
     * Missed in the first pass because the page looks like an auth screen rather
     * than an app one. It ends in `<Link href="/dashboard">` — a *client-side*
     * navigation, so the cache survives and the checklist showed "Verify your
     * email" unticked to someone who had just verified.
     */
    ['verify-email', 'src/app/(verify)/verify-email/page.tsx'],
  ];

  /**
   * ⚠️ **`/connect` moves the funnel and is deliberately absent.**
   *
   * Approving a connection is what moves a merchant *into* `connected` — but the
   * page ends in `window.location.href = result.redirect_url`, a **full-page
   * navigation** back to WordPress, and the query cache is memory-only (no
   * persister is configured). There is no cache left to invalidate.
   *
   * Named here rather than omitted silently, so that if approval ever becomes a
   * client-side redirect this exemption is a decision someone has to revisit
   * rather than a gap nobody recorded.
   */
  it('connect approves by leaving the app entirely, so it needs no invalidation', () => {
    const source = read('src/app/connect/page.tsx');

    expect(source).toMatch(/window\.location\.href/);
    expect(source).not.toMatch(/router\.push\(['"]\/dashboard/);
  });

  it.each(SCREENS)('%s calls invalidateActivation', (_name, path) => {
    expect(read(path)).toMatch(/invalidateActivation\(/);
  });

  it.each(SCREENS)('%s imports it from the shared module', (_name, path) => {
    expect(read(path)).toMatch(/from '@\/lib\/activation\/cache'/);
  });

  /**
   * The list above is the contract, and a shrunken one would pass vacuously —
   * the same floor the cross-repo parity gates keep.
   */
  it('covers every screen known to move the funnel', () => {
    expect(SCREENS).toHaveLength(5);
  });
});
