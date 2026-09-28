import { DataSource } from 'typeorm';

import { UsageCounterService } from '../src/usage/usage-counter.service';
import { createHarness, type Harness } from './harness';

/**
 * M24.1 — what a tenant is using, against MySQL.
 *
 * ## Why every one of these is an e2e
 *
 * 🔴 **This service is almost entirely SQL.** A unit test with a mocked
 * `query()` would assert that my string equals my string — it could not catch a
 * wrong join, a missed `deletedAt`, a `tenantId` that scopes nothing, or a
 * subquery that counts the wrong table. Every defect this guard exists to
 * prevent lives in the database's reading of the query, not in the code around
 * it.
 *
 * 📌 **Phase 24 enforces against these numbers.** A count that is wrong by one
 * refuses a merchant a write they paid for, or grants one they did not — so the
 * arithmetic is the product, not a detail beneath it.
 */
describe('Usage counting (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let counter: UsageCounterService;

  beforeAll(async () => {
    h = await createHarness('usagecount');
    dataSource = h.dataSource;
    counter = h.app.get(UsageCounterService, { strict: false });
  }, 120_000);

  afterAll(async () => {
    await h.cleanup();
    await h.close();
  });

  /**
   * 🔴 **The container must be able to build it.** A provider registered but
   * unconstructible fails only when something first asks — which for a limit
   * guard is a merchant's write, in production.
   */
  it('resolves from the application container', () => {
    expect(counter).toBeInstanceOf(UsageCounterService);
  });

  /**
   * 🔴 **A fresh tenant uses one seat: its owner.** Registration creates the
   * membership, so anything other than 1 means the seat query is counting the
   * wrong rows — and seats are the limit most likely to be hit first on Free,
   * where the allowance is exactly 1.
   */
  it('counts the owner as one seat', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'seats-owner'));

    await expect(counter.count(tenantId, 'team_seats')).resolves.toBe(1);
  });

  /**
   * 🔴 **A pending invitation holds a seat**, which M24.1 is explicit about:
   * *"otherwise a tenant can exceed its seat limit by holding invitations
   * open"*. Counting only accepted members would make the limit free to evade.
   */
  it('counts a pending invitation as a seat', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'seats-pending'));

    await invite(dataSource, tenantId, 'pending@example.test', {});

    await expect(counter.count(tenantId, 'team_seats')).resolves.toBe(2);
  });

  /**
   * ⚠️ **An EXPIRED invitation holds no seat.** It can never be accepted, so
   * charging for it bills a tenant for a seat nobody can take. The milestone's
   * reasoning is about seats someone might still claim.
   */
  it('does not count an expired invitation', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'seats-expired'));

    await invite(dataSource, tenantId, 'expired@example.test', {
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(counter.count(tenantId, 'team_seats')).resolves.toBe(1);
  });

  /** ⚠️ And a revoked invitation is not a seat either — it was withdrawn. */
  it('does not count a revoked invitation', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'seats-revoked'));

    await invite(dataSource, tenantId, 'revoked@example.test', {
      revokedAt: new Date(),
    });

    await expect(counter.count(tenantId, 'team_seats')).resolves.toBe(1);
  });

  /**
   * 🔴 **Usage is per tenant, and nothing else.** A count that leaks across
   * tenants would refuse one merchant a write because another was busy — the
   * worst failure this guard could have, and the one a `WHERE` typo produces.
   */
  it('never counts another tenant’s seats', async () => {
    const mine = await h.tenantIdOf(await named(h, 'iso-a'));
    const theirs = await h.tenantIdOf(await named(h, 'iso-b'));

    await invite(dataSource, theirs, 'theirs@example.test', {});
    await invite(dataSource, theirs, 'theirs2@example.test', {});

    await expect(counter.count(mine, 'team_seats')).resolves.toBe(1);
    await expect(counter.count(theirs, 'team_seats')).resolves.toBe(3);
  });

  /**
   * 🔴 **Every store counts, disconnected included.** Unlike storage — where a
   * disconnected store's bytes must stop counting because the merchant cannot
   * reduce them — a store row is something they *can* delete. Excluding them
   * would let a tenant hold unlimited disconnected stores against a limit of 1.
   */
  it('counts a store the merchant has disconnected', async () => {
    const which = await named(h, 'stores');
    const tenantId = await h.tenantIdOf(which);

    await h.store(which);

    await expect(counter.count(tenantId, 'stores')).resolves.toBe(1);

    await dataSource.query(`UPDATE stores SET status = 'disconnected' WHERE tenantId = ?`, [
      tenantId,
    ]);

    await expect(counter.count(tenantId, 'stores')).resolves.toBe(1);
  });

  /**
   * 🔴 **A soft-deleted option set is not usage.** The merchant cannot see it,
   * cannot restore it from the dashboard, and cannot reduce the number any
   * further — so counting it would hold them permanently against a limit for
   * work they already removed. `option_sets` is the Free plan's tightest
   * authoring limit at 10, so an off-by-deleted-rows error is a merchant who
   * deletes a set and is still refused the next one.
   *
   * ✏️ **This test exists because a mutation survived.** Removing
   * `AND deletedAt IS NULL` changed nothing: no test created a set and deleted
   * it, so the filter was asserted by no one.
   */
  it('stops counting an option set once it is soft-deleted', async () => {
    const which = await named(h, 'sets-deleted');
    const tenantId = await h.tenantIdOf(which);
    const storeId = await h.store(which);

    await makeSet(dataSource, tenantId, storeId, 'Counted');
    await makeSet(dataSource, tenantId, storeId, 'Deleted later');

    await expect(counter.count(tenantId, 'option_sets')).resolves.toBe(2);

    await dataSource.query(
      `UPDATE option_sets SET deletedAt = NOW(3) WHERE tenantId = ? AND name = 'Deleted later'`,
      [tenantId],
    );

    await expect(counter.count(tenantId, 'option_sets')).resolves.toBe(1);
  });

  /**
   * 🔴 **Assignments are scoped through their set**, because
   * `option_set_assignments` carries no `tenantId` of its own — the join is the
   * only thing keeping one merchant's assignments out of another's count.
   *
   * 📌 **And a deleted set takes its assignments with it.** Leaving them counted
   * would charge a merchant for work that no longer exists anywhere they can
   * see.
   */
  it('counts assignments through the set, and drops them when it is deleted', async () => {
    const which = await named(h, 'assign');
    const tenantId = await h.tenantIdOf(which);
    const storeId = await h.store(which);

    const setId = await makeSet(dataSource, tenantId, storeId, 'Assigned');

    await assign(dataSource, setId, 'sku-1');
    await assign(dataSource, setId, 'sku-2');

    await expect(counter.count(tenantId, 'products_assigned')).resolves.toBe(2);

    await dataSource.query(`UPDATE option_sets SET deletedAt = NOW(3) WHERE id = ?`, [setId]);

    await expect(counter.count(tenantId, 'products_assigned')).resolves.toBe(0);
  });

  /** 📌 A tenant with nothing uses nothing — the quiet case must be quiet. */
  it('reports zero for a tenant that has created nothing', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'empty'));

    await expect(counter.count(tenantId, 'option_sets')).resolves.toBe(0);
    await expect(counter.count(tenantId, 'products_assigned')).resolves.toBe(0);
    await expect(counter.count(tenantId, 'stores')).resolves.toBe(0);
  });

  /**
   * 🔴 **Storage is READ, not counted**, because the bytes live on the
   * merchant's own server and arrive by heartbeat. A tenant that has never
   * reported must read 0 rather than fail.
   */
  it('reports zero storage for a tenant that has never reported', async () => {
    const tenantId = await h.tenantIdOf(await named(h, 'storage'));

    await expect(counter.count(tenantId, 'file_storage_mb')).resolves.toBe(0);
  });
});

