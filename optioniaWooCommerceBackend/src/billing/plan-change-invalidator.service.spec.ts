import { DataSource, EntityManager } from 'typeorm';

import type { ConfigVersionService } from '../common/config-version.service';
import { Store } from '../stores/entities/store.entity';
import { PlanChangeInvalidatorService } from './plan-change-invalidator.service';

/**
 * F121 — telling a merchant's storefronts that their plan moved.
 *
 * 🔴 **No billing path bumped `configVersion` at all.** Every caller lived in
 * `src/option-sets/`; nothing plan-related called it, so a merchant who
 * upgraded kept a stale config for up to fifteen minutes and read it as *"I
 * paid and nothing happened"*.
 *
 * 📌 **The fan-out is this file's subject.** Whether each *caller* triggers it
 * is asserted where those callers live — the point of a shared service is that
 * "every path that moves a plan invalidates config" is one checkable fact.
 */
describe('PlanChangeInvalidatorService', () => {
  function build(stores: { id: string }[], bumpImpl?: jest.Mock) {
    const find = jest.fn(async () => stores as Store[]);

    const manager = { find } as unknown as EntityManager;

    const dataSource = { manager } as unknown as DataSource;

    const bump = bumpImpl ?? jest.fn(async () => 1);

    const configVersion = { bump } as unknown as ConfigVersionService;

    return {
      service: new PlanChangeInvalidatorService(dataSource, configVersion),
      bump,
      find,
    };
  }

  /**
   * 🔴 **Every store, not just the first.** A tenant may own several
   * storefronts — `UNIQUE(tenantId, storeUrl)` — and invalidating one would
   * leave the others serving the old plan's options.
   */
  it('bumps every store the tenant owns', async () => {
    const { service, bump } = build([{ id: 'store_1' }, { id: 'store_2' }, { id: 'store_3' }]);

    await expect(service.invalidate('tenant_1')).resolves.toBe(3);

    expect(bump).toHaveBeenCalledTimes(3);
    expect(bump.mock.calls.map((c) => c[1])).toEqual(['store_1', 'store_2', 'store_3']);
  });

  /**
   * 🔴 **Scoped to the tenant.** Bumping another tenant's storefront would
   * push a configuration change to a merchant whose plan did not move.
   */
  it('asks only for the tenant’s own stores', async () => {
    const { service, find } = build([{ id: 'store_1' }]);

    await service.invalidate('tenant_7');

    const [[, options]] = find.mock.calls as unknown as [
      [unknown, { where: { tenantId: string } }],
    ];

    expect(options.where.tenantId).toBe('tenant_7');
  });

  /**
   * ⚠️ **A merchant can pay before connecting a store** — that is the normal
   * order — so nothing to invalidate is a real answer, not an error.
   */
  it('returns zero when the tenant has no stores', async () => {
    const { service, bump } = build([]);

    await expect(service.invalidate('tenant_1')).resolves.toBe(0);

    expect(bump).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **A broken store must not deny the others.** `bump()` throws when a
   * store row is missing — by design, to roll back a publish — and a tenant
   * with three storefronts and one bad row should still have two told.
   */
  it('keeps going when one store cannot be bumped', async () => {
    const bump = jest
      .fn<Promise<number>, [EntityManager, string]>()
      .mockRejectedValueOnce(new Error('no store'))
      .mockResolvedValue(1);

    const { service } = build([{ id: 'store_1' }, { id: 'store_2' }], bump as unknown as jest.Mock);

    await expect(service.invalidate('tenant_1')).resolves.toBe(1);

    expect(bump).toHaveBeenCalledTimes(2);
  });

  /**
   * 🔴 **A webhook must never fail over a bump.** This is the OPPOSITE of
   * publishing's contract: `bump()` throws to roll back the change that
   * prompted it, which is right for a publish and wrong here. An event that
   * fails on a store bookkeeping problem is one Stripe retries forever and
   * that can never succeed — the defect N1 fixed.
   */
  it('never throws, however badly the bump fails', async () => {
    const bump = jest.fn(async () => {
      throw new Error('database is on fire');
    });

    const { service } = build([{ id: 'store_1' }], bump);

    await expect(service.invalidate('tenant_1')).resolves.toBe(0);
  });

  /**
   * 📌 **A caller's transaction manager is used when given**, so the bumps
   * join the caller's unit of work rather than opening their own.
   */
  it('uses the manager it was handed', async () => {
    const find = jest.fn(async () => [{ id: 'store_1' }] as Store[]);
    const handed = { find } as unknown as EntityManager;

    const ambient = { find: jest.fn(async () => [] as Store[]) } as unknown as EntityManager;
    const bump = jest.fn(async (_m: EntityManager, _id: string) => 1);

    const service = new PlanChangeInvalidatorService(
      { manager: ambient } as unknown as DataSource,
      { bump } as unknown as ConfigVersionService,
    );

    await service.invalidate('tenant_1', handed);

    expect(find).toHaveBeenCalled();
    expect(bump.mock.calls[0][0]).toBe(handed);
  });
});
