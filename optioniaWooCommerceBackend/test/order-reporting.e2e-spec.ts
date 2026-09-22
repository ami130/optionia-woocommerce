import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';

import type { ReportOrderDto } from '../src/orders/dto/report-order.dto';
import { OrdersService } from '../src/orders/orders.service';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * Order reporting (M12.7).
 *
 * The analytics input Phase 25 reads. Two properties carry this endpoint:
 * **idempotency**, because the plugin retries, and **store isolation**, because
 * the rows are revenue.
 */
describe('order reporting (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('ord127');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    await harness.tenant('a');
    await harness.tenant('b');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
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

  /** A well-formed report; individual tests override what they are about. */
  const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    external_order_id: `wc-${Math.random().toString(36).slice(2, 10)}`,
    order_total_minor: 17900,
    currency: 'GBP',
    option_revenue_minor: 9900,
    occurred_at: '2026-08-30T10:00:00.000Z',
    selections: [
      {
        option_key: 'finish',
        option_label: 'Finish',
        value_key: 'lux',
        value_label: 'Luxury',
        price_delta_minor: 9900,
        config_version: 7,
      },
    ],
    ...overrides,
  });

  const report = (token: string, body: object): request.Test =>
    request(app.getHttpServer())
      .post('/v1/store/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const eventsFor = async (storeId: string): Promise<Array<Record<string, unknown>>> =>
    dataSource.query(`SELECT * FROM order_events WHERE storeId = ?`, [storeId]);

  const selectionsFor = async (eventId: string): Promise<Array<Record<string, unknown>>> =>
    dataSource.query(
      `SELECT * FROM order_selections WHERE orderEventId = ? ORDER BY optionKey`,
      [eventId],
    );

  // --- The happy path ------------------------------------------------------

  describe('recording an order', () => {
    /**
     * The persisted rows, not the response.
     *
     * The response echoes derived values; `order_events` and `order_selections`
     * are where the endpoint's only real effect lands.
     */
    it('writes the event and its selections', async () => {
      const store = await connected();
      const body = payload();

      const response = await report(store.token, body).expect(200);

      expect(response.body.data.duplicate).toBe(false);

      const events = await eventsFor(store.id);
      expect(events).toHaveLength(1);
      expect(events[0].externalOrderId).toBe(body.external_order_id);
      expect(Number(events[0].orderTotalMinor)).toBe(17900);
      expect(Number(events[0].optionRevenueMinor)).toBe(9900);
      expect(events[0].currency).toBe('GBP');

      const selections = await selectionsFor(events[0].id as string);
      expect(selections).toHaveLength(1);
      expect(selections[0].optionKey).toBe('finish');
      expect(selections[0].optionLabel).toBe('Finish');
      expect(selections[0].valueLabel).toBe('Luxury');
      expect(Number(selections[0].priceDeltaMinor)).toBe(9900);
      expect(Number(selections[0].configVersion)).toBe(7);
    });

    /**
     * The store's clock, not arrival time.
     *
     * A queued report can arrive hours late after an outage. Dating it on
     * arrival would misattribute a whole day's revenue after every incident,
     * which is exactly when the numbers are being looked at.
     */
    it('dates the order by when it was placed, not when it arrived', async () => {
      const store = await connected();

      await report(store.token, payload({ occurred_at: '2026-08-01T09:30:00.000Z' })).expect(200);

      const [event] = await eventsFor(store.id);
      expect(new Date(event.occurredAt as string).toISOString()).toBe('2026-08-01T09:30:00.000Z');
    });

    /** An order with no options is still revenue, and still reportable. */
    it('accepts an order with no selections', async () => {
      const store = await connected();

      await report(
        store.token,
        payload({ selections: [], option_revenue_minor: 0 }),
      ).expect(200);

      const [event] = await eventsFor(store.id);
      expect(await selectionsFor(event.id as string)).toHaveLength(0);
    });

    /**
     * 🔴 **Currency is stored upper-cased, whatever case it arrives in.**
     *
     * Found 2026-09-01 by mutation: removing `toUpperCase()` passed all 23
     * tests, because every fixture already sent `GBP`. The plugin upper-cases
     * before sending, so this is defence in depth — but the endpoint accepts any
     * store credential, and `gbp` alongside `GBP` would **split analytics
     * silently**: two currency rows for one currency, wrong in a way nobody
     * notices until a Phase 25 report looks odd.
     */
    it('stores the currency upper-cased whatever case it arrives in', async () => {
      const store = await connected();

      await report(store.token, payload({ currency: 'gbp' })).expect(200);

      const [event] = await eventsFor(store.id);
      expect(event.currency).toBe('GBP');
    });

    /** A discount option is legitimate, so the delta is signed. */
    it('accepts a negative price delta', async () => {
      const store = await connected();

      await report(
        store.token,
        payload({
          selections: [
            {
              option_key: 'bundle',
              option_label: 'Bundle discount',
              value_key: 'yes',
              value_label: 'Yes',
              price_delta_minor: -500,
              config_version: 7,
            },
          ],
        }),
      ).expect(200);

      const [event] = await eventsFor(store.id);
      const [selection] = await selectionsFor(event.id as string);
      expect(Number(selection.priceDeltaMinor)).toBe(-500);
    });

    /** Free-text options report a null value key and label. */
    it('accepts a selection with no value key', async () => {
      const store = await connected();

      await report(
        store.token,
        payload({
          selections: [
            {
              option_key: 'engraving',
              option_label: 'Engraving',
              value_key: null,
              value_label: null,
              price_delta_minor: 1500,
              config_version: 7,
            },
          ],
        }),
      ).expect(200);

      const [event] = await eventsFor(store.id);
      const [selection] = await selectionsFor(event.id as string);
      expect(selection.valueKey).toBeNull();
      expect(selection.valueLabel).toBeNull();
      expect(Number(selection.priceDeltaMinor)).toBe(1500);
    });
  });

  // --- Idempotency ---------------------------------------------------------

  describe('idempotency', () => {
    /**
     * **The property the whole endpoint is built around.**
     *
     * The plugin retries when a response is sent but never received. A second
     * delivery must not double-count revenue.
     */
    it('a repeated report does not create a second event', async () => {
      const store = await connected();
      const body = payload();

      const first = await report(store.token, body).expect(200);
      const second = await report(store.token, body).expect(200);

      expect(first.body.data.duplicate).toBe(false);
      expect(second.body.data.duplicate).toBe(true);
      expect(second.body.data.id).toBe(first.body.data.id);

      expect(await eventsFor(store.id)).toHaveLength(1);
    });

    /**
     * **Selections are replaced, not appended.**
     *
     * Appending would double-count every option on the second delivery — the
     * analytics corruption idempotency exists to prevent, and invisible in the
     * event row alone because the parent is correctly deduplicated.
     */
    it('a repeated report does not duplicate the selections', async () => {
      const store = await connected();
      const body = payload();

      await report(store.token, body).expect(200);
      await report(store.token, body).expect(200);

      const [event] = await eventsFor(store.id);
      expect(await selectionsFor(event.id as string)).toHaveLength(1);
    });

    /**
     * A corrected report overwrites rather than accumulating.
     *
     * The plugin sends an order's final state; if a total is corrected before
     * the report succeeds, the last delivery is the true one.
     */
    it('a corrected report replaces what was stored', async () => {
      const store = await connected();
      const id = 'wc-corrected-1';

      await report(store.token, payload({ external_order_id: id })).expect(200);
      await report(
        store.token,
        payload({
          external_order_id: id,
          order_total_minor: 20000,
          option_revenue_minor: 12000,
          selections: [
            {
              option_key: 'finish',
              option_label: 'Finish',
              value_key: 'gold',
              value_label: 'Gold',
              price_delta_minor: 12000,
              config_version: 8,
            },
          ],
        }),
      ).expect(200);

      const events = await eventsFor(store.id);
      expect(events).toHaveLength(1);
      expect(Number(events[0].orderTotalMinor)).toBe(20000);

      const selections = await selectionsFor(events[0].id as string);
      expect(selections).toHaveLength(1);
      expect(selections[0].valueKey).toBe('gold');
    });

    /**
     * **Concurrent delivery of the same order.**
     *
     * WordPress cron is not single-threaded, so two drains can overlap. A
     * check-then-insert would let both find no row and both insert; one would
     * win and the other would surface a constraint violation as a 500, telling
     * a correctly-behaving plugin to retry forever.
     */
    it('survives the same order arriving twice at once', async () => {
      const store = await connected();
      const body = payload({ external_order_id: 'wc-race-1' });

      const responses = await Promise.all([
        report(store.token, body),
        report(store.token, body),
        report(store.token, body),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      expect(await eventsFor(store.id)).toHaveLength(1);
    });

    /**
     * The key is scoped to the store.
     *
     * WooCommerce order ids restart at 1 on every install, so two stores
     * reporting order `1` are two different orders.
     */
    it('the same order id from a different store is a different order', async () => {
      const first = await connected('a');
      const second = await connected('b');
      const body = payload({ external_order_id: 'wc-1' });

      await report(first.token, body).expect(200);
      await report(second.token, body).expect(200);

      expect(await eventsFor(first.id)).toHaveLength(1);
      expect(await eventsFor(second.id)).toHaveLength(1);
    });
  });

  // --- Isolation and authentication ----------------------------------------

  describe('authentication', () => {
    it('refuses an unauthenticated report', async () => {
      await request(app.getHttpServer())
        .post('/v1/store/orders')
        .send(payload())
        .expect(401);
    });

    it('refuses an unknown credential', async () => {
      await report('not-a-real-token', payload()).expect(401);
    });

    /**
     * A revoked credential cannot report.
     *
     * Revocation is immediate by design (M8.6) — the reason store auth is an
     * opaque token checked against the database rather than a JWT.
     */
    it('refuses a revoked credential', async () => {
      const store = await connected();

      await dataSource.query(`UPDATE store_credentials SET revokedAt = NOW(3) WHERE storeId = ?`, [
        store.id,
      ]);

      await report(store.token, payload()).expect(401);
      expect(await eventsFor(store.id)).toHaveLength(0);
    });

    /**
     * A forged `store_id` in the body is rejected outright.
     *
     * This asserts the **validation pipe**, not the service:
     * `forbidNonWhitelisted` turns an unknown field into a 400 before any
     * handler runs. Necessary but not sufficient — see the test below, which
     * exists because this one passed against a service that trusted the body.
     */
    it('refuses a body carrying a store id', async () => {
      const mine = await connected('a');
      const theirs = await connected('b');

      await report(mine.token, payload({ store_id: theirs.id })).expect(400);

      expect(await eventsFor(theirs.id)).toHaveLength(0);
      expect(await eventsFor(mine.id)).toHaveLength(0);
    });

    /**
     * **The service attributes revenue to the credential, never to its input.**
     *
     * 🔴 Found by mutation, 2026-09-01: a service reading `store_id` from the
     * DTO passed **every** test above. The request-level test could not see it,
     * because the whitelist strips the field before the service is reached — so
     * it proves the pipe, and the pipe is not what would be wrong.
     *
     * This calls the service directly with a forged field present, which is the
     * only place the question can actually be asked. A cross-tenant revenue
     * write is the worst defect this endpoint could carry, so it is tested
     * where it would happen.
     */
    it('ignores a store id even when one reaches the service', async () => {
      const mine = await connected('a');
      const theirs = await connected('b');
      const service = app.get(OrdersService);

      const forged = {
        ...payload({ external_order_id: 'wc-forged-1' }),
        store_id: theirs.id,
      } as unknown as ReportOrderDto;

      await service.report(mine.id, forged);

      expect(await eventsFor(mine.id)).toHaveLength(1);
      expect(await eventsFor(theirs.id)).toHaveLength(0);
    });
  });

  // --- Validation ----------------------------------------------------------

  describe('validation', () => {
    it('refuses an unknown field rather than ignoring it', async () => {
      const store = await connected();

      await report(store.token, payload({ unexpected: 'field' })).expect(400);
      expect(await eventsFor(store.id)).toHaveLength(0);
    });

    it('refuses a missing order id', async () => {
      const store = await connected();
      const body = payload();
      delete body.external_order_id;

      await report(store.token, body).expect(400);
    });

    it('refuses a fractional amount', async () => {
      const store = await connected();

      await report(store.token, payload({ order_total_minor: 179.5 })).expect(400);
    });

    it('refuses a malformed timestamp', async () => {
      const store = await connected();

      await report(store.token, payload({ occurred_at: 'last tuesday' })).expect(400);
    });

    it('refuses a currency that is not three characters', async () => {
      const store = await connected();

      await report(store.token, payload({ currency: 'POUNDS' })).expect(400);
    });

    it('refuses an over-long option label', async () => {
      const store = await connected();

      await report(
        store.token,
        payload({
          selections: [
            {
              option_key: 'finish',
              option_label: 'x'.repeat(201),
              value_key: 'lux',
              value_label: 'Luxury',
              price_delta_minor: 0,
            },
          ],
        }),
      ).expect(400);
    });

    /**
     * A bounded transaction.
     *
     * Without the cap one request could ask for unbounded work, and the array
     * shape alone is valid — `forbidNonWhitelisted` would not stop it.
     */
    it('refuses an unreasonable number of selections', async () => {
      const store = await connected();

      await report(
        store.token,
        payload({
          selections: Array.from({ length: 201 }, (_, index) => ({
            option_key: `opt-${index}`,
            option_label: 'Option',
            value_key: 'v',
            value_label: 'Value',
            price_delta_minor: 0,
          })),
        }),
      ).expect(400);
    });

    /**
     * A rejected report writes nothing at all.
     *
     * The event and its selections are written in one transaction, so a
     * failure cannot leave an order with no selections — which would read as a
     * plain product sale rather than as a missing write.
     */
    it('writes nothing when one selection is invalid', async () => {
      const store = await connected();

      await report(
        store.token,
        payload({
          selections: [
            {
              option_key: 'finish',
              option_label: 'Finish',
              value_key: 'lux',
              value_label: 'Luxury',
              price_delta_minor: 9900,
            },
            {
              option_key: 'engraving',
              option_label: 'Engraving',
              value_key: 'yes',
              value_label: 'Yes',
              price_delta_minor: 'free',
            },
          ],
        }),
      ).expect(400);

      expect(await eventsFor(store.id)).toHaveLength(0);
    });
  });
});
