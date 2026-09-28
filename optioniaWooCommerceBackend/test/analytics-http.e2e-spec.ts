import { randomUUID } from 'node:crypto';

/* ⚠️ `* as`, not a default import — the same esModuleInterop gap as `stripe`. */
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { createHarness, type Harness } from './harness';

/**
 * M25.3 — what a merchant's options earned, over HTTP.
 *
 * ## Why everything here goes through the API
 *
 * 🔴 **`PlanFeatureGuard` shipped one commit earlier with NO production
 * caller.** `plans.features` has carried `analytics` since Phase 22 and nothing
 * read it; the guard was built in stage 25-0 and deliberately left unwired,
 * because a guard with nine passing tests and no route invoking it is F130
 * exactly — the ninth instance of this project's dominant defect.
 *
 * 📌 **So the refusal is asserted at the HTTP boundary, never at the service.**
 * A service-level test would pass against a controller that forgot to call the
 * guard, which is precisely how the gap survived review the eight times before.
 */
describe('Analytics over HTTP (e2e)', () => {
  let h: Harness;
  let dataSource: DataSource;
  let token: string;
  let storeId: string;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness('analytics');
    dataSource = h.dataSource;

    token = await h.tenant('owner');
    storeId = await h.store('owner');
    tenantId = await h.tenantIdOf('owner');

    /* Analytics is a paid feature; most of this suite needs it switched on. */
    await onPlan('pro');
  }, 120_000);

  afterAll(async () => {
    await dataSource.query(
      `DELETE sel FROM order_selections sel
         JOIN order_events e ON e.id = sel.orderEventId
        WHERE e.storeId = ?`,
      [storeId],
    );
    await dataSource.query(`DELETE FROM order_events WHERE storeId = ?`, [storeId]);

    await h.cleanup();
    await h.close();
  });

  async function onPlan(code: string): Promise<void> {
    await dataSource.query(
      `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = ?) WHERE id = ?`,
      [code, tenantId],
    );
  }

  /** One reported order with its selections. */
  async function order(
    externalId: string,
    totalMinor: number,
    selections: Array<{ optionKey: string; label: string; valueKey: string | null; deltaMinor: number }>,
    occurredAt = '2026-09-01 12:00:00.000',
  ): Promise<void> {
    const optionRevenue = selections.reduce((sum, s) => sum + s.deltaMinor, 0);

    /*
     * ⚠️ **The id is generated here, not read back.** MySQL has no `RETURNING`,
     * and the one place in this suite that tried it would have fallen through to
     * a `.catch()` on every insert.
     */
    const eventId = randomUUID();

    await dataSource.query(
      `INSERT INTO order_events
         (id, storeId, externalOrderId, orderTotalMinor, currency, optionRevenueMinor,
          occurredAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'USD', ?, ?, NOW(3), NOW(3))`,
      [eventId, storeId, externalId, totalMinor, optionRevenue, occurredAt],
    );

    for (const selection of selections) {
      await dataSource.query(
        `INSERT INTO order_selections
           (id, orderEventId, optionKey, optionLabel, valueKey, valueLabel,
            priceDeltaMinor, configVersion, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))`,
        [
          eventId,
          selection.optionKey,
          selection.label,
          selection.valueKey,
          selection.valueKey,
          selection.deltaMinor,
        ],
      );
    }
  }

  function get() {
    return request(h.app.getHttpServer())
      .get('/v1/analytics')
      .set('Authorization', `Bearer ${token}`);
  }

  /**
   * 🔴 **The whole point of M25.3: the merchant can see which option earns
   * most.** Everything else is detail — if this is wrong, the report inverts the
   * ordering it exists to produce, which is exactly what F146 was.
   */
  it('ranks options by what they earned', async () => {
    await order('a-1', 10_000, [
      { optionKey: 'engraving', label: 'Engraving', valueKey: 'yes', deltaMinor: 5_000 },
      { optionKey: 'gift', label: 'Gift wrap', valueKey: 'yes', deltaMinor: 500 },
    ]);
    await order('a-2', 8_000, [
      { optionKey: 'engraving', label: 'Engraving', valueKey: 'yes', deltaMinor: 5_000 },
    ]);

    const response = await get();

    expect(response.status).toBe(200);

    const options = response.body.data.topOptions as Array<{
      optionKey: string;
      revenueMinor: number;
      orders: number;
    }>;

    expect(options[0]).toMatchObject({ optionKey: 'engraving', revenueMinor: 10_000, orders: 2 });
    expect(options[1]).toMatchObject({ optionKey: 'gift', revenueMinor: 500, orders: 1 });
  });

  /**
   * 🔴 **The most recent label wins when a key has carried several** (F152).
   *
   * Labels are snapshotted at order time so a rename cannot rewrite a past
   * receipt — which means a year's grouping holds several names for one key. The
   * merchant must see the name they last chose, not whichever row the database
   * happened to return first.
   */
  it('shows the most recent label for a renamed option', async () => {
    await order(
      'a-3',
      5_000,
      [{ optionKey: 'finish', label: 'Finish', valueKey: 'lux', deltaMinor: 100 }],
      '2026-08-01 12:00:00.000',
    );
    await order(
      'a-4',
      5_000,
      [{ optionKey: 'finish', label: 'Surface treatment', valueKey: 'lux', deltaMinor: 100 }],
      '2026-09-20 12:00:00.000',
    );

    const options = (await get()).body.data.topOptions as Array<{
      optionKey: string;
      label: string;
    }>;

    expect(options.find((o) => o.optionKey === 'finish')?.label).toBe('Surface treatment');
  });

  /**
   * 🔴 **Attach rate needs no view events**, and the Phase 25 deferral note
   * first claimed it did. Every order is reported, options or not, so the
   * denominator is already here.
   */
  it('reports the attach rate from orders alone', async () => {
    await order('a-5', 4_000, []);

    const attach = (await get()).body.data.attach as {
      orders: number;
      ordersWithOptions: number;
      rate: number;
    };

    expect(attach.orders).toBe(5);
    expect(attach.ordersWithOptions).toBe(4);
    expect(attach.rate).toBeCloseTo(0.8, 5);
  });

  /**
   * 🔴 **Dead options are the other half of the exit criterion**, and they
   * cannot come from the order tables: an option nobody chose has no rows there.
   * Building revenue alone and ticking the phase would leave half of
   * *"highest-revenue options **and their dead ones**"* unmet.
   */
  it('names an option in the configuration that nobody has ever chosen', async () => {
    const setId = await optionSet('Engraving set', 'never_chosen');

    try {
      const dead = (await get()).body.data.deadOptions as Array<{
        optionKey: string;
        optionSetName: string;
      }>;

      expect(dead.map((d) => d.optionKey)).toContain('never_chosen');
      expect(dead.find((d) => d.optionKey === 'never_chosen')?.optionSetName).toBe('Engraving set');
    } finally {
      await removeOptionSet(setId);
    }
  });

  /**
   * ⚠️ **An option that HAS been chosen is not dead.** The obvious `LEFT JOIN`
   * miswritten would list every option regardless, which reads as "nothing you
   * built is working" — the most alarming possible wrong answer.
   */
  it('does not call a chosen option dead', async () => {
    const setId = await optionSet('Live set', 'engraving');

    try {
      const dead = (await get()).body.data.deadOptions as Array<{ optionKey: string }>;

      expect(dead.map((d) => d.optionKey)).not.toContain('engraving');
    } finally {
      await removeOptionSet(setId);
    }
  });

  /**
   * ⚠️ **A soft-deleted option is gone, not dead.** `deletedAt` is NOT NULL with
   * a `1970-01-01` sentinel, so a query written `deletedAt IS NULL` matches
   * nothing and would report **every** option as dead — F128's defect, one table
   * over.
   */
  it('ignores an option the merchant already deleted', async () => {
    const setId = await optionSet('Retired set', 'retired_option');

    await dataSource.query(
      `UPDATE options o JOIN option_groups g ON g.id = o.optionGroupId
          SET o.deletedAt = NOW(3)
        WHERE g.optionSetId = ?`,
      [setId],
    );

    try {
      const dead = (await get()).body.data.deadOptions as Array<{ optionKey: string }>;

      expect(dead.map((d) => d.optionKey)).not.toContain('retired_option');
    } finally {
      await removeOptionSet(setId);
    }
  });

  /**
   * 🔴 **One store's sales must not mark another store's option alive.**
   *
   * An option `key` is unique within its group, not across a tenant's stores —
   * two shops can both define `engraving` and mean different things. Matching a
   * dead option on the tenant alone would let a busy shop's orders hide an
   * unused option in a quiet one, which is the merchant's *second* store and
   * exactly where they need the report.
   *
   * ✏️ **This test exists because a mutation survived.** Dropping
   * `AND e.storeId = os.storeId` changed nothing while every fixture tenant had
   * one store, so the clause was load-bearing and unproven.
   */
  it('does not let one store’s orders revive another store’s option', async () => {
    const secondStore = await h.store('owner');
    const setId = await optionSet('Second shop set', 'engraving', secondStore);

    try {
      const dead = (await get()).body.data.deadOptions as Array<{ optionKey: string }>;

      /* `engraving` HAS sold — on the first store, never on this one. */
      expect(dead.map((d) => d.optionKey)).toContain('engraving');
    } finally {
      await removeOptionSet(setId);
      await dataSource.query(`DELETE FROM stores WHERE id = ?`, [secondStore]);
    }
  });

  /**
   * 🔒 **Free text never reaches the value breakdown.** An engraving message is
   * the customer's own words; it arrives with a null `valueKey` and must not be
   * grouped, counted or shown. The rule this phase is held to is that a rollup
   * carries `valueKey`, never `valueLabel`.
   */
  it('omits free-text values from the value breakdown', async () => {
    await order('a-6', 3_000, [
      { optionKey: 'message', label: 'Message', valueKey: null, deltaMinor: 900 },
    ]);

    const values = (await get()).body.data.topValues as Array<{ optionKey: string }>;

    expect(values.map((v) => v.optionKey)).not.toContain('message');
  });

  /**
   * 🔴 **A plan without analytics is REFUSED, over HTTP.** This is the assertion
   * `PlanFeatureGuard` was built for and had no caller to make.
   */
  it('refuses a tenant whose plan does not include analytics', async () => {
    await onPlan('free');

    try {
      const response = await get();

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PLAN_FEATURE_UNAVAILABLE');
      expect(response.body.error.message).toMatch(/Upgrade to Pro to use it/);
    } finally {
      await onPlan('pro');
    }
  });

  /**
   * 🔴 **One tenant never sees another's revenue.** `order_selections` carries no
   * tenant column, so scoping exists only through `stores` — and a report that
   * leaked would tell a merchant about someone else's customers.
   */
  it('never reports another tenant’s orders', async () => {
    const otherToken = await h.tenant('neighbour');
    const otherStore = await h.store('neighbour');
    const otherTenant = await h.tenantIdOf('neighbour');

    await dataSource.query(
      `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = 'pro') WHERE id = ?`,
      [otherTenant],
    );

    await dataSource.query(
      `INSERT INTO order_events
         (id, storeId, externalOrderId, orderTotalMinor, currency, optionRevenueMinor,
          occurredAt, createdAt, updatedAt)
       VALUES (UUID(), ?, 'n-1', ?, 'USD', ?, NOW(3), NOW(3), NOW(3))`,
      /*
       * ⚠️ **Bound, not inlined.** `99_000` written into the SQL is a JavaScript
       * numeric separator, which MySQL reads as a COLUMN NAME — measured:
       * "Unknown column '99_000' in 'field list'". The separator is only legal
       * on the TypeScript side of the quote.
       */
      [otherStore, 99_000, 99_000],
    );

    const theirs = await request(h.app.getHttpServer())
      .get('/v1/analytics')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(theirs.status).toBe(200);
    expect(theirs.body.data.attach.orders).toBe(1);
    expect(theirs.body.data.topOptions).toEqual([]);

    /* And mine is unchanged by their order existing. */
    expect((await get()).body.data.attach.totalRevenueMinor).not.toBe(99_000);
  });

  /* ------------------------------------------------------------------ */

  /** A published option set holding exactly one option with the given key. */
  async function optionSet(
    name: string,
    optionKey: string,
    onStore: string = storeId,
  ): Promise<string> {
    const setId = randomUUID();
    const groupId = randomUUID();

    await dataSource.query(
      `INSERT INTO option_sets
         (id, tenantId, storeId, name, status, version, rowVersion, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'published', 1, 1, NOW(3), NOW(3))`,
      [setId, tenantId, onStore, name],
    );

    await dataSource.query(
      `INSERT INTO option_groups
         (id, optionSetId, label, displayType, sortOrder, isCollapsible, isEnabled,
          createdAt, updatedAt)
       VALUES (?, ?, 'Group', 'section', 0, FALSE, TRUE, NOW(3), NOW(3))`,
      [groupId, setId],
    );

    await dataSource.query(
      `INSERT INTO options
         (id, optionGroupId, \`key\`, valueKind, cardinality, presentation, label,
          isRequired, sortOrder, isEnabled, createdAt, updatedAt)
       VALUES (UUID(), ?, ?, 'text', 'one', 'text', ?, FALSE, 0, TRUE, NOW(3), NOW(3))`,
      [groupId, optionKey, optionKey],
    );

    return setId;
  }

  /** Children first: the foreign keys are RESTRICT, not CASCADE. */
  async function removeOptionSet(setId: string): Promise<void> {
    await dataSource.query(
      `DELETE o FROM options o JOIN option_groups g ON g.id = o.optionGroupId
        WHERE g.optionSetId = ?`,
      [setId],
    );
    await dataSource.query(`DELETE FROM option_groups WHERE optionSetId = ?`, [setId]);
    await dataSource.query(`DELETE FROM option_sets WHERE id = ?`, [setId]);
  }
});
