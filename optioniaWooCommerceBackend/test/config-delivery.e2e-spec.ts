import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';
import { matchesEtag } from '../src/config-delivery/config-etag';
import { OptionSetAssignment } from '../src/option-sets/entities/option-set-assignment.entity';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * `GET /store/config` — the document a storefront renders from (M9.1).
 *
 * The interesting assertions here are not "does it return the document". They
 * are the two things that make a conditional endpoint worth having:
 *
 * - a `304` must carry **no body**, which this API's envelope would otherwise
 *   supply for it;
 * - a `304` must not **build** the document, which is the entire reason the
 *   client asked conditionally. That one is invisible to a status-code
 *   assertion, so it is measured by counting queries.
 */
describe('config delivery (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;

  let merchantToken = '';

  beforeAll(async () => {
    app = await bootstrapTestApp();
    harness = await createHarness('cfg9');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    merchantToken = await harness.tenant('a');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  /** A connected store holding a live credential. */
  async function connected(configVersion = 0): Promise<{ id: string; token: string }> {
    const id = await harness.store('a');
    const credential = generateStoreToken();

    await dataSource.query(`UPDATE stores SET status = ?, configVersion = ? WHERE id = ?`, [
      StoreStatus.CONNECTED,
      configVersion,
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

  /**
   * Give a store one published option set, through the real authoring API.
   *
   * Every test here used to run against a store with **no** option sets, so
   * `option_sets` was `[]` in every assertion and the endpoint had never
   * returned a document with content in it. That left the parts that only
   * appear at size — the snapshot join, serialisation cost, compression —
   * unexercised on the path that actually serves them.
   */
  async function publishSet(storeId: string, name: string): Promise<string> {
    const post = (path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(`/v1${path}`)
        .set('Authorization', `Bearer ${merchantToken}`)
        .send(body);

    const idOf = (response: request.Response, what: string): string => {
      if (!response.body?.data?.id) {
        throw new Error(`Fixture failed to create ${what}: ${JSON.stringify(response.body)}`);
      }

      return response.body.data.id as string;
    };

    const set = idOf(await post('/option-sets', { name, storeId }), 'set');
    const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'Customization' }), 'group');
    const option = idOf(
      await post(`/groups/${group}/options`, {
        key: `k${set.slice(0, 8)}`,
        label: 'Print placement',
        presentation: 'radio',
        isRequired: true,
      }),
      'option',
    );

    await post(`/options/${option}/values`, { valueKey: 'none', label: 'None', isDefault: true });
    await post(`/options/${option}/values`, {
      valueKey: 'front',
      label: 'Front',
      priceAmountMinor: 1000,
    });

    const published = await post(`/option-sets/${set}/publish`, {});

    if (published.status !== 201) {
      throw new Error(`Fixture failed to publish: ${JSON.stringify(published.body)}`);
    }

    return set;
  }

  /**
   * Attach an assignment to a set, writing the row directly.
   *
   * There is no authoring endpoint yet — the picker is M13.6 — so the fixture
   * writes what that picker will write. `matchRules` is set deliberately on one
   * of these: it is an internal column the storefront contract does not carry,
   * and a test that never populated it could not notice a spread putting it on
   * the wire.
   */
  async function assign(
    optionSetId: string,
    mode: 'all' | 'manual' | 'conditional',
    target: { type?: string; ref?: string; priority?: number; rules?: object } = {},
  ): Promise<void> {
    const repository = dataSource.getRepository(OptionSetAssignment);

    await repository.save(
      repository.create({
        optionSetId,
        mode: mode as never,
        targetType: (target.type ?? null) as never,
        targetRef: target.ref ?? null,
        matchRules: (target.rules ?? null) as never,
        priority: target.priority ?? 0,
      }),
    );
  }

  const fetch = (token: string, ifNoneMatch?: string): request.Test => {
    const call = request(app.getHttpServer())
      .get('/v1/store/config')
      .set('Authorization', `Bearer ${token}`);

    return ifNoneMatch ? call.set('If-None-Match', ifNoneMatch) : call;
  };

  describe('the document', () => {
    it('is served inside the envelope the plugin parses', async () => {
      const store = await connected(7);

      const response = await fetch(store.token);

      expect(response.status).toBe(200);

      // The envelope, and the payload one level in — never at the top.
      expect(response.body).toHaveProperty('meta.requestId');
      expect(response.body.data).toMatchObject({
        schema_version: 1,
        config_version: 7,
        store_id: store.id,
      });
      expect(response.body).not.toHaveProperty('config_version');
    });

    it('carries an ETag scoped to the store and its version', async () => {
      const store = await connected(7);

      const response = await fetch(store.token);

      expect(response.headers.etag).toBe(`W/"${store.id}-7"`);
    });

    /**
     * Two stores at the same version hold different documents. A validator that
     * named only the version would let a shared cache serve one merchant's
     * options to another.
     */
    it('gives two stores at the same version different ETags', async () => {
      const first = await connected(7);
      const second = await connected(7);

      const [a, b] = await Promise.all([fetch(first.token), fetch(second.token)]);

      expect(a.headers.etag).not.toBe(b.headers.etag);
    });

    it('is never cached by a shared intermediary', async () => {
      const store = await connected();

      const response = await fetch(store.token);

      expect(response.headers['cache-control']).toContain('private');
    });
  });

  describe('the conditional request', () => {
    it('answers 304 with no body when the ETag is current', async () => {
      const store = await connected(7);

      const response = await fetch(store.token, `W/"${store.id}-7"`);

      expect(response.status).toBe(304);

      /**
       * RFC 9110 §15.4.5: a 304 carries no body. This API wraps every returned
       * value in `{data, meta}`, and returning `undefined` is not enough —
       * the interceptor turns that into `{data: null, meta}` — so the handler
       * ends the response itself.
       *
       * The status alone proves little here: the HTTP stack runs its own
       * freshness check against the `ETag` header and will answer `304`
       * regardless of what this code decided. The *absence of a body* is the
       * part that belongs to the handler.
       */
      expect(response.body).toEqual({});
      expect(response.text).toBeFalsy();
      expect(response.headers['content-length']).toBeUndefined();
    });

    it('answers 200 when the client is behind', async () => {
      const store = await connected(7);

      const response = await fetch(store.token, `W/"${store.id}-6"`);

      expect(response.status).toBe(200);
      expect(response.body.data.config_version).toBe(7);
    });

    /**
     * A publish between two fetches must reach the storefront.
     *
     * The path this guards: the plugin holds version 7, the merchant publishes,
     * and the next conditional request must not be answered from the version
     * the plugin already has.
     */
    it('stops matching once the version moves', async () => {
      const store = await connected(7);
      const first = await fetch(store.token);

      await dataSource.query(`UPDATE stores SET configVersion = 8 WHERE id = ?`, [store.id]);

      const second = await fetch(store.token, first.headers.etag);

      expect(second.status).toBe(200);
      expect(second.body.data.config_version).toBe(8);
      expect(second.headers.etag).toBe(`W/"${store.id}-8"`);
    });

    /** `*` matches any existing representation (RFC 9110 §13.1.2). */
    it('treats a wildcard as a match', async () => {
      const store = await connected(7);

      expect((await fetch(store.token, '*')).status).toBe(304);
    });

    /** A client may present several validators. */
    it('matches any entry in a list', async () => {
      const store = await connected(7);

      const response = await fetch(store.token, `W/"${store.id}-5", W/"${store.id}-7"`);

      expect(response.status).toBe(304);
    });

    /**
     * A client echoing a weak validator without its prefix is asking the same
     * question, and a false miss costs a full build and a full download.
     */
    /**
     * Asserted on the comparison directly, not through a request.
     *
     * A weak/strong mismatch reaching the wire is answered `304` by the HTTP
     * stack itself — Nest and Express run their own freshness check against the
     * `ETag` header this handler sets, so an end-to-end assertion here passes
     * whether or not `matchesEtag` strips the prefix. It was measured: with the
     * stripping removed, `matchesEtag` returned `false`, the handler sent `200`
     * with a full document, and the client still observed `304`.
     *
     * That makes the request-level test worse than useless — it reports the
     * framework's behaviour as though it were this code's. The unit assertion
     * below fails the moment the comparison stops being weak, which is the
     * property being claimed.
     */
    it('compares weakly', () => {
      const current = 'W/"store-7"';

      expect(matchesEtag('"store-7"', current)).toBe(true);
      expect(matchesEtag('W/"store-7"', current)).toBe(true);
      expect(matchesEtag('"store-6"', current)).toBe(false);
    });

    /**
     * The same treatment, for the two paths that did not get it.
     *
     * The reasoning above applies to every request-level assertion in this block,
     * and only the weak comparison was moved to a unit assertion when it was
     * written. Measured 2026-08-31: deleting the wildcard branch, and breaking the
     * comma split so a list is never separated, left `treats a wildcard as a
     * match` and `matches any entry in a list` both **passing** — the framework
     * answered `304` and the tests reported it as this code's decision.
     *
     * Both paths were verified correct at the same time; what was missing was a
     * test that could fail. These are those tests.
     */
    it('honours a wildcard and any entry in a list, asserted directly', () => {
      const current = 'W/"store-7"';

      // `*` matches any existing representation (RFC 9110 §13.1.2).
      expect(matchesEtag('*', current)).toBe(true);

      // A client may echo several validators; any one matching is a match.
      expect(matchesEtag('W/"store-5", W/"store-7"', current)).toBe(true);
      expect(matchesEtag('W/"store-5", W/"store-6"', current)).toBe(false);

      // Whitespace around an entry is the client's, not a mismatch.
      expect(matchesEtag('  W/"store-7"  ', current)).toBe(true);
    });

    it('ignores a validator belonging to another store', async () => {
      const first = await connected(7);
      const second = await connected(7);

      expect((await fetch(first.token, `W/"${second.id}-7"`)).status).toBe(200);
    });

    /**
     * **A 304 must not build the document.**
     *
     * The whole point of asking conditionally. An implementation that built the
     * document and discarded it would return a correct 304 having paid the full
     * price — and would pass every assertion above.
     *
     * Measured by counting queries rather than trusting the code: the
     * conditional path is one indexed read of `stores.configVersion`, while
     * building costs a store lookup, a set lookup and a snapshot lookup.
     */
    it('does not build the document to answer 304', async () => {
      const store = await connected(7);

      /**
       * Counted at the driver, not at `DataSource.query`.
       *
       * The builder reads through repositories, which never call that method —
       * a spy on it counts the guards and this service and misses the three
       * queries the build actually costs, reporting the conditional path as the
       * *more* expensive of the two. Wrapping the query runner catches every
       * statement whatever API issued it.
       */
      const counted = async (ifNoneMatch?: string): Promise<number> => {
        const driver = dataSource.driver as unknown as {
          createQueryRunner: (...args: unknown[]) => { query: (...a: unknown[]) => unknown };
        };
        const create = driver.createQueryRunner.bind(driver);

        let queries = 0;

        driver.createQueryRunner = (...args: unknown[]) => {
          const runner = create(...args);
          const run = runner.query.bind(runner);

          runner.query = (...inner: unknown[]) => {
            queries += 1;

            return run(...inner);
          };

          return runner;
        };

        try {
          await fetch(store.token, ifNoneMatch);
        } finally {
          driver.createQueryRunner = create;
        }

        return queries;
      };

      const forNotModified = await counted(`W/"${store.id}-7"`);
      const forDocument = await counted();

      expect(forNotModified).toBeLessThan(forDocument);
    });
  });

  /**
   * A document with content in it.
   *
   * Everything above runs against an empty store, which is the right shape for
   * asserting caching behaviour and the wrong one for asserting the endpoint
   * serves anything. These cover what only appears at size.
   */
  describe('a store with published configuration', () => {
    it('serves the published option sets', async () => {
      const store = await connected();
      await publishSet(store.id, 'Delivered');

      const response = await fetch(store.token);

      expect(response.status).toBe(200);
      expect(response.body.data.option_sets).toHaveLength(1);
      expect(response.body.data.option_sets[0].groups[0].options[0].values).toHaveLength(2);
    });

    /**
     * Publishing advances `config_version`, so the validator must move with it.
     *
     * The end-to-end version of the caching contract: a plugin holding the old
     * ETag is told there is something new, rather than being answered 304 from
     * a version the merchant has already replaced.
     */
    /**
     * Assignments reach the storefront, and reach it from live rows.
     *
     * Until Stage 1 of Phase 10 these were hardcoded `[]` in the serializer, so
     * the document a storefront received could never say which products an
     * option set applied to — the renderer had nothing to resolve.
     */
    describe('assignments', () => {
      it('carries an all and a manual assignment on the set they belong to', async () => {
        const store = await connected();
        const set = await publishSet(store.id, 'Assigned');

        await assign(set, 'all', { priority: 0 });
        await assign(set, 'manual', { type: 'product', ref: '20', priority: 5 });

        const response = await fetch(store.token).expect(200);
        const assignments = response.body.data.option_sets[0].assignments;

        expect(assignments).toHaveLength(2);
        expect(assignments[0]).toEqual({
          mode: 'all',
          target_type: null,
          target_ref: null,
          priority: 0,
        });
        expect(assignments[1]).toEqual({
          mode: 'manual',
          target_type: 'product',
          target_ref: '20',
          priority: 5,
        });
      });

      /**
       * **The test that distinguishes a read-time join from a serializer change.**
       *
       * The set is published *first*, so its snapshot is written with no
       * assignments in it — exactly the state every already-published set is in.
       * Assigning afterwards and seeing it in the document proves the join
       * happens on read. A serializer change could never satisfy this: snapshots
       * are immutable, so those sets would carry `[]` for ever.
       */
      it('shows an assignment added after the set was published', async () => {
        const store = await connected();
        const set = await publishSet(store.id, 'Published first');

        expect((await fetch(store.token)).body.data.option_sets[0].assignments).toHaveLength(0);

        await assign(set, 'manual', { type: 'product', ref: '23' });

        const after = await fetch(store.token).expect(200);

        expect(after.body.data.option_sets[0].assignments).toEqual([
          { mode: 'manual', target_type: 'product', target_ref: '23', priority: 0 },
        ]);
      });

      /**
       * The payload carries the contract's four fields and nothing else.
       *
       * `check-api-contract` verifies *routes*, not payload shapes, so a spread
       * of the entity would put `id`, `optionSetId` and `matchRules` on the wire
       * in `camelCase` and pass every gate. `matchRules` is the one that matters:
       * it is the conditional condition tree, internal by design.
       */
      it('leaks no internal column onto the wire', async () => {
        const store = await connected();
        const set = await publishSet(store.id, 'Internals');

        await assign(set, 'conditional', {
          type: 'category',
          ref: 'hoodies',
          rules: { all: [{ field: 'price', gt: 100 }] },
        });

        const [assignment] = (await fetch(store.token)).body.data.option_sets[0].assignments;

        expect(Object.keys(assignment).sort()).toEqual([
          'mode',
          'priority',
          'target_ref',
          'target_type',
        ]);
      });

      /**
       * One statement for the whole store, however many sets it has.
       *
       * Measured before this stage: the build was flat at **5** queries for one,
       * two and three published sets. The join adds exactly one, and must stay
       * flat — an N+1 here wears the right number at N=1, which is why every
       * count below runs at three sets and not one.
       *
       * The pre-existing budget test asserts only `304 < full build`, which holds
       * whether the build costs six statements or six hundred. This one is
       * absolute.
       *
       * The six are: resolve the credential, read `configVersion` for the ETag,
       * load the store, load its published sets, load their snapshots, and load
       * their assignments. The last is this stage's addition.
       */
      it('costs one extra query, however many sets are published', async () => {
        const store = await connected();

        const counted = async (): Promise<number> => {
          const driver = dataSource.driver as unknown as {
            createQueryRunner: (...args: unknown[]) => { query: (...a: unknown[]) => unknown };
          };
          const create = driver.createQueryRunner.bind(driver);

          let queries = 0;

          driver.createQueryRunner = (...args: unknown[]) => {
            const runner = create(...args);
            const run = runner.query.bind(runner);

            runner.query = (...inner: unknown[]) => {
              queries += 1;

              return run(...inner);
            };

            return runner;
          };

          try {
            await fetch(store.token);
          } finally {
            driver.createQueryRunner = create;
          }

          return queries;
        };

        const first = await publishSet(store.id, 'One');
        await assign(first, 'manual', { type: 'product', ref: '20' });

        /**
         * Warm the credential before counting.
         *
         * `StoreTokenGuard` writes `lastUsedAt` at most once every few minutes
         * (`LAST_USED_THROTTLE_MS`), so the *first* request of a run carries an
         * extra `UPDATE` that later ones do not. Counting it would measure the
         * throttle rather than the build, and would make the first assertion
         * differ from the rest for a reason that has nothing to do with
         * assignments.
         */
        await fetch(store.token);

        const withOne = await counted();

        const second = await publishSet(store.id, 'Two');
        await assign(second, 'manual', { type: 'product', ref: '21' });
        const withTwo = await counted();

        const third = await publishSet(store.id, 'Three');
        await assign(third, 'manual', { type: 'product', ref: '22' });
        const withThree = await counted();

        expect(withOne).toBe(6);
        expect(withTwo).toBe(6);
        expect(withThree).toBe(6);
      });

      /**
       * A deleted assignment stops reaching the storefront.
       *
       * The join carries the soft-delete predicate for the same reason every
       * other query here does: the sentinel means "live", and a query without it
       * serves rows the merchant removed.
       */
      /**
       * Assignments come back in priority order, whatever order they were written.
       *
       * **This test exists because removing the `ORDER BY` broke nothing.**
       * The first version of the ordering coverage inserted priority 0 then 5 —
       * already ascending — so insertion order matched sort order and the
       * assertion could not tell an ordered query from an unordered one. The
       * guarantee was stated in a comment and enforced nowhere, which is the
       * failure this repository keeps finding in its own checks.
       *
       * So the rows go in **descending**, and only a real `ORDER BY` can bring
       * them back ascending.
       *
       * Two reasons it is not cosmetic. [M10.1](../developePlan.md) merges
       * overlapping assignments by `priority`, so the resolution order a
       * storefront applies is this order. And the ETag is
       * `W/"<store_id>-<config_version>"` rather than a hash of the body, so a
       * reordered document is served under an **unchanged** validator: a
       * storefront holding one order would never be told about another.
       */
      it('returns assignments in priority order, not insertion order', async () => {
        const store = await connected();
        const set = await publishSet(store.id, 'Ordered');

        // Written high-to-low, deliberately.
        await assign(set, 'manual', { type: 'product', ref: 'third', priority: 30 });
        await assign(set, 'manual', { type: 'product', ref: 'second', priority: 20 });
        await assign(set, 'manual', { type: 'product', ref: 'first', priority: 10 });

        const response = await fetch(store.token).expect(200);

        expect(
          response.body.data.option_sets[0].assignments.map(
            (assignment: { target_ref: string }) => assignment.target_ref,
          ),
        ).toEqual(['first', 'second', 'third']);
      });

      /**
       * Equal priorities break their tie on `id`, not on storage order.
       *
       * Two builds of unchanged data must produce the same bytes — the set query
       * is ordered for that reason and says so, and the assignment query
       * inherited the claim. Equal priorities are what separate a deterministic
       * tie-break from an incidental one: `EXPLAIN` shows MySQL filesorting on
       * `priority` alone when `id` is dropped, and a filesort is not documented
       * as stable, so rows sharing a priority come back in whatever order the
       * engine offers.
       *
       * **Asserting only that two consecutive builds agree is not enough.** That
       * version of this test passed with the `id` tie-break removed: at this row
       * count the engine happened to return the same order twice, so it measured
       * a coincidence rather than a guarantee. Sorting the ids and comparing
       * against the order actually served pins it to the one order `ORDER BY
       * priority, id` can produce.
       */
      it('breaks equal priorities deterministically, by id', async () => {
        const store = await connected();
        const set = await publishSet(store.id, 'Stable');

        // Same priority on every row: only the tie-break can order these.
        for (const ref of ['d', 'c', 'b', 'a']) {
          await assign(set, 'manual', { type: 'product', ref, priority: 5 });
        }

        const rows = await dataSource.query(
          `SELECT id, targetRef FROM option_set_assignments WHERE optionSetId = ? ORDER BY id ASC`,
          [set],
        );
        const byId = (rows as { targetRef: string }[]).map((row) => row.targetRef);

        const served = (await fetch(store.token).expect(200)).body.data.option_sets[0].assignments;

        expect(served.map((a: { target_ref: string }) => a.target_ref)).toEqual(byId);

        // And it is the same answer twice, which is the property that matters.
        const again = (await fetch(store.token).expect(200)).body.data.option_sets[0].assignments;

        expect(JSON.stringify(again)).toBe(JSON.stringify(served));
      });

      /**
       * One store's assignments never reach another's document.
       *
       * `option_set_assignments` has **no `storeId`** — it keys on `optionSetId`
       * alone — so tenant scope is inherited from the `sets` list rather than
       * stated in this query. That is correct by construction, and it was
       * correct when probed; what it was not, until here, is *tested*.
       *
       * The existing cross-tenant test publishes no option sets, so it asserts
       * `store_id` and `config_version` and would pass against a join that
       * served every tenant's assignments. And `check-isolation` inspects
       * **routes, not queries**, so no gate covers it either.
       */
      it('never serves another store its assignments', async () => {
        const first = await connected();
        const second = await connected();

        const theirs = await publishSet(first.id, 'Theirs');
        const ours = await publishSet(second.id, 'Ours');

        await assign(theirs, 'manual', { type: 'product', ref: 'not-yours' });
        await assign(ours, 'manual', { type: 'product', ref: 'yours' });

        const response = await fetch(second.token).expect(200);

        expect(response.body.data.option_sets).toHaveLength(1);
        expect(response.body.data.option_sets[0].assignments).toEqual([
          { mode: 'manual', target_type: 'product', target_ref: 'yours', priority: 0 },
        ]);
        expect(JSON.stringify(response.body)).not.toContain('not-yours');
      });

      it('does not serve a soft-deleted assignment', async () => {
        const store = await connected();
        const set = await publishSet(store.id, 'Deleted assignment');

        await assign(set, 'manual', { type: 'product', ref: '20' });
        await dataSource.query(
          `UPDATE option_set_assignments SET deletedAt = NOW(3) WHERE optionSetId = ?`,
          [set],
        );

        const response = await fetch(store.token).expect(200);

        expect(response.body.data.option_sets[0].assignments).toHaveLength(0);
      });
    });

    it('changes its ETag when a set is published', async () => {
      const store = await connected();
      const before = await fetch(store.token);

      await publishSet(store.id, 'Second');

      const after = await fetch(store.token, before.headers.etag);

      expect(after.status).toBe(200);
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect(after.body.data.option_sets).toHaveLength(1);
    });

    /**
     * M9.1 requires the document gzipped.
     *
     * Measured on a real response rather than asserted from configuration: a
     * threshold that stopped matching, or middleware ordered after the body was
     * written, would leave this silently sending 30KB where 1.2KB would do —
     * every fifteen minutes, per store.
     */
    it('is gzipped for a client that accepts it', async () => {
      const store = await connected();

      // Enough sets to clear the 1KB threshold comfortably.
      await publishSet(store.id, 'Bulk one');
      await publishSet(store.id, 'Bulk two');
      await publishSet(store.id, 'Bulk three');

      const response = await request(app.getHttpServer())
        .get('/v1/store/config')
        .set('Authorization', `Bearer ${store.token}`)
        .set('Accept-Encoding', 'gzip');

      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(response.body.data.option_sets).toHaveLength(3);
    });

    /** A client that does not ask for compression is not given it. */
    it('is not compressed for a client that does not accept it', async () => {
      const store = await connected();
      await publishSet(store.id, 'Uncompressed');

      const response = await request(app.getHttpServer())
        .get('/v1/store/config')
        .set('Authorization', `Bearer ${store.token}`)
        .set('Accept-Encoding', 'identity');

      expect(response.headers['content-encoding']).toBeUndefined();
    });
  });

  /**
   * Deleting published configuration must reach the storefront (M9.4b).
   *
   * The document is built from published snapshots, so removing a published set
   * changes what a storefront is served — and `config_version` is the only
   * thing that tells a plugin to refetch. Before these existed, deleting a
   * published set removed it from the document and left the version untouched:
   * every connected store answered `304` and kept serving options the merchant
   * had deleted, until something else happened to publish.
   *
   * Both delete routes are covered, and both non-bumping cases with them — a
   * bump that fires when it should not invalidates every storefront cache for a
   * change no customer can observe.
   */
  describe('deleting published configuration', () => {
    const remove = (id: string, suffix = ''): request.Test =>
      request(app.getHttpServer())
        .delete(`/v1/option-sets/${id}${suffix}`)
        .set('Authorization', `Bearer ${merchantToken}`);

    const versionOf = async (token: string): Promise<number> =>
      (await fetch(token)).body.data.config_version;

    it('bumps when a published set is soft-deleted', async () => {
      const store = await connected();
      await publishSet(store.id, 'Deleted');

      const before = await fetch(store.token);
      const setId = before.body.data.option_sets[0].id;

      expect((await remove(setId)).status).toBe(204);

      const after = await fetch(store.token);

      expect(after.body.data.option_sets).toHaveLength(0);
      expect(after.body.data.config_version).toBe(before.body.data.config_version + 1);
      expect(after.headers.etag).not.toBe(before.headers.etag);
    });

    /**
     * Purge accepts a set that was never soft-deleted, so this is not merely
     * the second half of delete-then-erase — it is a route that can remove live
     * published configuration on its own.
     */
    it('bumps when a live published set is purged', async () => {
      const store = await connected();
      await publishSet(store.id, 'Purged');

      const before = await fetch(store.token);
      const setId = before.body.data.option_sets[0].id;

      expect((await remove(setId, '/permanent')).status).toBe(200);

      expect(await versionOf(store.token)).toBe(before.body.data.config_version + 1);
    });

    /**
     * Delete-then-erase is one removal, not two.
     *
     * The soft delete already took the set out of the document and moved the
     * version. Bumping again would make every storefront refetch an identical
     * document.
     */
    it('does not bump again when purging an already-deleted set', async () => {
      const store = await connected();
      await publishSet(store.id, 'Twice');

      const setId = (await fetch(store.token)).body.data.option_sets[0].id;

      await remove(setId);
      const afterSoft = await versionOf(store.token);

      await remove(setId, '/permanent');

      expect(await versionOf(store.token)).toBe(afterSoft);
    });

    /**
     * A draft was never in the document, so deleting it changes nothing a
     * storefront could observe.
     */
    it('does not bump when a draft is deleted', async () => {
      const store = await connected();

      const draft = await request(app.getHttpServer())
        .post('/v1/option-sets')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({ name: 'Draft only', storeId: store.id });

      const before = await versionOf(store.token);

      expect((await remove(draft.body.data.id)).status).toBe(204);

      expect(await versionOf(store.token)).toBe(before);
    });
  });

  /**
   * Queueing the push that M34.1c will send (M9.4).
   *
   * Nothing sends these yet — there is no worker, and `M34.1` forbids webhook
   * processing in the request path, which is what dispatching on publish would
   * be. The row is the handover: written here, drained there.
   *
   * Nothing is broken meanwhile. The plugin's fifteen-minute conditional pull
   * already delivers every change inside M9.4's fallback window, so the push is
   * a latency improvement over a working baseline rather than a dependency.
   */
  describe('queueing a configuration push', () => {
    /** The push URL a plugin sends during its handshake. */
    const PUSH_URL = 'https://shop.example.com/wp-json/optionia/v1/push';

    const deliveries = async (storeId: string): Promise<Array<Record<string, unknown>>> =>
      dataSource.query(
        `SELECT event, status, direction, attempts, payload
           FROM webhook_deliveries WHERE storeId = ? ORDER BY id`,
        [storeId],
      );

    it('queues one pending outbound delivery when configuration changes', async () => {
      const store = await connected();

      await dataSource.query(`UPDATE stores SET pushUrl = ? WHERE id = ?`, [PUSH_URL, store.id]);

      await publishSet(store.id, 'Queued');

      const rows = await deliveries(store.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event: 'config.updated',
        status: 'pending',
        direction: 'outbound',
        attempts: 0,
      });
    });

    /**
     * The payload names the version and nothing else.
     *
     * The push carries no configuration — it wakes a conditional pull — which
     * is what lets the channel need no payload trust: a forged push achieves at
     * most one `GET /store/config` returning `304`. A payload that grew to
     * carry configuration would turn a public endpoint into an injection
     * surface.
     */
    it('carries the version and no configuration', async () => {
      const store = await connected();

      await dataSource.query(`UPDATE stores SET pushUrl = ? WHERE id = ?`, [PUSH_URL, store.id]);
      await publishSet(store.id, 'Payload');

      const [row] = await deliveries(store.id);
      const payload =
        typeof row.payload === 'string' ? JSON.parse(row.payload as string) : row.payload;

      expect(Object.keys(payload as object).sort()).toEqual(['config_version', 'event']);
      expect((payload as { config_version: number }).config_version).toBeGreaterThan(0);
    });

    /**
     * A store with nowhere to push queues nothing.
     *
     * A plugin build predating the REST route has no `pushUrl`, and a delivery
     * with no destination is a row the worker can only fail. Those stores fall
     * back to the pull, which is the acceptance's own fallback path.
     */
    it('queues nothing for a store with no push URL', async () => {
      const store = await connected();

      await publishSet(store.id, 'Unqueued');

      expect(await deliveries(store.id)).toHaveLength(0);
    });

    /**
     * Deletion queues a push too.
     *
     * Every trigger that advances `config_version` is one a storefront must be
     * told about — that is what advancing it means. The enqueue lives beside
     * the bump so the pair cannot drift: a future trigger gets the push by
     * calling the same method rather than remembering a second one.
     */
    it('queues a push when a published set is deleted', async () => {
      const store = await connected();

      await dataSource.query(`UPDATE stores SET pushUrl = ? WHERE id = ?`, [PUSH_URL, store.id]);
      await publishSet(store.id, 'ToDelete');

      const setId = (await fetch(store.token)).body.data.option_sets[0].id;

      await request(app.getHttpServer())
        .delete(`/v1/option-sets/${setId}`)
        .set('Authorization', `Bearer ${merchantToken}`);

      // One for the publish, one for the deletion.
      expect(await deliveries(store.id)).toHaveLength(2);
    });

    /**
     * A draft edit queues nothing.
     *
     * The version does not move for a change no storefront can see, so neither
     * does the queue — the two decisions are the same decision.
     */
    it('queues nothing for a change no storefront can see', async () => {
      const store = await connected();

      await dataSource.query(`UPDATE stores SET pushUrl = ? WHERE id = ?`, [PUSH_URL, store.id]);

      const draft = await request(app.getHttpServer())
        .post('/v1/option-sets')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({ name: 'Draft only', storeId: store.id });

      await request(app.getHttpServer())
        .delete(`/v1/option-sets/${draft.body.data.id}`)
        .set('Authorization', `Bearer ${merchantToken}`);

      expect(await deliveries(store.id)).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('refuses a request with no credential', async () => {
      expect((await request(app.getHttpServer()).get('/v1/store/config')).status).toBe(401);
    });

    it('refuses an unknown credential', async () => {
      expect((await fetch('optionia_store_notacredential')).status).toBe(401);
    });

    /**
     * A merchant's JWT is the wrong realm here.
     *
     * `check-isolation` exempts `@StoreRoute()` routes from its cross-tenant
     * probe — correctly, since a store credential names its own store and there
     * is nothing in the path for a caller to ask for. But the exemption is
     * written on the assumption that each store route proves its own realm
     * separately, and this one inherited the exemption without the proof.
     *
     * 401 rather than 403: a token from another realm is not a permission
     * problem, and saying "forbidden" would tell a caller their credential was
     * the right kind.
     */
    it('refuses a merchant JWT', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/store/config')
        .set('Authorization', `Bearer ${merchantToken}`);

      expect(response.status).toBe(401);
    });

    /**
     * One store's credential never reaches another store's document.
     *
     * The store id comes from the credential, never from the request, so this
     * is structural — and asserted anyway, because it is the guarantee the
     * whole store realm rests on.
     */
    it('serves only the store its credential names', async () => {
      const first = await connected(7);
      const second = await connected(3);

      const response = await fetch(second.token);

      expect(response.body.data.store_id).toBe(second.id);
      expect(response.body.data.store_id).not.toBe(first.id);
      expect(response.body.data.config_version).toBe(3);
    });
  });
});
