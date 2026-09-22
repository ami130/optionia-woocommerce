import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';
import { DomainException } from '../common/errors/domain.exception';
import { ErrorCode } from '../common/errors/error-codes';

import {
  ACTIVATION_STEP,
  ACTIVATION_STEPS,
  STEP_PREDICATES,
  type ActivationStep,
} from './funnel-steps';

/** One row of the funnel. */
export interface FunnelStepResult {
  step: ActivationStep;
  /** Tenants in the cohort that have reached this step. */
  count: number;
  /**
   * `count` as a fraction of the cohort, 0–1, rounded to four places.
   *
   * Of the **cohort**, never of the previous step. A step-over-step rate would
   * imply the funnel is monotone, and it is not (see `funnel-steps.ts`) — a
   * later step can exceed an earlier one and produce a rate above 1.
   */
  rateOfCohort: number;
}

export interface ActivationFunnel {
  /** Inclusive lower bound on `tenants.createdAt`, or null for all time. */
  since: string | null;
  /** Exclusive upper bound on `tenants.createdAt`, or null for unbounded. */
  until: string | null;
  /** Tenants created in the window. The denominator for every rate. */
  cohortSize: number;
  /** Which step counts as activation, so a client need not hardcode it. */
  activationStep: ActivationStep;
  steps: FunnelStepResult[];
}

/**
 * How long merchants take to reach their first published option (M20b.8).
 *
 * 🔴 **Never a bare median** (ADR-099). Measured on the live database, the
 * complete set of values was `0, 0, 6076` minutes: median **0**, mean **2025**.
 * A number that swings a thousandfold on one row reads as a product that
 * activates instantly, and the milestone's own test — *"if it rises, something
 * regressed"* — assumes a distribution stable enough for movement to mean
 * something.
 *
 * So the shape carries its own cohort. "Median 0" and "median 0 of 3, slowest
 * 6,076" are different claims, and a consumer can only tell them apart if the
 * count travels with the number.
 */
export interface TimeToValue {
  /** Inclusive lower bound on `tenants.createdAt`, or null for all time. */
  since: string | null;
  /** Exclusive upper bound, or null for unbounded. */
  until: string | null;

  /**
   * Tenants in the window that have **published at least once**.
   *
   * ⚠️ Not the cohort size: a merchant who never published has no time-to-value,
   * and counting them as zero or excluding them silently are both wrong. This is
   * the denominator the median was actually taken over.
   */
  sampleSize: number;

  /** Minutes from signup to first publish, or null when nobody has published. */
  medianMinutes: number | null;

  /**
   * The spread, so a median of 0 over a bimodal sample is legible as one.
   *
   * 📌 Fastest and slowest rather than quartiles: with a sample this small,
   * quartiles are interpolation dressed as information.
   */
  fastestMinutes: number | null;
  slowestMinutes: number | null;

  /**
   * The target, or null while there is no basis for one (ADR-100).
   *
   * The field exists so a client renders "no target yet" rather than omitting
   * the idea; Phase 33 is where it gets a number.
   */
  targetMinutes: number | null;

  /**
   * When this measurement was taken.
   *
   * 📌 **This is how "track it per release" is answered.** No release, build or
   * deploy identifier exists anywhere in the backend, and inventing one for a
   * single metric would be a concept the system otherwise lacks — so the
   * measurement is timestamped and movement is read between two of them.
   */
  measuredAt: string;
}

export interface FunnelWindow {
  since?: Date;
  until?: Date;
}

/**
 * Which steps one tenant has reached.
 *
 * The per-merchant half of the funnel, and the state M20b.2's setup checklist
 * renders. Deliberately the **same predicates** as `funnel()` — if the checklist
 * and the funnel could disagree about what "connected" means, the funnel would be
 * measuring something the merchant never sees.
 */
export interface TenantActivation {
  tenantId: string;

