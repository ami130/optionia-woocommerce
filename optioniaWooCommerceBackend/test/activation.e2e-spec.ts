import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ActivationService } from '../src/activation/activation.service';
import { PreferencesService } from '../src/activation/preferences.service';
import { ACTIVATION_STEPS } from '../src/activation/funnel-steps';
import { client, createHarness, type Harness } from './harness';

/**
 * The activation funnel against the real schema (M20b.1).
 *
 * 🔴 **This is the test that matters for the SQL.** The unit spec asserts the
 * predicate *text*; only MySQL can say whether seven correlated subqueries name
 * columns that exist. The first draft of this query claimed `store_products` had
 * a `tenantId` and that `tenants` had a `deletedAt`, and both compiled, passed
 * type-checking, and failed here.
 */
describe('Activation funnel (e2e)', () => {
  let h: Harness;
  let service: ActivationService;
  let preferences: PreferencesService;

  beforeAll(async () => {
    h = await createHarness('activation');
    service = h.app.get(ActivationService);
    preferences = h.app.get(PreferencesService);
  }, 120000);

  afterAll(async () => {
    await h.cleanup();
    await h.close();
  });

  it('runs every step against the real schema', async () => {
    const funnel = await service.funnel();

    expect(funnel.steps.map((s) => s.step)).toEqual([...ACTIVATION_STEPS]);
    for (const step of funnel.steps) {
      expect(Number.isFinite(step.count)).toBe(true);
    }
  }, 60000);

  it('counts a fresh tenant as signed up and verified, and no further', async () => {
    await h.tenant('fresh');
    const tenantId = await h.tenantIdOf('fresh');

    const activation = await service.forTenant(tenantId);
    const reached = (step: string) => activation.steps.find((s) => s.step === step)?.reached;

    // The harness verifies the email, so `verified` is true and `connected` is not.
    expect(reached('signed_up')).toBe(true);
    expect(reached('verified')).toBe(true);
    expect(reached('connected')).toBe(false);
    expect(activation.activated).toBe(false);
    expect(activation.nextStep).toBe('installed');
  }, 60000);

  /**
   * 🔴 **Asserted here because a unit test cannot see the SQL.**
   *
   * `signedUpAt` comes from `t.createdAt` in the funnel query, and the unit
   * spec's fake `DataSource` returns its fixture whatever is selected — proven by
   * mutation: deleting the column from the `SELECT` left all 35 unit tests green.
   * Only a real database can say whether the query asks for it.
   */
  it('reports the signup time from the tenant row', async () => {
    await h.tenant('signed-up-at');
    const tenantId = await h.tenantIdOf('signed-up-at');

    const activation = await service.forTenant(tenantId);

    expect(activation.signedUpAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    /* The tenant was created moments ago, so the value must be recent — a
     * hard-coded or defaulted timestamp would not be. */
    const age = Date.now() - new Date(activation.signedUpAt).getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(10 * 60 * 1000);
  }, 60000);

  it('moves a tenant to connected once it has a connected store', async () => {
    await h.tenant('connected');
    await h.store('connected');
    const tenantId = await h.tenantIdOf('connected');

    const activation = await service.forTenant(tenantId);

    expect(activation.steps.find((s) => s.step === 'connected')?.reached).toBe(true);
  }, 60000);

  /**
   * The cohort window is the milestone's acceptance criterion — *"of merchants who
   * signed up this month"* — so it is proven end to end rather than by the shape
   * of the SQL alone.
   */
  it('includes a new tenant in a window covering now, and excludes it from a past one', async () => {
    await h.tenant('cohort');

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const longAgo = new Date('2020-01-01T00:00:00.000Z');

    const including = await service.funnel({ since: hourAgo });
    const excluding = await service.funnel({ since: longAgo, until: longAgo });

    expect(including.cohortSize).toBeGreaterThan(0);
    expect(excluding.cohortSize).toBe(0);
    // An empty cohort reports zeros rather than nulls.
    for (const step of excluding.steps) {
      expect(step.count).toBe(0);
      expect(step.rateOfCohort).toBe(0);
    }
  }, 60000);

  it('refuses an unknown tenant', async () => {
    await expect(service.forTenant('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /not found/i,
    );
  }, 60000);

  describe('GET /v1/activation/me', () => {
    it('returns the calling tenant, and never accepts one from the caller', async () => {
      const token = await h.tenant('route');
      const tenantId = await h.tenantIdOf('route');

      const response = await client(h.app, token).get('/activation/me').expect(200);

      expect(response.body.data.tenantId).toBe(tenantId);
      expect(response.body.data.steps).toHaveLength(ACTIVATION_STEPS.length);
    }, 60000);

    it('refuses an unauthenticated caller', async () => {
      await client(h.app, '').get('/activation/me').expect(401);
    }, 60000);
  });

  describe('dashboard preferences (M20b.2)', () => {
    const userIdOf = async (which: string): Promise<string> => {
      const rows: Array<{ id: string }> = await h.dataSource.query(
        `SELECT id FROM users WHERE email = ?`,
        [`activation-${which}@example.com`],
      );

      return rows[0].id;
    };

    it('reports no dismissal without writing a row', async () => {
      await h.tenant('pref-read');
      const userId = await userIdOf('pref-read');

      expect(await preferences.forUser(userId)).toEqual({ checklistDismissedAt: null });

      /*
       * 📌 A read must not create the row. Otherwise every merchant who has
       * never dismissed anything gets one on their first dashboard visit — a
       * write on a read path, and a table that grows with sign-ups.
       */
      const rows = await h.dataSource.query(
        `SELECT COUNT(*) AS n FROM user_preferences WHERE userId = ?`,
        [userId],
      );
      expect(Number(rows[0].n)).toBe(0);
    }, 60000);

    it('stores a dismissal and reads it back', async () => {
      await h.tenant('pref-write');
      const userId = await userIdOf('pref-write');

      const written = await preferences.setChecklistDismissed(userId, true);

      expect(written.checklistDismissedAt).not.toBeNull();
      expect((await preferences.forUser(userId)).checklistDismissedAt).toBe(
        written.checklistDismissedAt,
      );
    }, 60000);

    it('restores the checklist with the same route', async () => {
      await h.tenant('pref-restore');
      const userId = await userIdOf('pref-restore');

      await preferences.setChecklistDismissed(userId, true);
      await preferences.setChecklistDismissed(userId, false);

      expect((await preferences.forUser(userId)).checklistDismissedAt).toBeNull();
    }, 60000);

    /**
     * 🔴 **Two dashboard tabs are one merchant.**
     *
     * This is why the write is an upsert rather than find-then-save: with
     * `uq_user_preferences_user` in place, the losing tab of a find-then-save
     * gets a duplicate-key error instead of the dismissal it asked for.
     *
     * Measured: three concurrent dismissals, **0 rejected, 1 row**.
     */
    it('survives concurrent dismissals without erroring or duplicating', async () => {
      await h.tenant('pref-race');
      const userId = await userIdOf('pref-race');

      const results = await Promise.allSettled([
        preferences.setChecklistDismissed(userId, true),
        preferences.setChecklistDismissed(userId, true),
        preferences.setChecklistDismissed(userId, true),
      ]);

      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);

      const rows = await h.dataSource.query(
        `SELECT COUNT(*) AS n FROM user_preferences WHERE userId = ?`,
        [userId],
      );
      expect(Number(rows[0].n)).toBe(1);
    }, 60000);
  });

  /**
   * Median time-to-value against the real schema (M20b.8).
   *
   * 🔴 **Only a database can run this query.** It uses `ROW_NUMBER() OVER` and
   * `COUNT(*) OVER` — MySQL has no `MEDIAN` — and the unit spec's fake
   * `DataSource` returns its fixture whatever the SQL says. The funnel's own
   * history is the precedent: a first draft claimed columns that did not exist,
   * compiled, type-checked, and failed here.
   */
  describe('time to value (M20b.8)', () => {
    it('computes a median over the real version history', async () => {
      const result = await service.timeToValue();

      expect(Number.isFinite(result.sampleSize)).toBe(true);

      if (result.sampleSize > 0) {
        expect(result.medianMinutes).not.toBeNull();
        /* A median cannot fall outside the range it was taken from. */
        expect(result.medianMinutes as number).toBeGreaterThanOrEqual(
          result.fastestMinutes as number,
        );
        expect(result.medianMinutes as number).toBeLessThanOrEqual(
          result.slowestMinutes as number,
        );
      }
    }, 60000);

    /**
     * ⚠️ **A cohort nobody published in must report nothing, not zero.**
     * `Number(null)` is 0, which would read as instant activation.
     */
    it('reports nothing for a cohort with no publishes', async () => {
      const result = await service.timeToValue({
        since: new Date('2020-01-01T00:00:00.000Z'),
        until: new Date('2020-01-02T00:00:00.000Z'),
      });

      expect(result.sampleSize).toBe(0);
      expect(result.medianMinutes).toBeNull();
      expect(result.fastestMinutes).toBeNull();
      expect(result.slowestMinutes).toBeNull();
    }, 60000);

    /**
     * 🔴 **The sample counts tenants who published, not the whole cohort.** A
     * merchant who never published has no time-to-value, and counting them as
     * zero would be the most flattering possible lie about activation.
     */
    it('counts only tenants that have published', async () => {
      await h.tenant('ttv-never');

      const before = await service.timeToValue();
      const funnel = await service.funnel();
      const published = funnel.steps.find((s) => s.step === 'published')?.count ?? 0;

      expect(before.sampleSize).toBeLessThanOrEqual(published);
      expect(before.sampleSize).toBeLessThan(funnel.cohortSize);
    }, 60000);

    /** ADR-100 — the field exists so a client can say "no target yet". */
    it('reports a null target', async () => {
      const result = await service.timeToValue();

      expect(result.targetMinutes).toBeNull();
    }, 60000);
  });

  /**
   * The two code paths agree, tenant by tenant.
   *
   * 🔴 **This is the property the whole phase rests on.** `forTenant` is what a
   * merchant's checklist renders; `funnel` is what the business reads. They are
   * **independently written SQL** — one row versus an aggregate over every row —
   * and nothing else asserts they answer the same question.
   *
   * If they drift, a merchant is told they have not connected a store while the
   * funnel counts them as connected, and neither number is obviously wrong. That
   * is precisely the class of defect this phase kept finding: a predicate whose
   * error is invisible in the data available.
   *
   * 📌 **Promoted from a probe.** The final exit audit ran this by hand and found
   * `36 tenants × 10 steps → 0 mismatches`. A one-off observation is not a
   * guarantee, so it lives here.
   */
  it('reports the same steps per tenant as it counts in aggregate', async () => {
    const tenants: Array<{ id: string }> = await h.dataSource.query(
      /*
       * Bounded, because this is O(tenants) round trips. The cap is well above
       * any test fixture and far below a production table — and the floor below
       * makes a silently empty list fail rather than pass.
       */
      `SELECT id FROM tenants ORDER BY createdAt DESC LIMIT 60`,
    );

    expect(tenants.length).toBeGreaterThan(0);

    const aggregate = await service.funnel();

    /*
     * ⚠️ Compared only when the aggregate covers exactly the tenants sampled.
     * With more tenants than the cap, the sums legitimately differ and the
     * assertion would be measuring the cap rather than the code.
     */
    if (aggregate.cohortSize !== tenants.length) {
      return;
    }

    const tally = new Map<string, number>();

    for (const tenant of tenants) {
      const activation = await service.forTenant(tenant.id);

      for (const step of activation.steps) {
        if (step.reached) {
          tally.set(step.step, (tally.get(step.step) ?? 0) + 1);
        }
      }
    }

    const mismatches = aggregate.steps
      .filter((step) => (tally.get(step.step) ?? 0) !== step.count)
      .map((step) => `${step.step}: aggregate=${step.count} perTenant=${tally.get(step.step) ?? 0}`);

    expect(mismatches).toEqual([]);
  }, 120000);

  /**
   * The platform-wide aggregates stay off the tenant-guarded controller.
   *
   * 🔴 **`funnel()` and `timeToValue()` answer questions that span every
   * tenant**, and `ActivationController` is guarded by `TenantGuard` — which
   * resolves a role from a `tenant_members` row and cannot express "platform
   * staff only". Mounting either there would hand **every merchant the signup,
   * activation and timing counts of every other merchant** (ADR-086).
   *
   * ⚠️ **The isolation gate cannot catch this.** It demands a negative test for
   * each tenant-scoped route — "another tenant's id answers 404" — and a
   * platform-wide route has no id to refuse. It would pass while leaking
   * everything.
   *
   * Until the exit audit the decision rested on a doc comment reading
   * *"deliberately not exposed here"*. [M26.6](../../developePlan.md) mounts both
   * behind Phase 26's staff guard; until then this is what says so.
   */
  describe('the aggregate funnel is not reachable by a merchant', () => {
    /** Every path this API actually serves, read from the router rather than source. */
    const registered = (): string[] => {
      const server = h.app.getHttpServer() as {
        _events?: { request?: { router?: { stack?: unknown[] }; _router?: { stack?: unknown[] } } };
      };
      const router = server._events?.request?.router ?? server._events?.request?._router;

      return ((router?.stack ?? []) as Array<{ route?: { path?: string } }>)
        .map((layer) => layer.route?.path)
        .filter((path): path is string => typeof path === 'string');
    };

    it('finds the routes, so the assertions below are not vacuous', () => {
      const paths = registered();

      expect(paths.length).toBeGreaterThan(20);
      /* The per-tenant route is mounted, so this is reading the right table. */
      expect(paths).toContain('/v1/activation/me');
    });

    /**
     * 📌 Asserted on the **paths this controller owns**, not on a method name: a
     * route is what a merchant can reach, and the handler behind it could be
     * renamed without changing the exposure.
     */
    it('exposes only per-caller routes under /v1/activation', () => {
      const activation = registered().filter((path) => path.startsWith('/v1/activation'));

      expect(activation.sort()).toEqual([
        '/v1/activation/me',
        '/v1/activation/preferences',
        '/v1/activation/preferences',
      ]);
    });

    /**
     * And the aggregates have no production caller at all — so nothing else can
     * be quietly reaching them either.
     */
    it('keeps the aggregate methods uncalled outside tests', () => {
      const source = readFileSync(
        join(__dirname, '..', 'src', 'activation', 'activation.controller.ts'),
        'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, ' ');

      expect(source).not.toMatch(/service\.funnel\(/);
      expect(source).not.toMatch(/service\.timeToValue\(/);
    });
  });
});
