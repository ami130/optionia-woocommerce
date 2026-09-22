import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DataSource } from 'typeorm';

import { ActivationService } from './activation.service';
import { ACTIVATION_STEPS, STEP_PREDICATES } from './funnel-steps';

/**
 * The activation funnel's arithmetic and its SQL contract (M20b.1).
 *
 * The query itself is proven against the real database by the e2e spec; these
 * assert the parts a fake can prove — the shape of the SQL, the rate arithmetic,
 * and the traps that made the first draft wrong.
 */
describe('ActivationService', () => {
  /** The last statement and parameters the service issued. */
  let sql: string;
  let params: unknown[];

  const withRow = (row: Record<string, unknown> | undefined): ActivationService => {
    const dataSource = {
      query: jest.fn(async (q: string, p: unknown[] = []) => {
        sql = q;
        params = p;
        return row === undefined ? [] : [row];
      }),
    } as unknown as DataSource;
    return new ActivationService(dataSource);
  };

  /** A cohort row where every step has been reached by `n` tenants. */
  const uniform = (cohort: number, n: number): Record<string, unknown> =>
    Object.fromEntries([
      ['signed_up', String(cohort)],
      ...ACTIVATION_STEPS.filter((s) => s !== 'signed_up').map((s) => [s, String(n)]),
    ]);

  describe('funnel', () => {
    it('reports every step, including signed_up, in funnel order', async () => {
      const result = await withRow(uniform(10, 4)).funnel();

      expect(result.steps.map((s) => s.step)).toEqual([...ACTIVATION_STEPS]);
    });

    it('takes signed_up from the cohort count, not from a summed column', async () => {
      const result = await withRow(uniform(10, 4)).funnel();

      expect(result.cohortSize).toBe(10);
      expect(result.steps[0]).toEqual({ step: 'signed_up', count: 10, rateOfCohort: 1 });
    });

    it('rates every step against the cohort, never against the previous step', async () => {
      const result = await withRow(uniform(8, 2)).funnel();

      // 2/8 for each — a step-over-step rate would give 1 for all but the first.
      for (const step of result.steps.slice(1)) {
        expect(step.rateOfCohort).toBe(0.25);
      }
    });

    /**
     * The funnel is not monotone (see `funnel-steps.ts`), so a later step may
     * exceed an earlier one. Proven here because the obvious "fix" — dividing by
     * the previous step — produces a rate above 1 and looks like a bug.
     */
    it('accepts a later step exceeding an earlier one', async () => {
      const row = { ...uniform(10, 2), installed: '3' };

      const result = await withRow(row).funnel();

      const at = (s: string) => result.steps.find((x) => x.step === s);
      expect(at('installed')?.count).toBe(3);
      expect(at('connected')?.count).toBe(2);
      expect(at('installed')?.rateOfCohort).toBeLessThanOrEqual(1);
    });

    /** `SUM()` over no rows is NULL, and NULL must read as 0, not NaN. */
    it('reports zeros for an empty cohort rather than nulls or NaN', async () => {
      const row = Object.fromEntries([
        ['signed_up', '0'],
        ...ACTIVATION_STEPS.filter((s) => s !== 'signed_up').map((s) => [s, null]),
      ]);

      const result = await withRow(row).funnel();

      expect(result.cohortSize).toBe(0);
      for (const step of result.steps) {
        expect(step.count).toBe(0);
        expect(step.rateOfCohort).toBe(0);
      }
    });

    /**
     * The no-rows case is what the `?? 0` coalesce actually guards.
     *
     * A NULL `SUM()` needs no coalesce — `Number(null)` is already 0 — so the
     * empty-cohort test above cannot prove it. Here the keys are **absent**, and
     * `Number(undefined)` is NaN, which would reach the client as `null` in JSON
     * and read as "unknown" rather than "none". Every count is asserted, not just
     * the cohort size.
     */
    it('reports zeros, not NaN, when the driver returns no rows at all', async () => {
      const result = await withRow(undefined).funnel();

      expect(result.cohortSize).toBe(0);
      expect(result.steps).toHaveLength(ACTIVATION_STEPS.length);
      for (const step of result.steps) {
        expect(step.count).toBe(0);
        expect(Number.isNaN(step.count)).toBe(false);
      }
    });

    /**
     * Asserted on `t.createdAt`, not on the word `WHERE`: every `EXISTS`
     * predicate contains its own `WHERE`, so a bare `/WHERE/` can never be
     * absent and the test would be unfalsifiable.
     */
    it('applies no cohort bound when no window is given', async () => {
      await withRow(uniform(1, 1)).funnel();

      expect(sql).not.toMatch(/t\.createdAt/);
      expect(params).toEqual([]);
    });

    it('bounds the cohort by createdAt, inclusive below and exclusive above', async () => {
      const since = new Date('2026-09-01T00:00:00.000Z');
      const until = new Date('2026-10-01T00:00:00.000Z');

      await withRow(uniform(1, 1)).funnel({ since, until });

      expect(sql).toMatch(/t\.createdAt >= \?/);
      expect(sql).toMatch(/t\.createdAt < \?/);
      expect(params).toEqual([since, until]);
    });

    /** Bounds are the only caller-controlled values, and must never be inlined. */
    it('parameterises the window instead of interpolating it', async () => {
      const since = new Date('2026-09-01T00:00:00.000Z');

      await withRow(uniform(1, 1)).funnel({ since });

      expect(sql).not.toContain('2026-09-01');
      expect(params).toEqual([since]);
    });

    it('reports the window back, so a client cannot misattribute the numbers', async () => {
      const since = new Date('2026-09-01T00:00:00.000Z');

      const result = await withRow(uniform(1, 1)).funnel({ since });

      expect(result.since).toBe('2026-09-01T00:00:00.000Z');
      expect(result.until).toBeNull();
    });

    it('names the activation step rather than leaving clients to hardcode it', async () => {
      const result = await withRow(uniform(1, 1)).funnel();

      expect(result.activationStep).toBe('published');
    });

    it('queries once, so the funnel is a consistent snapshot', async () => {
      const service = withRow(uniform(4, 1));
      const query = (service as unknown as { dataSource: DataSource }).dataSource.query;

      await service.funnel();

      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe('forTenant', () => {
    /**
     * The row `forTenant` reads: the signup timestamp, and 1/0 per step.
     *
     * ⚠️ `signed_up_at` is not optional — the tenant row always has a
     * `createdAt`, so a fixture omitting it would be testing a shape the database
     * cannot produce.
     */
    const SIGNED_UP_AT = new Date('2026-09-01T10:00:00.000Z');

    const withSignup = (steps: Record<string, unknown>) => ({
      signed_up_at: SIGNED_UP_AT,
      ...steps,
    });

    /** Every step reached, as the single-row query returns it (1/0, not counts). */
    const allReached = withSignup(
      Object.fromEntries(ACTIVATION_STEPS.filter((s) => s !== 'signed_up').map((s) => [s, 1])),
    );

    it('treats signed_up as reached, because the tenant row exists', async () => {
      const none = withSignup(
        Object.fromEntries(ACTIVATION_STEPS.filter((s) => s !== 'signed_up').map((s) => [s, 0])),
      );

      const result = await withRow(none).forTenant('t1');

      expect(result.steps[0]).toEqual({ step: 'signed_up', reached: true });
      expect(result.nextStep).toBe('verified');
    });

    it('scopes to the requested tenant by parameter', async () => {
      await withRow(allReached).forTenant('t1');

      expect(sql).toMatch(/WHERE t\.id = \?/);
      expect(params).toEqual(['t1']);
    });

    it('reports activation from the published step', async () => {
      const result = await withRow(allReached).forTenant('t1');

      expect(result.activated).toBe(true);
      expect(result.nextStep).toBeNull();
    });

    it('does not treat a later step as activation', async () => {
      const result = await withRow({ ...allReached, published: 0 }).forTenant('t1');

      // `selected` and `ordered` are still 1 — activation is `published` alone.
      expect(result.activated).toBe(false);
    });

    /**
     * The merchant's next action is the **earliest** gap, not the furthest.
     * A merchant who published but whose store is disconnected must be told to
     * reconnect.
     */
    it('names the earliest unreached step, not the furthest', async () => {
      // Two gaps, deliberately: with a single gap the first and the last
      // unreached step are the same row, and the test cannot tell them apart.
      const result = await withRow({ ...allReached, connected: 0, ordered: 0 }).forTenant('t1');

      expect(result.nextStep).toBe('connected');
      expect(result.activated).toBe(true);
    });

    /**
     * 🔴 **"Stalled" is a question about time.** Every step is a boolean
     * `EXISTS`, so "signed up four days ago and still has no store" — what
     * M20b.6's nudges are keyed on — had nothing to compare against until this
     * field existed. M20b.8's time-to-value needs the same anchor.
     */
    it('reports when the tenant signed up', async () => {
      const result = await withRow(allReached).forTenant('t1');

      expect(result.signedUpAt).toBe(SIGNED_UP_AT.toISOString());
    });

    /** ⚠️ ISO, like every other timestamp this API returns — not a `Date`. */
    it('normalises the signup time the driver returns', async () => {
      const result = await withRow(allReached).forTenant('t1');

      expect(typeof result.signedUpAt).toBe('string');
      expect(result.signedUpAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('refuses an unknown tenant rather than reporting no progress', async () => {
      await expect(withRow(undefined).forTenant('nope')).rejects.toThrow(/not found/i);
    });
  });

  /**
   * ## The soft-delete contract
   *
   * `option_sets` and `option_set_assignments` are `SoftDeletableEntity`: a live
   * row carries the sentinel `1970-01-01 00:00:00.000` and **never NULL**
   * (ADR-014). The first draft of these predicates omitted the filter and counted
   * deleted option sets as activation.
   *
   * Asserted against the predicate text because that is where the bug lived —
   * a fake `DataSource` cannot evaluate SQL, and the e2e spec proves the query
   * runs. Each of these fails if the filter is dropped from its predicate.
   */
  /**
   * Every predicate touching a table with a lifecycle column filters on it.
   *
   * 🔴 **Three defects in this phase had one shape.** A predicate written against
   * the *happy* form of a table that carries a lifecycle column, each invisible in
   * the data available at the time:
   *
   * | Defect | Missing filter | Visible then? |
   * | --- | --- | --- |
   * | three funnel predicates (M20b.1) | `deletedAt` sentinel | no — no deleted sets |
   * | `timeToValue` (M20b.8) | `deletedAt` sentinel | no — 3 tenants either way |
   * | `verified` (exit audit) | `revokedAt` | no — 0 revoked |
   *
   * So the rule is asserted per **table** rather than discovered per audit: name
   * the lifecycle column each table carries, and require every predicate touching
   * it to say something about that column.
   */
  describe('lifecycle columns are filtered wherever they exist', () => {
    /**
     * The column each table uses to mean "no longer counts", and the filter a
     * predicate must carry when it touches that table.
     *
     * ⚠️ `tenant_members` uses `revokedAt IS NULL`; `option_sets` uses the live
     * **sentinel**, never `IS NULL` (ADR-014). Two tables, two conventions — which
     * is exactly why this is a table-keyed map rather than one rule.
     */
    const LIFECYCLE: ReadonlyArray<[table: string, filter: RegExp]> = [
      ['tenant_members', /revokedAt IS NULL/],
      /*
       * ⚠️ **Two spellings of one value.** `STEP_PREDICATES` interpolates
       * `LIVE_SENTINEL_SQL` at module load, so its text carries the literal;
       * `ActivationService` interpolates it inside a template literal, so its
       * *source* carries the constant's name. Same filter, different characters —
       * and a pattern matching only the literal reported the service unfiltered
       * when it was not.
       *
       * ✏️ The quotes sit **outside** the alternation: the source reads
       * `'${LIVE_SENTINEL_SQL}'`, quoted, and a first attempt put the `$\{…}`
       * branch outside them and still failed — one character, two more minutes.
       */
      ['option_sets', /deletedAt = '(1970-01-01 00:00:00\.000|\$\{LIVE_SENTINEL_SQL\})'/],
      [
        'option_set_assignments',
        /deletedAt = '(1970-01-01 00:00:00\.000|\$\{LIVE_SENTINEL_SQL\})'/,
      ],
    ];

    /**
     * Every SQL string in this module, not only `STEP_PREDICATES`.
     *
     * ✏️ **The first version iterated the predicate table alone — and
     * `timeToValue` was one of the three defects it was written for.** Its SQL
     * lives in the service, so the generalised rule did not reach the very case
     * that motivated generalising it; a specific test caught that mutation, which
     * is belt and braces rather than the rule holding.
     *
     * The service's own queries are read from source and checked the same way, so
     * a fourth query written there is covered the day it is written.
     */
    const SERVICE_SQL = readFileSync(join(__dirname, 'activation.service.ts'), 'utf8')
      /* Comments quote table names while explaining them; only code counts. */
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');

    /** Each query this module runs, paired with a name for the failure message. */
    const QUERIES: ReadonlyArray<readonly [name: string, sql: string]> = [
      ...Object.entries(STEP_PREDICATES).map(
        ([step, predicate]) => [`predicate ${step}`, predicate] as const,
      ),
      ['ActivationService source', SERVICE_SQL] as const,
    ];

    it.each(
      QUERIES.flatMap(([name, sql]) =>
        LIFECYCLE.filter(([table]) => sql.includes(table)).map(
          ([table, filter]) => [name, table, filter, sql] as const,
        ),
      ),
    )('%s filters %s', (_name, _table, filter, sql) => {
      expect(sql).toMatch(filter);
    });

    /**
     * A map that matched nothing would make every case above vacuous — the same
     * floor the cross-repo parity gates keep.
     */
    it('checks every table that carries one', () => {
      const checked = QUERIES.flatMap(([, sql]) =>
        LIFECYCLE.filter(([table]) => sql.includes(table)),
      );

      /*
       * Five pairs today: verified→tenant_members, created→option_sets,
       * assigned→both, published→option_sets. Counted, not guessed — the first
       * floor said 6 and failed against correct code.
       */
      expect(checked.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('soft-delete filtering', () => {
    const SENTINEL = "'1970-01-01 00:00:00.000'";

    it.each(['created', 'assigned', 'published'] as const)(
      '%s excludes soft-deleted option sets by the live sentinel',
      (step) => {
        expect(STEP_PREDICATES[step]).toContain(`o`);
        expect(STEP_PREDICATES[step]).toContain(SENTINEL);
      },
    );

    it('assigned filters the assignment as well as its set', () => {
      const matches = STEP_PREDICATES.assigned.match(/deletedAt = /g) ?? [];

      // One for `option_set_assignments`, one for `option_sets`.
      expect(matches).toHaveLength(2);
    });

    /**
     * `deletedAt IS NULL` is the intuitive filter and matches *nothing* here.
     * Pinned so nobody "simplifies" the sentinel comparison into it.
     */
    it.each(['created', 'assigned', 'published'] as const)(
      '%s never uses IS NULL, which would match no live row',
      (step) => {
        expect(STEP_PREDICATES[step]).not.toMatch(/deletedAt IS NULL/);
      },
    );

    /**
     * The other tables extend `BaseEntity` and have no `deletedAt` column at all.
     * Filtering them is a hard SQL error, so this pins the absence too.
     */
    it.each(['verified', 'installed', 'connected', 'synced', 'selected', 'ordered'] as const)(
      '%s does not filter a deletedAt column its tables do not have',
      (step) => {
        expect(STEP_PREDICATES[step]).not.toContain('deletedAt');
      },
    );
  });

  /** Every step but `signed_up` must have a predicate; `signed_up` must not. */
  describe('step coverage', () => {
    it('defines a predicate for every step except the cohort itself', () => {
      const defined = Object.keys(STEP_PREDICATES).sort();
      const expected = ACTIVATION_STEPS.filter((s) => s !== 'signed_up')
        .slice()
        .sort();

      expect(defined).toEqual(expected);
    });

    it('correlates every predicate to the tenants row aliased t', () => {
      for (const [step, predicate] of Object.entries(STEP_PREDICATES)) {
        expect(`${step}: ${predicate}`).toContain('t.id');
      }
    });
  });

  /**
   * Median time from signup to first publish (M20b.8).
   *
   * The SQL is proven against the real database by the e2e spec; these assert the
   * parts a fake can prove — the shape, the absence handling, and the query's
   * source.
   */
  describe('timeToValue', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      n: '3',
      median: '0.0000',
      fastest: '0',
      slowest: '6076',
      ...over,
    });

    /**
     * 🔴 **ADR-099 — never a bare median.** Measured live, the complete set was
     * `0, 0, 6076` minutes: the median alone reads as a product that activates
     * instantly, and only the count and the spread make it legible.
     */
    it('reports the cohort and the spread alongside the median', async () => {
      const result = await withRow(row()).timeToValue();

      expect(result.sampleSize).toBe(3);
      expect(result.medianMinutes).toBe(0);
      expect(result.fastestMinutes).toBe(0);
      expect(result.slowestMinutes).toBe(6076);
    });

    /**
     * ⚠️ **`Number(null)` is 0**, which would report instant activation for a
     * cohort where nobody has published. Absence is its own answer.
     */
    it('reports null rather than zero when nobody has published', async () => {
      const result = await withRow(row({ n: '0', median: null, fastest: null, slowest: null }))
        .timeToValue();

      expect(result.sampleSize).toBe(0);
      expect(result.medianMinutes).toBeNull();
      expect(result.fastestMinutes).toBeNull();
      expect(result.slowestMinutes).toBeNull();
    });

    /**
     * ✏️ **The `sampleSize === 0` check covers the empty cohort, so `numeric()`
     * only matters when the sample is non-empty and a value is still missing** —
     * a malformed row rather than a normal one.
     *
     * Found by mutation: replacing `numeric()` with a bare `Number()` passed
     * every test, because the empty case short-circuits before reaching it. A
     * guard nothing exercises is a guard nobody can trust.
     */
    it('reports null rather than zero for a missing value in a non-empty sample', async () => {
      const result = await withRow(row({ n: '2', median: null })).timeToValue();

      expect(result.sampleSize).toBe(2);
      /* Zero here would claim two merchants activated instantly. */
      expect(result.medianMinutes).toBeNull();
    });

    it('survives a driver returning no rows at all', async () => {
      const result = await withRow(undefined).timeToValue();

      expect(result.sampleSize).toBe(0);
      expect(result.medianMinutes).toBeNull();
    });

    /** ADR-100 — no basis for a number until Phase 33's cohort exists. */
    it('carries a null target rather than omitting the idea', async () => {
      const result = await withRow(row()).timeToValue();

      expect(result).toHaveProperty('targetMinutes', null);
    });

    /**
     * 📌 **This is how "track it per release" is answered.** No release or build
     * identifier exists in this backend, so the measurement is timestamped and
     * movement is read between two of them.
     */
    it('timestamps the measurement', async () => {
      const result = await withRow(row()).timeToValue();

      expect(result.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('bounds the cohort by signup date, inclusive below and exclusive above', async () => {
      const since = new Date('2026-09-01T00:00:00.000Z');
      const until = new Date('2026-10-01T00:00:00.000Z');

      await withRow(row()).timeToValue({ since, until });

      expect(sql).toMatch(/t\.createdAt >= \?/);
      expect(sql).toMatch(/t\.createdAt < \?/);
      expect(params).toEqual([since, until]);
    });

    it('applies no bound when no window is given', async () => {
      await withRow(row()).timeToValue();

      expect(sql).not.toMatch(/t\.createdAt >=/);
      expect(params).toEqual([]);
    });

    /**
     * 🔴 **Live sets only, or this disagrees with the funnel.**
     *
     * `option_sets` is `SoftDeletableEntity` — a live row carries the sentinel and
     * **never NULL** (ADR-014) — and the funnel's `published` step filters on it.
     * The first draft of this query did not, so a merchant whose only published
     * set was later deleted counted as never having published in one number and
     * as activated in the other, from the same service.
     *
     * Measured when this was found: **19 deleted sets** carrying **10 version
     * rows**. It did not move the tenant count that day, which is exactly how
     * such a disagreement survives until it does.
     */
    it('counts only live option sets, as the funnel does', async () => {
      await withRow(row()).timeToValue();

      expect(sql).toMatch(/o\.deletedAt = '1970-01-01 00:00:00\.000'/);
    });

    /** ⚠️ `IS NULL` is the intuitive filter here and matches nothing (ADR-014). */
    it('never uses IS NULL, which would match no live row', async () => {
      await withRow(row()).timeToValue();

      expect(sql).not.toMatch(/deletedAt IS NULL/);
    });

    /**
     * 🔴 **ADR-089 — the first publish, from immutable history.**
     * `option_sets.publishedAt` is overwritten on every republish, so it answers
     * "when was this last published" — measured drift on real data: **37
     * seconds** late, and the error grows with engagement.
     */
    it('measures from the version history, never the set row', async () => {
      await withRow(row()).timeToValue();

      expect(sql).toMatch(/MIN\(v\.publishedAt\)/);
      expect(sql).toMatch(/option_set_versions/);
      expect(sql).not.toMatch(/o\.publishedAt/);
    });
  });
});
