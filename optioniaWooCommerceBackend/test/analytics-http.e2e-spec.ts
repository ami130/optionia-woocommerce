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
    selections: Array<{
      optionKey: string;
      label: string;
      valueKey: string | null;
      deltaMinor: number;
      optionSetId?: string | null;
    }>,
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
            optionSetId, priceDeltaMinor, configVersion, createdAt, updatedAt)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 1, NOW(3), NOW(3))`,
        [
          eventId,
          selection.optionKey,
          selection.label,
          selection.valueKey,
          selection.valueKey,
          selection.optionSetId ?? null,
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

    const options = response.body.data.topOptions.rows as Array<{
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

    const options = (await get()).body.data.topOptions.rows as Array<{
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
      const dead = (await get()).body.data.deadOptions.rows as Array<{
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
      const dead = (await get()).body.data.deadOptions.rows as Array<{ optionKey: string }>;

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
      const dead = (await get()).body.data.deadOptions.rows as Array<{ optionKey: string }>;

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
      const dead = (await get()).body.data.deadOptions.rows as Array<{ optionKey: string }>;

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

    const values = (await get()).body.data.topValues.rows as Array<{ optionKey: string }>;

    expect(values.map((v) => v.optionKey)).not.toContain('message');
  });

  /**
   * 🔴 **"Least selected" is its own list, not the tail of the top one** (F156).
   *
   * M25.3 asks for most **and** least selected values. The top list is capped,
   * so its last row is the fiftieth best — never the worst. A merchant looking
   * for what to retire would have been shown mid-table performers.
   *
   * ⚠️ **Ordered by ORDERS, not revenue.** A value chosen twice at a high price
   * out-earns one chosen fifty times; calling the first "least selected" answers
   * a question nobody asked.
   */
  it('lists the least-chosen values by how often they were chosen', async () => {
    /*
     * ✏️ **Built so ONLY a count ordering passes, after two attempts that were
     * not.** The first gave `once` a high price and `often` a low one — under
     * which "fewest orders first" and "highest revenue first" produce the SAME
     * list, so a mutation swapping them survived. `once` now earns **less in
     * total** than `often` while still being chosen fewer times, so the two
     * orderings put it at opposite ends and only one of them can pass.
     *
     * `once`:  1 order,  400 minor  → first by count, LAST by revenue
     * `often`: 3 orders, 900 minor  → last by count, FIRST by revenue
     */
    await order('a-7', 1_000, [
      { optionKey: 'rare', label: 'Rare', valueKey: 'once', deltaMinor: 400 },
    ]);

    for (const id of ['a-8', 'a-9', 'a-10']) {
      await order(id, 1_000, [
        { optionKey: 'common', label: 'Common', valueKey: 'often', deltaMinor: 300 },
      ]);
    }

    const least = (await get()).body.data.leastValues.rows as Array<{
      valueKey: string;
      orders: number;
      revenueMinor: number;
    }>;

    const rare = least.find((v) => v.valueKey === 'once');
    const often = least.find((v) => v.valueKey === 'often');

    expect(rare).toBeDefined();
    expect(often).toBeDefined();

    /*
     * The two orderings genuinely disagree on this data: `once` was chosen
     * fewer times AND earned more. If the list were ordered by revenue, `once`
     * would come LAST rather than first.
     */
    /* Chosen less often AND earning less in total: the orderings disagree. */
    expect(rare?.orders).toBeLessThan(often?.orders as number);
    expect(rare?.revenueMinor).toBeLessThan(often?.revenueMinor as number);

    expect(least.findIndex((v) => v.valueKey === 'once')).toBeLessThan(
      least.findIndex((v) => v.valueKey === 'often'),
    );
  });

  /**
   * 🔴 **A capped list says so, and says how much it left out** (F156).
   *
   * Fifty rows and "that is everything" are indistinguishable without a total,
   * so a merchant with a large catalogue would read the top fifty as their
   * whole set — the same silent-cap defect as the `GROUP_CONCAT` truncation
   * this phase already caught once.
   */
  it('reports the true total beside a capped list', async () => {
    const response = await get();

    const values = response.body.data.topValues as {
      rows: unknown[];
      total: number;
      truncated: boolean;
    };

    expect(values.total).toBeGreaterThanOrEqual(values.rows.length);
    expect(values.truncated).toBe(values.total > values.rows.length);

    /* This fixture is far under the cap, so nothing is hidden. */
    expect(values.truncated).toBe(false);

    /*
     * 🔴 **The total is counted with the SAME predicates as the list.**
     *
     * ✏️ **A mutation dropping `valueKey IS NOT NULL` from the count alone
     * survived**, because nothing compared the two. A looser count overstates
     * the population, so `truncated` reads true on a complete list — telling a
     * merchant rows are hidden when none are, which is worse than the silent
     * cap this field exists to prevent.
     *
     * The fixtures include a free-text selection (`message`, null valueKey),
     * so a count that forgot the filter would exceed the rows by exactly that.
     */
    expect(values.total).toBe(values.rows.length);
  });

  /**
   * 🔴 **And a list that IS over the cap says so.**
   *
   * ✏️ **This test exists because a mutation survived.** Forcing `truncated`
   * permanently false changed nothing, because every other assertion ran on
   * data comfortably under the cap — so the flag was being read but never
   * exercised, which is indistinguishable from not working.
   *
   * ⚠️ **The cap is 50 and this writes 60 distinct values**, in one order, so
   * the cost is one insert loop rather than sixty round trips.
   */
  it('marks a list that exceeds the cap as truncated', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      optionKey: `bulk_${String(i).padStart(2, '0')}`,
      label: `Bulk ${i}`,
      valueKey: 'v',
      deltaMinor: 100 + i,
    }));

    await order('a-bulk', 50_000, many);

    try {
      const values = (await get()).body.data.topValues as {
        rows: unknown[];
        total: number;
        truncated: boolean;
      };

      expect(values.rows).toHaveLength(50);
      expect(values.total).toBeGreaterThan(50);
      expect(values.truncated).toBe(true);
    } finally {
      await dataSource.query(
        `DELETE sel FROM order_selections sel
           JOIN order_events e ON e.id = sel.orderEventId
          WHERE e.storeId = ? AND e.externalOrderId = 'a-bulk'`,
        [storeId],
      );
      await dataSource.query(
        `DELETE FROM order_events WHERE storeId = ? AND externalOrderId = 'a-bulk'`,
        [storeId],
      );
    }
  });

  /**
   * 🔴 **Average order value with options against without** (F157).
   *
   * M25.3 names *"conversion with vs. without options"*, and that cannot be
   * answered from anything this system records — conversion needs a denominator
   * of visits, and nothing counts a view. This is the honest substitute from
   * data already present, and the Phase 25 section records that the true
   * conversion figure is owned by M25.1's deferred view events.
   */
  it('compares order value with options against without', async () => {
    const attach = (await get()).body.data.attach as {
      averageOrderValueWithOptionsMinor: number | null;
      averageOrderValueWithoutOptionsMinor: number | null;
    };

    /* Fixtures above include both kinds of order, so both averages exist. */
    expect(attach.averageOrderValueWithOptionsMinor).toBeGreaterThan(0);
    expect(attach.averageOrderValueWithoutOptionsMinor).toBeGreaterThan(0);

    /* And they are genuinely different populations, not one number twice. */
    expect(attach.averageOrderValueWithOptionsMinor).not.toBe(
      attach.averageOrderValueWithoutOptionsMinor,
    );
  });

  /**
   * ⚠️ **An average of no orders is `null`, never 0.** A merchant who has never
   * sold without options must not read "0.00" as evidence that options are what
   * earns — that is a claim their data does not support.
   */
  it('reports a missing average as null rather than zero', async () => {
    const otherToken = await h.tenant('fresh');
    const otherTenant = await h.tenantIdOf('fresh');

    await dataSource.query(
      `UPDATE tenants SET planId = (SELECT id FROM plans WHERE code = 'pro') WHERE id = ?`,
      [otherTenant],
    );

    const response = await request(h.app.getHttpServer())
      .get('/v1/analytics')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.attach.averageOrderValueWithOptionsMinor).toBeNull();
    expect(response.body.data.attach.averageOrderValueWithoutOptionsMinor).toBeNull();
    /* And the rate is null too, for the same reason: nothing to divide by. */
    expect(response.body.data.attach.rate).toBeNull();
  });

  /**
   * 🔴 **Revenue per option set — M25.3's last clause** (F150).
   *
   * This is what the flat per-line set list could never answer. A line drawing
   * options from two sets would have had its whole revenue attributed to both,
   * so the per-set figures would have summed to more than the order did.
   */
  it('reports what each option set earned', async () => {
    const setId = await optionSet('Earning set', 'from_set');

    try {
      await order('a-set-1', 9_000, [
        {
          optionKey: 'from_set',
          label: 'From set',
          valueKey: 'yes',
          deltaMinor: 2_500,
          optionSetId: setId,
        },
      ]);

      const sets = (await get()).body.data.optionSets.rows as Array<{
        optionSetId: string;
        name: string;
        revenueMinor: number;
        orders: number;
      }>;

      const mine = sets.find((row) => row.optionSetId === setId);

      expect(mine).toMatchObject({ name: 'Earning set', revenueMinor: 2_500, orders: 1 });
    } finally {
      await dataSource.query(
        `DELETE sel FROM order_selections sel JOIN order_events e ON e.id = sel.orderEventId
          WHERE e.externalOrderId = 'a-set-1'`,
      );
      await dataSource.query(`DELETE FROM order_events WHERE externalOrderId = 'a-set-1'`);
      await removeOptionSet(setId);
    }
  });

  /**
   * 🔴 **A line spanning two sets splits its revenue; it does not double it.**
   *
   * ⚠️ **This is the whole reason F150 changed the plugin's meta shape.** The
   * old per-line key was a flat LIST of the sets a line touched, so the only
   * available attribution was "all of it, to each" — under which a merchant's
   * per-set revenue exceeds their actual revenue and every comparison between
   * sets is wrong.
   */
  it('splits a multi-set line rather than counting it twice', async () => {
    const first = await optionSet('Set A', 'opt_a');
    const second = await optionSet('Set B', 'opt_b');

    try {
      await order('a-set-2', 10_000, [
        { optionKey: 'opt_a', label: 'A', valueKey: 'y', deltaMinor: 3_000, optionSetId: first },
        { optionKey: 'opt_b', label: 'B', valueKey: 'y', deltaMinor: 1_000, optionSetId: second },
      ]);

      const sets = (await get()).body.data.optionSets.rows as Array<{
        optionSetId: string;
        revenueMinor: number;
      }>;

      expect(sets.find((r) => r.optionSetId === first)?.revenueMinor).toBe(3_000);
      expect(sets.find((r) => r.optionSetId === second)?.revenueMinor).toBe(1_000);

      /* 4000 total, not 8000 — the sum is the line, not the line times its sets. */
      const total = sets
        .filter((r) => r.optionSetId === first || r.optionSetId === second)
        .reduce((sum, r) => sum + r.revenueMinor, 0);

      expect(total).toBe(4_000);
    } finally {
      await dataSource.query(
        `DELETE sel FROM order_selections sel JOIN order_events e ON e.id = sel.orderEventId
          WHERE e.externalOrderId = 'a-set-2'`,
      );
      await dataSource.query(`DELETE FROM order_events WHERE externalOrderId = 'a-set-2'`);
      await removeOptionSet(first);
      await removeOptionSet(second);
    }
  });

  /**
   * 🔴 **Orders older than the plugin update are COUNTED, not hidden.**
   *
   * They carry no set id and nothing can backfill them, so their revenue is real
   * and unattributable. A per-set total presented without this number reads as
   * complete when it is not — and the merchant would conclude their sets earn
   * less than they do.
   */
  it('counts the selections it cannot attribute to a set', async () => {
    const summary = (await get()).body.data as { unattributedSelections: number };

    /* Every fixture above predates the set id, so all of them land here. */
    expect(summary.unattributedSelections).toBeGreaterThan(0);
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
    expect(theirs.body.data.topOptions.rows).toEqual([]);

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
