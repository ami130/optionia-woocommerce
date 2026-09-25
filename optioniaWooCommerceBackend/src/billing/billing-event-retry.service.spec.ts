import { Repository } from 'typeorm';

import {
  BillingEventRetryService,
  MAX_ATTEMPTS,
  RETRY_AFTER_MS,
} from './billing-event-retry.service';
import { BillingEvent } from './entities/billing-event.entity';
import type { SubscriptionLifecycleService } from './subscription-lifecycle.service';

/**
 * M23.4 — re-running the webhook work that never finished.
 *
 * 🔴 **The target is the work STRIPE WILL NOT retry.** Stripe redelivers a
 * non-2xx for days on its own schedule; chasing those too would attempt one
 * failed payment twice per cycle. What nothing covered is a row we answered
 * `200` to and then failed to finish — and N1 exists because our own
 * idempotency check once *consumed* Stripe's retries, losing the event for good.
 */
describe('BillingEventRetryService', () => {
  const NOW = new Date('2026-09-25T12:00:00.000Z');

  /** Old enough to be eligible: the original request is certainly over. */
  const OLD = new Date(NOW.getTime() - RETRY_AFTER_MS - 1_000);

  function build(rows: Partial<BillingEvent>[], apply?: jest.Mock) {
    const events = rows.map(
      (row, index) =>
        ({
          id: `evt_row_${index}`,
          providerEventId: `evt_${index}`,
          type: 'customer.subscription.updated',
          payload: { id: 'sub_1' },
          processedAt: null,
          deadAt: null,
          error: null,
          attempts: 0,
          createdAt: OLD,
          ...row,
        }) as BillingEvent,
    );

    const update = jest.fn(async () => ({ affected: 1 }));

    const repo = {
      find: jest.fn(async () => events),
      update,
    } as unknown as Repository<BillingEvent>;

    const lifecycle = {
      apply: apply ?? jest.fn(async () => ({ changed: true, detail: 'ok' })),
    } as unknown as SubscriptionLifecycleService;

    return {
      service: new BillingEventRetryService(repo, lifecycle),
      update,
      repo,
      apply: lifecycle.apply as jest.Mock,
    };
  }

  /** 📌 The happy path: an event that failed once now succeeds. */
  it('re-runs an unprocessed event and settles it', async () => {
    const { service, update } = build([{ attempts: 1, error: 'boom' }]);

    const outcome = await service.retryPending(NOW);

    expect(outcome).toMatchObject({ retried: 1, recovered: 1, deadLettered: 0 });

    const [[, patch]] = update.mock.calls as unknown as [
      [unknown, { processedAt: Date; error: null; attempts: number }],
    ];

    expect(patch.processedAt).toBeInstanceOf(Date);
    expect(patch.attempts).toBe(2);
  });

  /**
   * ⚠️ **`error` is cleared on success.** A row that recovered while still
   * carrying its first failure's message reads as a permanent failure to
   * whoever queries these later — which is exactly what Phase 26 will do.
   */
  it('clears the error when a retry succeeds', async () => {
    const { service, update } = build([{ attempts: 2, error: 'transient' }]);

    await service.retryPending(NOW);

    const [[, patch]] = update.mock.calls as unknown as [[unknown, { error: string | null }]];

    expect(patch.error).toBeNull();
  });

  /** 🔴 A failure counts, and the row stays retryable below the limit. */
  it('records a failed attempt without giving up', async () => {
    const apply = jest.fn(async () => {
      throw new Error('handler exploded');
    });

    const { service, update } = build([{ attempts: 1 }], apply);

    const outcome = await service.retryPending(NOW);

    expect(outcome).toMatchObject({ recovered: 0, deadLettered: 0 });

    const [[, patch]] = update.mock.calls as unknown as [
      [unknown, { attempts: number; deadAt: Date | null; error: string }],
    ];

    expect(patch.attempts).toBe(2);
    expect(patch.deadAt).toBeNull();
    expect(patch.error).toContain('handler exploded');
  });

  /**
   * 🔴 **Give up at the limit, and record WHEN.** Without `deadAt` the row
   * stays retryable for ever: a handler that fails deterministically — an
   * unmapped status, a malformed payload — would be re-run every cycle until
   * a person noticed.
   */
  it('dead-letters an event that has exhausted its attempts', async () => {
    const apply = jest.fn(async () => {
      throw new Error('still broken');
    });

    const { service, update } = build([{ attempts: MAX_ATTEMPTS - 1 }], apply);

    const outcome = await service.retryPending(NOW);

    expect(outcome.deadLettered).toBe(1);

    const [[, patch]] = update.mock.calls as unknown as [
      [unknown, { attempts: number; deadAt: Date | null }],
    ];

    expect(patch.attempts).toBe(MAX_ATTEMPTS);
    expect(patch.deadAt).toBeInstanceOf(Date);
  });

  /** ⚠️ One short of the limit is NOT dead — the boundary, asserted. */
  it('does not dead-letter one attempt early', async () => {
    const apply = jest.fn(async () => {
      throw new Error('nope');
    });

    const { service, update } = build([{ attempts: MAX_ATTEMPTS - 2 }], apply);

    await service.retryPending(NOW);

    const [[, patch]] = update.mock.calls as unknown as [[unknown, { deadAt: Date | null }]];

    expect(patch.deadAt).toBeNull();
  });

  /**
   * 🔴 **The query is the guard.** A dead row, a processed row and a row whose
   * request may still be running must all be excluded — and only the `where`
   * clause does that, so it is asserted rather than assumed from an empty
   * result.
   */
  it('asks only for rows that are unfinished, not dead, and old enough', async () => {
    const { service, repo } = build([]);

    await service.retryPending(NOW);

    const [[query]] = (repo.find as jest.Mock).mock.calls as [
      [{ where: Record<string, { type?: string; value?: unknown }> }],
    ];

    expect(query.where.processedAt.type).toBe('isNull');
    expect(query.where.deadAt.type).toBe('isNull');
    expect(query.where.createdAt.type).toBe('lessThan');
    expect(query.where.createdAt.value).toEqual(new Date(NOW.getTime() - RETRY_AFTER_MS));
  });

  /**
   * ⚠️ **One bad event must not abandon the rest.** A throw escaping the loop
   * would leave every later row unretried — and this worker exists for the
   * cases nobody is watching.
   */
  it('keeps going when one event fails', async () => {
    const apply = jest
      .fn()
      .mockRejectedValueOnce(new Error('first is broken'))
      .mockResolvedValue({ changed: true, detail: 'ok' });

    const { service } = build([{ attempts: 0 }, { attempts: 0 }], apply);

    const outcome = await service.retryPending(NOW);

    expect(outcome).toMatchObject({ retried: 2, recovered: 1 });
  });

  /** 📌 Nothing pending is the normal case and must be silent and cheap. */
  it('does nothing when no event is waiting', async () => {
    const { service, update, apply } = build([]);

    await expect(service.retryPending(NOW)).resolves.toMatchObject({
      retried: 0,
      recovered: 0,
      deadLettered: 0,
    });

    expect(apply).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **The handler is given the STORED payload**, not a re-fetch. The event
   * is what Stripe sent at the time; asking the provider again would replay
   * today's state against an old event and could apply a change twice.
   */
  it('replays the stored payload', async () => {
    const { service, apply } = build([{ type: 'invoice.paid', payload: { id: 'in_9' } }]);

    await service.retryPending(NOW);

    expect(apply).toHaveBeenCalledWith('invoice.paid', { id: 'in_9' });
  });
});