  /**
   * When this tenant signed up, as an ISO timestamp.
   *
   * 🔴 **"Stalled" is a question about time, and the funnel could not answer
   * it.** Every step is a boolean `EXISTS`, so "signed up four days ago and still
   * has no store" — which is what [M20b.6](../../../developePlan.md)'s nudges are
   * keyed on — had nothing to compare against.
   *
   * 📌 One timestamp rather than one per step, deliberately. Only `signed_up` has
   * a moment the schema records directly; the rest would need a reached-at column
   * on tables that do not have one, and inventing that for four nudges is a
   * migration in search of a requirement. Signup is the anchor every "stalled
   * before X" question actually uses.
   */
  signedUpAt: string;
  /** Every step, in funnel order, with whether this tenant has reached it. */
  steps: Array<{ step: ActivationStep; reached: boolean }>;
  /** Whether this tenant has activated, i.e. reached `published`. */
  activated: boolean;
  /**
   * The first step not yet reached, or null once every step is done.
   *
   * ⚠️ Computed by scanning **in funnel order for the first false**, which is the
   * right answer even though the funnel is not monotone: the merchant's next
   * action is the earliest thing still undone, regardless of how far they got
   * later. A merchant who published but whose store is now disconnected should be
   * told to reconnect, not congratulated.
   */
  nextStep: ActivationStep | null;
}