/** An option set, written directly — the HTTP route enforces far more than counting. */
async function makeSet(
  dataSource: DataSource,
  tenantId: string,
  storeId: string,
  name: string,
): Promise<string> {
  const [row] = (await dataSource.query('SELECT UUID() AS id')) as { id: string }[];

  await dataSource.query(
    `INSERT INTO option_sets (id, tenantId, storeId, name, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, NOW(3), NOW(3))`,
    [row.id, tenantId, storeId, name],
  );

  return row.id;
}

/** One product assignment on that set. */
async function assign(dataSource: DataSource, optionSetId: string, sku: string): Promise<void> {
  await dataSource.query(
    `INSERT INTO option_set_assignments
       (id, optionSetId, mode, targetType, targetRef, priority, createdAt, updatedAt)
     VALUES (UUID(), ?, 'include', 'product', ?, 0, NOW(3), NOW(3))`,
    [optionSetId, sku],
  );
}

/** A tenant this suite then measures. */
async function named(h: Harness, which: string): Promise<string> {
  await h.tenant(which);

  return which;
}

/**
 * An invitation row, written directly.
 *
 * 📌 **The HTTP route would work too, and is the wrong tool here.** It sends
 * mail, enforces capabilities and validates an email — none of which this suite
 * is about, and each of which could fail for reasons that say nothing about the
 * counting.
 */
async function invite(
  dataSource: DataSource,
  tenantId: string,
  email: string,
  over: { expiresAt?: Date; revokedAt?: Date; acceptedAt?: Date },
): Promise<void> {
  const expiresAt = over.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60_000);

  await dataSource.query(
    `INSERT INTO tenant_invitations
       (id, tenantId, email, role, tokenHash, invitedBy, expiresAt, acceptedAt, revokedAt,
        createdAt, updatedAt)
     VALUES (UUID(), ?, ?, 'viewer', ?, NULL, ?, ?, ?, NOW(3), NOW(3))`,
    [
      tenantId,
      email,
      `hash_${email}`,
      expiresAt,
      over.acceptedAt ?? null,
      over.revokedAt ?? null,
    ],
  );
}
