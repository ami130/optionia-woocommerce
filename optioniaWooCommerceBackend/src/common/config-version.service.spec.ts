import type { EntityManager } from 'typeorm';

import { ConfigVersionService } from './config-version.service';

/**
 * The one place a store's content revision advances (M9.4b).
 *
 * `GET /store/config` builds its ETag from `stores.config_version`, so a change
 * to published configuration that does not move it is a change no plugin ever
 * fetches: every connected store answers `304` and keeps serving the old
 * document. That is not hypothetical — deleting a published option set did
 * exactly this until Stage 2.
 *
 * These assert the two rules the service owns, without a database: **what
 * counts as visible**, and **what happens when the bump changes nothing**. The
 * e2e suite proves the wiring; this proves the decisions.
 */
describe('ConfigVersionService', () => {
  const service = new ConfigVersionService();

  /**
   * A manager that records what it was asked to do.
   *
   * @param affected Rows the UPDATE claims to have changed.
   */
  function fakeManager(affected = 1): {
    manager: EntityManager;
    updates: Array<Record<string, unknown>>;
  } {
    const updates: Array<Record<string, unknown>> = [];

    const builder = {
      update: () => builder,
      set: (values: Record<string, unknown>) => {
        updates.push(values);

        return builder;
      },
      where: () => builder,
      execute: async () => ({ affected }),
    };

    const manager = {
      createQueryBuilder: () => builder,
      findOne: async () => ({ configVersion: 43 }),
    } as unknown as EntityManager;

    return { manager, updates };
  }

  describe('bump', () => {
    it('advances the version and returns the new value', async () => {
      const { manager } = fakeManager();

      await expect(service.bump(manager, 'store-1')).resolves.toBe(43);
    });

    /**
     * `configVersion + 1` in SQL, never read-modify-write.
     *
     * Two publishes landing together must produce two increments. Reading the
     * value and writing `value + 1` from the application would let the second
     * overwrite the first, and the storefront would miss one of them entirely.
     */
    it('increments in SQL rather than from a read value', async () => {
      const { manager, updates } = fakeManager();

      await service.bump(manager, 'store-1');

      expect(updates).toHaveLength(1);

      const written = updates[0].configVersion;

      expect(typeof written).toBe('function');
      expect((written as () => string)()).toBe('configVersion + 1');
    });

    /**
     * A bump that changed nothing is the bug this service exists to prevent.
     *
     * Zero affected rows means the store was not there — and returning quietly
     * would tell the caller the invalidation happened when it did not, which is
     * the same silent shape as the deletion bug.
     */
    it('throws when no row was updated', async () => {
      const { manager } = fakeManager(0);

      await expect(service.bump(manager, 'missing-store')).rejects.toThrow(
        /no store "missing-store"/,
      );
    });

    it('names the rollback in the error, so the failure is not mistaken for data loss', async () => {
      const { manager } = fakeManager(0);

      await expect(service.bump(manager, 'missing-store')).rejects.toThrow(/rolled back/);
    });
  });

  describe('bumpIfVisible', () => {
    /**
     * The config document is built from published snapshots, so a draft is
     * invisible to it. Bumping for one would invalidate every storefront cache
     * for a change no customer can observe.
     */
    it('does nothing when the change was not visible', async () => {
      const { manager, updates } = fakeManager();

      await expect(service.bumpIfVisible(manager, 'store-1', false)).resolves.toBeNull();
      expect(updates).toHaveLength(0);
    });

    it('bumps when the change was visible', async () => {
      const { manager, updates } = fakeManager();

      await expect(service.bumpIfVisible(manager, 'store-1', true)).resolves.toBe(43);
      expect(updates).toHaveLength(1);
    });

    /**
     * The invisible path returns before touching the database, so a missing
     * store cannot fail a draft-only operation.
     */
    it('does not throw for an unknown store when the change was invisible', async () => {
      const { manager } = fakeManager(0);

      await expect(service.bumpIfVisible(manager, 'missing-store', false)).resolves.toBeNull();
    });
  });
});