@Injectable()
export class ActivationService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The funnel for tenants created in a window (M20b.1).
   *
   * Answers the milestone's acceptance question directly: pass the first of the
   * month as `since` and read `published` against `cohortSize`.
   *
   * ## One query, not ten
   *
   * Every step is a correlated `EXISTS` in a single pass over `tenants`, summed
   * in an outer select. Ten separate counts would be ten table scans and — worse —
   * would not be a consistent snapshot: a merchant publishing between query three
   * and query eight would appear in `published` but not in `created`, producing a
   * funnel that contradicts itself with no bug to find.
   */
  async funnel(window: FunnelWindow = {}): Promise<ActivationFunnel> {
    const steps = ACTIVATION_STEPS.filter((s) => s !== 'signed_up');

    const inner = steps.map((s) => `${STEP_PREDICATES[s]} \`${s}\``).join(',\n          ');
    const outer = steps.map((s) => `SUM(f.\`${s}\`) \`${s}\``).join(', ');

    /**
     * Bounds are parameterised, never interpolated. The predicates above are
     * static SQL from a frozen table and contain no caller input; these are the
     * only values that come from a request.
     */
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (window.since) {
      conditions.push('t.createdAt >= ?');
      params.push(window.since);
    }
    if (window.until) {
      conditions.push('t.createdAt < ?');
      params.push(window.until);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows: Array<Record<string, string | number | null>> = await this.dataSource.query(
      `SELECT COUNT(*) \`signed_up\`, ${outer}
         FROM (
           SELECT t.id,
          ${inner}
             FROM tenants t
             ${where}
         ) f`,
      params,
    );

    const row = rows[0] ?? {};
    const cohortSize = Number(row['signed_up'] ?? 0);

    return {
      since: window.since ? window.since.toISOString() : null,
      until: window.until ? window.until.toISOString() : null,
      cohortSize,
      activationStep: ACTIVATION_STEP,
      steps: ACTIVATION_STEPS.map((step) => {
        /**
         * `signed_up` is the cohort itself. `SUM()` over an empty set returns
         * NULL rather than 0, so every step coalesces — an empty cohort must
         * report zeros, not nulls.
         */
        const count = step === 'signed_up' ? cohortSize : Number(row[step] ?? 0);
        return {
          step,
          count,
          rateOfCohort: cohortSize === 0 ? 0 : Math.round((count / cohortSize) * 10000) / 10000,
        };
      }),
    };
  }

  /**
   * One tenant's position in the funnel (M20b.2's checklist reads this).
   *
   * Runs the identical predicates against a single `tenants` row. A separate
   * "is this tenant connected?" query per step would be seven round trips and a
   * second definition of every step to keep in sync with the first.
   */
  async forTenant(tenantId: string): Promise<TenantActivation> {
    const steps = ACTIVATION_STEPS.filter((s) => s !== 'signed_up');
    const select = steps.map((s) => `${STEP_PREDICATES[s]} \`${s}\``).join(',\n         ');

    const rows: Array<Record<string, number | string | Date | null>> =
      await this.dataSource.query(
        `SELECT t.createdAt \`signed_up_at\`, ${select} FROM tenants t WHERE t.id = ?`,
        [tenantId],
      );

    /**
     * No row means no such tenant. Reporting "reached nothing" would be
     * indistinguishable from a brand-new tenant, so the caller is told instead.
     */
    const row = rows[0];
    if (!row) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Tenant not found.');
    }

    const reachedByStep = ACTIVATION_STEPS.map((step) => ({
      step,
      // `signed_up` is true by construction: the tenant row exists.
      reached: step === 'signed_up' ? true : Number(row[step] ?? 0) === 1,
    }));

    return {
      tenantId,
      /*
       * The driver hands back a `Date` for a `datetime` column; normalised to ISO
       * here so the wire shape is a string like every other timestamp this API
       * returns.
       */
      signedUpAt: new Date(row['signed_up_at'] as string | Date).toISOString(),
      steps: reachedByStep,
      activated: reachedByStep.find((s) => s.step === ACTIVATION_STEP)?.reached ?? false,
      nextStep: reachedByStep.find((s) => !s.reached)?.step ?? null,
    };
  }

  /**
   * Median time from signup to first publish (M20b.8).
   *
   * ## Why the version history, not `option_sets.publishedAt`
   *
   * 🔴 **ADR-089.** That column is **overwritten on every republish**, so it
   * answers "when was this last published" — measured drift on real data: a set's
   * row said `09:46:11` where its first publish was `09:45:34`, **37 seconds**
   * late. The error grows with engagement, which is the most misleading possible
   * direction for an activation metric.
   *
   * `option_set_versions` is immutable and records every publish, so the earliest
   * row is the true first.
   *
   * ## Live sets only
   *
   * 🔴 **Without the sentinel filter this disagrees with the funnel.**
   * `option_sets` is `SoftDeletableEntity`, where a live row carries
   * `deletedAt = '1970-01-01 00:00:00.000'` and **never NULL** (ADR-014). The
   * funnel's `published` step filters on it and the first draft of this query did
   * not — so a merchant whose only published set was later deleted counted as
   * never having published in one number and as activated in the other, from the
   * same service.
   *
   * Measured when this was found: **19 deleted sets** carrying **10 version
   * rows**. It did not move the tenant count that day (3 either way), which is
   * exactly how this kind of disagreement survives until it does.
   *
   * ## Why one query with a window function
   *
   * MySQL has no `MEDIAN`, so the rank is computed with `ROW_NUMBER()` and the
   * middle one (or the mean of the middle two) taken. Verified on MySQL 9.6.
   * Pulling every row into the application to sort would work today and stop
   * working at the scale this metric exists to observe.
   */
  async timeToValue(window: FunnelWindow = {}): Promise<TimeToValue> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (window.since) {
      conditions.push('t.createdAt >= ?');
      params.push(window.since);
    }
    if (window.until) {
      conditions.push('t.createdAt < ?');
      params.push(window.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows: Array<Record<string, string | number | null>> = await this.dataSource.query(
      `SELECT
         COUNT(*) \`n\`,
         MIN(d.minutes) \`fastest\`,
         MAX(d.minutes) \`slowest\`,
         AVG(CASE WHEN d.rn IN (FLOOR((d.total + 1) / 2), CEIL((d.total + 1) / 2))
                  THEN d.minutes END) \`median\`
       FROM (
         SELECT
           TIMESTAMPDIFF(MINUTE, t.createdAt, f.firstPublishedAt) minutes,
           ROW_NUMBER() OVER (
             ORDER BY TIMESTAMPDIFF(MINUTE, t.createdAt, f.firstPublishedAt)
           ) rn,
           COUNT(*) OVER () total
         FROM tenants t
         JOIN (
           SELECT o.tenantId, MIN(v.publishedAt) firstPublishedAt
             FROM option_set_versions v
             JOIN option_sets o ON o.id = v.optionSetId
            WHERE o.deletedAt = '${LIVE_SENTINEL_SQL}'
            GROUP BY o.tenantId
         ) f ON f.tenantId = t.id
         ${where}
       ) d`,
      params,
    );

    const row = rows[0] ?? {};

    /*
     * ⚠️ **`Number(null)` is 0**, which would report an instant activation for a
     * cohort where nobody has published. Absence is its own answer here, so each
     * value is checked rather than coerced.
     */
    const numeric = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);

    const sampleSize = Number(row['n'] ?? 0);

    return {
      since: window.since ? window.since.toISOString() : null,
      until: window.until ? window.until.toISOString() : null,
      sampleSize,
      medianMinutes: sampleSize === 0 ? null : numeric(row['median']),
      fastestMinutes: sampleSize === 0 ? null : numeric(row['fastest']),
      slowestMinutes: sampleSize === 0 ? null : numeric(row['slowest']),
      /* ADR-100: no basis for a number until Phase 33's cohort exists. */
      targetMinutes: null,
      measuredAt: new Date().toISOString(),
    };
  }
}
