import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { createHarness, idOf, type Harness } from './harness';

/**
 * The rule tester over HTTP (M17.6, ADR-053).
 *
 * 🔴 **The unit tests prove the service; these prove the WIRING.** A service
 * that decides correctly behind a route that rejects its body, or guards it as a
 * write, is a feature a merchant cannot reach — and no unit test can see that.
 *
 * ⚠️ **`enableImplicitConversion: true` is why the body is asserted at all.**
 * `main.ts` sets it, and the sibling DTO records what it does to a field whose
 * element type `class-transformer` has to infer: every condition became `[]`
 * **before any validator ran**. An answers map survives it, and this is what
 * proves that rather than assuming it.
 *
 * ⚠️ **Every assertion reads `body.data`.** The API wraps responses in
 * `{ data, meta }`, so a test asserting `body.hiddenOptionIds` compares
 * `undefined` to an expectation and fails whatever the endpoint did — measured
 * while writing this, on a route that was working correctly throughout.
 */
describe('rule tester (e2e)', () => {
  let harness: Harness;
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'rtst3';

  let token = '';
  let tenantId = '';
  let storeId = '';

  beforeAll(async () => {
    harness = await createHarness(NS);
    app = harness.app;
    dataSource = harness.dataSource;
    await harness.cleanup();

    token = await harness.tenant('a');

    const [row] = await dataSource.query(
      `SELECT tm.tenantId AS id FROM tenant_members tm JOIN users u ON u.id = tm.userId
        WHERE u.email = ?`,
      [`${NS}-a@example.com`],
    );
    tenantId = row.id as string;
    storeId = randomUUID();

    await dataSource.query(
      `INSERT INTO stores (id, tenantId, platform, name, storeUrl, status, configVersion,
                           createdAt, updatedAt)
       VALUES (?, ?, 'woocommerce', 'store', ?, 'connected', 0, NOW(3), NOW(3))`,
      [storeId, tenantId, `https://${storeId}.example.com`],
    );
  }, 120_000);

  afterAll(async () => {
    await harness.cleanup();
    await harness.close();
  });

  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /**
   * A set with two options and a rule hiding the second when the first is "yes".
   *
   * ⚠️ **Never published.** The tester reads the merchant's draft, and building
   * this without a publish is what proves it.
   */
  async function draftSet(): Promise<{ set: string; trigger: string; target: string }> {
    const set = idOf(await post('/option-sets', { name: `tester ${randomUUID()}`, storeId }), 'set');
    const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'Customisation' }), 'group');

    const trigger = idOf(
      await post(`/groups/${group}/options`, {
        key: `eng${randomUUID().slice(0, 8)}`,
        label: 'Engraving',
        presentation: 'radio',
      }),
      'option',
    );

    const target = idOf(
      await post(`/groups/${group}/options`, {
        key: `txt${randomUUID().slice(0, 8)}`,
        label: 'Engraving Text',
        presentation: 'text_field',
      }),
      'option',
    );

    await post(`/options/${trigger}/values`, { valueKey: 'yes', label: 'Yes' });

    await post(`/option-sets/${set}/rules`, {
      targetType: 'option',
      targetId: target,
      action: 'hide',
      matchType: 'all',
      conditions: [{ optionId: trigger, operator: 'equals', value: 'yes' }],
    });

    return { set, trigger, target };
  }

  it('reports a hidden option for answers that fire the rule', async () => {
    const { set, trigger, target } = await draftSet();

    const response = await post(`/option-sets/${set}/rules/test`, {
      answers: { [trigger]: 'yes' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.hiddenOptionIds).toEqual([target]);
    expect(response.body.data.refused).toBeNull();
  });

  /**
   * The control. Without it, a route that always reported everything hidden
   * would satisfy the test above.
   */
  it('reports nothing for answers that do not fire it', async () => {
    const { set, trigger } = await draftSet();

    const response = await post(`/option-sets/${set}/rules/test`, {
      answers: { [trigger]: 'no' },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.hiddenOptionIds).toEqual([]);
  });

  /**
   * 🔴 **The set was never published, and the tester still sees its rule.**
   *
   * ADR-053: a rule being tested has usually not been published, and a tester
   * that could not see it would answer a question nobody asked. This is the
   * deliberate opposite of the config document, which is built from published
   * snapshots precisely so it cannot ship unpublished edits.
   */
  it('reads the draft, so an unpublished rule is included', async () => {
    const { set, trigger, target } = await draftSet();

    const [published] = await dataSource.query(
      'SELECT publishedAt FROM option_sets WHERE id = ?',
      [set],
    );

    expect(published.publishedAt).toBeNull();

    const response = await post(`/option-sets/${set}/rules/test`, {
      answers: { [trigger]: 'yes' },
    });

    expect(response.body.data.hiddenOptionIds).toEqual([target]);
  });

  /**
   * ⚠️ **An answers map must survive `enableImplicitConversion`.**
   *
   * The sibling DTO's note records a payload arriving as `[[]]` because
   * `class-transformer` inferred an element type and coerced to it. A map with
   * several entries is what would show that here.
   */
  it('carries a multi-entry answers map through validation intact', async () => {
    const { set, trigger, target } = await draftSet();

    const response = await post(`/option-sets/${set}/rules/test`, {
      answers: { [trigger]: 'yes', [target]: 'Happy Birthday', unknown: 42 },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.hiddenOptionIds).toEqual([target]);
  });

  /** A body without `answers` is a 400, not a silent empty evaluation. */
  it('refuses a request with no answers field', async () => {
    const { set } = await draftSet();

    expect((await post(`/option-sets/${set}/rules/test`, {})).status).toBe(400);
  });

  /** A set that does not exist is a 404, never an empty success. */
  it('answers 404 for a set that does not exist', async () => {
    const response = await post(`/option-sets/${randomUUID()}/rules/test`, { answers: {} });

    expect(response.status).toBe(404);
  });
});
