import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';

import { createHarness, type Harness } from './harness';

/**
 * Option view counts (M25.1, stage 25-4).
 *
 * ## The two properties that carry this endpoint
 *
 * 🔴 **Accumulation**, because the plugin sends a DELTA it clears only after a
 * 2xx. If the write replaced rather than added, every drain would discard the
 * counts from the one before it and a merchant's conversion rate would be built
 * on the last few minutes of traffic.
 *
 * 🔴 **Store isolation**, because a view count is the denominator of a
 * conversion rate. One store's traffic appearing under another's would not look
 * like a leak — it would look like a good week.
 *
 * ⚠️ **And one negative property: a browser cannot reach it.** The design's
 * first constraint is that the store credential never leaves the server, so this
 * asserts an unauthenticated caller is refused — the case that would otherwise
 * let anyone inflate or poison any merchant's analytics.
 */
describe('option view counts (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  beforeAll(async () => {
    harness = await createHarness('views7k');
    app = harness.app;
    dataSource = harness.dataSource;

    await harness.tenant('a');
    await harness.tenant('b');
  }, 120_000);

  afterAll(async () => {
    await dataSource.query(
      `DELETE c FROM option_view_counts c JOIN stores s ON s.id = c.storeId
        JOIN tenants t ON t.id = s.tenantId WHERE t.slug LIKE 'views7k-%'`,
    );

    await harness?.close();
  });

  /** A connected store with a live credential — a plugin that can report. */
  async function connected(tenant: 'a' | 'b' = 'a'): Promise<{ id: string; token: string }> {
    const id = await harness.store(tenant);
    const credential = generateStoreToken();

    await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
      StoreStatus.CONNECTED,
      id,
    ]);
    await dataSource.query(
      `INSERT INTO store_credentials
         (id, createdAt, updatedAt, storeId, tokenHash, tokenPrefix, scopes)
       VALUES (UUID(), NOW(3), NOW(3), ?, ?, ?, '')`,
      [id, credential.hash, credential.prefix],
    );

    return { id, token: credential.plaintext };
  }

  const report = (token: string, body: object): request.Test =>
    request(app.getHttpServer())
      .post('/v1/store/views')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const countsFor = async (storeId: string): Promise<Array<Record<string, unknown>>> =>
    dataSource.query(
      `SELECT optionKey, DATE_FORMAT(day, '%Y-%m-%d') AS day, views
         FROM option_view_counts WHERE storeId = ? ORDER BY optionKey`,
      [storeId],
    );

  const view = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    option_set_id: '11111111-1111-4111-8111-111111111111',
    option_key: 'engraving',
    day: '2026-09-29',
    views: 5,
    ...overrides,
  });

  /** 🔴 The whole point: a count reaches the cloud and is stored. */
  it('records a batch of view counts', async () => {
    const store = await connected();

    const response = await report(store.token, { views: [view()] });

    expect(response.status).toBe(200);
    expect(response.body.data.recorded).toBe(1);

    const [row] = await countsFor(store.id);

    expect(row).toMatchObject({ optionKey: 'engraving', day: '2026-09-29', views: 5 });
  });

  /**
   * 🔴 **The second batch ADDS, it does not replace.** The plugin sends a delta
   * and clears it only on success, so every drain after the first would be
   * discarded by a replacing write — and a merchant's conversion rate would
   * rest on whatever happened since the last cron run.
   */
  it('adds a later batch to what the store already reported', async () => {
    const store = await connected();

    await report(store.token, { views: [view({ views: 5 })] });
    await report(store.token, { views: [view({ views: 3 })] });

    const [row] = await countsFor(store.id);

    expect(row.views).toBe(8);
  });

  /**
   * ⚠️ **A different day is a different row**, which is what makes "compared
   * with the period before" answerable at all. Collapsing days would leave one
   * lifetime total and no way to see change.
   */
  it('keeps each day separate', async () => {
    const store = await connected();

    await report(store.token, { views: [view({ day: '2026-09-28', views: 4 })] });
    await report(store.token, { views: [view({ day: '2026-09-29', views: 6 })] });

    const rows = await countsFor(store.id);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.views).sort()).toEqual([4, 6]);
  });

  /** 📌 Several options in one batch, which is the shape a page produces. */
  it('records every option in one batch', async () => {
    const store = await connected();

    const response = await report(store.token, {
      views: [view({ option_key: 'engraving' }), view({ option_key: 'finish', views: 2 })],
    });

    expect(response.status).toBe(200);
    expect(response.body.data.recorded).toBe(2);
    expect(await countsFor(store.id)).toHaveLength(2);
  });

  /**
   * 🔴 **A view count is the denominator of a conversion rate**, so a leak
   * across stores would not read as a bug — it would read as a good week.
   */
  it('never lets one store’s views reach another', async () => {
    const mine = await connected('a');
    const theirs = await connected('b');

    await report(mine.token, { views: [view({ views: 9 })] });

    expect(await countsFor(theirs.id)).toHaveLength(0);
  });

  /**
   * 🔴 **The security property the whole transport design rests on.** The store
   * credential never reaches a customer's browser; if this route accepted an
   * unauthenticated call, a beacon could have gone straight here — and so could
   * anyone else's, for any store.
   */
  it('refuses a caller with no credential', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/store/views')
      .send({ views: [view()] });

    expect(response.status).toBe(401);
  });

  /** ⚠️ And a credential that is not a real one. */
  it('refuses a forged credential', async () => {
    const response = await report('not-a-real-token', { views: [view()] });

    expect(response.status).toBe(401);
  });

  /**
   * ⚠️ **A malformed day is refused, not stored as an epoch.**
   * `new Date('2026-13-45')` is a silent `Invalid Date` in JavaScript, so
   * without the format check a nonsense date would land in the table as null or
   * 1970 and quietly distort whichever period a merchant looked at.
   */
  it('refuses a day that is not a date', async () => {
    const store = await connected();

    expect((await report(store.token, { views: [view({ day: 'yesterday' })] })).status).toBe(400);

    /*
     * 🔴 **This one produced a 500 before the real-date check existed.** It
     * matches `\d{4}-\d{2}-\d{2}` perfectly and MySQL refuses month 13, so it
     * reached the driver — and a merchant's plugin would have retried a request
     * that could never succeed, for ever.
     */
    expect((await report(store.token, { views: [view({ day: '2026-13-45' })] })).status).toBe(400);

    /*
     * ⚠️ **And a date that ROLLS OVER rather than failing.** `new Date()` turns
     * 31 February into 3 March without complaint, which would store a day the
     * customer never browsed — a wrong answer is worse than a refused one.
     */
    expect((await report(store.token, { views: [view({ day: '2026-02-31' })] })).status).toBe(400);
  });

  /**
   * ⚠️ **A count no option could honestly earn is refused.** A million views of
   * one option between two cron runs is a bug or an attack, and silently adding
   * it would corrupt a merchant's analytics with no way to tell which day was
   * wrong.
   */
  it('refuses an implausible count', async () => {
    const store = await connected();

    expect((await report(store.token, { views: [view({ views: 2_000_000 })] })).status).toBe(400);
    expect((await report(store.token, { views: [view({ views: 0 })] })).status).toBe(400);
    expect((await report(store.token, { views: [view({ views: -5 })] })).status).toBe(400);
  });

  /**
   * 📌 **An empty batch is a success, not an error.** The plugin drains on a
   * fixed schedule whether or not anything accumulated, and answering 400 to
   * "nothing happened" would make every quiet hour look like a failure in the
   * merchant's log.
   */
  it('accepts an empty batch without writing anything', async () => {
    const store = await connected();

    const response = await report(store.token, { views: [] });

    expect(response.status).toBe(200);
    expect(response.body.data.recorded).toBe(0);
    expect(await countsFor(store.id)).toHaveLength(0);
  });

  /**
   * ⚠️ **Bounded, because this endpoint is driven by a merchant's traffic.** An
   * unbounded array would let one request hold a connection open for as long as
   * it liked; the plugin sends the rest on the next drain.
   */
  it('refuses a batch beyond the cap', async () => {
    const store = await connected();

    const tooMany = Array.from({ length: 501 }, (_, index) =>
      view({ option_key: `opt-${index}` }),
    );

    expect((await report(store.token, { views: tooMany })).status).toBe(400);
  });

  /**
   * 🔒 **Nothing about a person is stored, and this pins it.** M25.6's rule is
   * that analytics introduces no new personal data — a view row is a store, an
   * option, a day and a number, and there is deliberately nowhere to put an
   * identifier even if a later payload offered one.
   */
  it('stores nothing that could identify a customer', async () => {
    const store = await connected();

    await report(store.token, { views: [view()] });

    const [row] = (await dataSource.query(
      `SELECT * FROM option_view_counts WHERE storeId = ?`,
      [store.id],
    )) as Array<Record<string, unknown>>;

    const columns = Object.keys(row).map((key) => key.toLowerCase());

    for (const forbidden of ['ip', 'session', 'customer', 'user', 'email', 'agent']) {
      expect(columns.some((column) => column.includes(forbidden))).toBe(false);
    }
  });
});
