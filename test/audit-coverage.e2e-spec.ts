import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { createHarness, idOf, tokenFrom, type Harness } from './harness';
import { AuditAction } from '../src/audit/audit.service';

/**
 * Audit coverage (M7.6, step 7l).
 *
 * *"Every option-set mutation recorded with actor, diff, IP."* The word that
 * decides this step is **every** — a trail with a hole is worse than none,
 * because it is trusted.
 *
 * So this drives each mutating route through HTTP and asserts a row appeared,
 * rather than checking that services call `record()`. A spy on the service
 * cannot tell a successful write from one that threw and was swallowed, which
 * `AuditService` does by design.
 */
describe('audit coverage (e2e)', () => {
  let harness: Harness;
  let app: INestApplication;
  let dataSource: DataSource;

  const NS = 'aud7l';
  const PASSWORD = 'a-sufficiently-long-password';

  let token = '';
  let tenantId = '';
  let storeId = '';

  /** A second workspace, provisioned once, with a trail of its own. */
  let otherTenantToken = '';
  let otherStoreId = '';

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

    otherTenantToken = await harness.tenant('other');
    otherStoreId = await harness.store('other');

    // Give them something to record, so a leak would have material to leak.
    await request(harness.app.getHttpServer())
      .post('/v1/option-sets')
      .set('Authorization', `Bearer ${otherTenantToken}`)
      .send({ name: 'Theirs', storeId: otherStoreId });
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
  const patch = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(`/v1${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const del = (path: string) =>
    request(app.getHttpServer()).delete(`/v1${path}`).set('Authorization', `Bearer ${token}`);


  /** Actions recorded for one resource. */
  async function actionsFor(resourceId: string): Promise<string[]> {
    const rows = await dataSource.query(
      `SELECT action FROM audit_logs WHERE resourceId = ? ORDER BY createdAt`,
      [resourceId],
    );

    return rows.map((row: { action: string }) => row.action);
  }

  /** Every audit row this tenant has, with the fields M7.6 names. */
  async function allRows(): Promise<
    Array<{ action: string; userId: string | null; ip: Buffer | null; changes: unknown }>
  > {
    return dataSource.query(
      `SELECT action, userId, ip, changes FROM audit_logs WHERE tenantId = ?`,
      [tenantId],
    );
  }

  /**
   * Drives every mutating route once. Returned ids let each assertion name the
   * resource it expects a row for.
   */
  async function exerciseEveryMutation(): Promise<Record<string, string>> {
    const set = idOf(await post('/option-sets', { name: 'Audited', storeId }), 'set');
    await patch(`/option-sets/${set}`, { name: 'Audited II' });

    const group = idOf(await post(`/option-sets/${set}/groups`, { label: 'G' }), 'group');
    await patch(`/groups/${group}`, { label: 'G2' });

    const option = idOf(
      await post(`/groups/${group}/options`, {
        key: 'audited',
        label: 'Audited',
        presentation: 'radio',
      }),
      'option',
    );
    await patch(`/options/${option}`, { label: 'Audited II' });

    const value = idOf(
      await post(`/options/${option}/values`, { valueKey: 'v', label: 'V' }),
      'value',
    );
    await patch(`/values/${value}`, { label: 'V2' });

    /*
     * Presentational items, which have their own four audit actions.
     *
     * Added when this gate caught them declared-but-unreachable: the routes and
     * the service shipped, `AuditAction` gained four names, and nothing in this
     * suite drove them -- so four actions could be written by production code
     * and never once observed being written. That is exactly the state the
     * `unaccounted` assertion exists to refuse, and it refused it.
     */
    const item = idOf(
      await post(`/groups/${group}/items`, { kind: 'heading', content: 'Audited heading' }),
      'presentational item',
    );
    await patch(`/items/${item}`, { content: 'Audited heading II' });
    await post(`/groups/${group}/items/reorder`, { items: [{ id: item, sortOrder: 20 }] });
    await del(`/items/${item}`);

    /*
     * Conditional rules, with their own four audit actions (M17.1).
     *
     * Driven here in the same change that declared the actions, because this
     * gate refuses both directions: an action nothing drives is
     * declared-but-unreachable, and a mutation writing no row is a hole in a
     * trail that is trusted. Rules matter more than most — `set_price` replaces
     * a value's delta and `hide` removes an option from the line entirely, so
     * "why did this order cost that" is answerable only if the logic's history
     * is.
     */
    const rule = idOf(
      await post(`/option-sets/${set}/rules`, {
        targetType: 'option',
        targetId: option,
        /* Any real action; `show` was withdrawn by ADR-056. */
        action: 'hide',
        matchType: 'all',
        conditions: [{ optionId: option, operator: 'equals', value: 'v' }],
      }),
      'rule',
    );
    /*
     * ⚠️ **Must differ from what the rule was created with**, or the patch is a
     * no-op and the audit row carries an empty diff — which
     * `records a diff on every row` then fails on.
     *
     * Measured: creating and patching both as `hide` left that assertion with
     * zero changed keys. The fixture creates `hide` (ADR-056 withdrew `show`),
     * so the update has to move it somewhere else.
     */
    await patch(`/rules/${rule}`, { action: 'require' });
    await post(`/option-sets/${set}/rules/reorder`, { rules: [{ id: rule, sortOrder: 20 }] });
    await del(`/rules/${rule}`);

    const groupCopy = idOf(await post(`/groups/${group}/duplicate`), 'group copy');
    const optionCopy = idOf(await post(`/options/${option}/duplicate`), 'option copy');
    const setCopy = idOf(await post(`/option-sets/${set}/duplicate`), 'set copy');

    await post(`/option-sets/${set}/reorder`, { groups: [{ id: group, sortOrder: 20 }] });
    await post(`/groups/${group}/reorder`, { options: [{ id: option, sortOrder: 20 }] });
    await post(`/options/${option}/reorder`, { values: [{ id: value, sortOrder: 20 }] });

    const valueCopy = idOf(await post(`/values/${value}/duplicate`), 'value copy');

    const published = await post(`/option-sets/${set}/publish`, {});

    if (published.status !== 201) {
      throw new Error(`Fixture failed to publish: ${JSON.stringify(published.body)}`);
    }

    await post(`/option-sets/${set}/rollback`, { version: 1 });

    // Deletes last: they take their children with them.
    await del(`/values/${value}`);
    await del(`/options/${option}`);
    await del(`/groups/${group}`);
    await del(`/option-sets/${setCopy}`);
    await del(`/option-sets/${setCopy}/permanent`);

    return { set, group, option, value, rule, groupCopy, optionCopy, setCopy, valueCopy };
  }

  describe('every mutation is recorded', () => {
    let ids: Record<string, string>;

    beforeAll(async () => {
      ids = await exerciseEveryMutation();
    }, 240_000);

    it('records the option-set lifecycle', async () => {
      expect(await actionsFor(ids.set)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_SET_CREATED,
          AuditAction.OPTION_SET_UPDATED,
          AuditAction.OPTION_SET_REORDERED,
          AuditAction.OPTION_SET_PUBLISHED,
          AuditAction.OPTION_SET_ROLLED_BACK,
        ]),
      );
    }, 60_000);

    it('records a duplicate, a delete and a purge', async () => {
      expect(await actionsFor(ids.setCopy)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_SET_DUPLICATED,
          AuditAction.OPTION_SET_DELETED,
          AuditAction.OPTION_SET_PURGED,
        ]),
      );
    }, 60_000);

    it('records the group lifecycle', async () => {
      expect(await actionsFor(ids.group)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_GROUP_CREATED,
          AuditAction.OPTION_GROUP_UPDATED,
          AuditAction.OPTION_GROUP_DELETED,
        ]),
      );
      expect(await actionsFor(ids.groupCopy)).toContain(AuditAction.OPTION_GROUP_DUPLICATED);
    }, 60_000);

    it('records the option lifecycle', async () => {
      expect(await actionsFor(ids.option)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_CREATED,
          AuditAction.OPTION_UPDATED,
          AuditAction.OPTION_DELETED,
        ]),
      );
      expect(await actionsFor(ids.optionCopy)).toContain(AuditAction.OPTION_DUPLICATED);
    }, 60_000);

    it('records the value lifecycle', async () => {
      expect(await actionsFor(ids.value)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_VALUE_CREATED,
          AuditAction.OPTION_VALUE_UPDATED,
          AuditAction.OPTION_VALUE_DELETED,
        ]),
      );
    }, 60_000);

    /**
     * Conditional rules (M17.1).
     *
     * 🔴 **A rule decides whether a customer is charged**, so its trail carries
     * more weight than most: `set_price` replaces a value's delta (ADR-049), and
     * `hide` removes an option from the line entirely (ADR-051). Asserted by
     * resource id rather than only through the `unaccounted` sweep below, so a
     * failure names *which* of the four went unrecorded.
     */
    it('records the rule lifecycle', async () => {
      expect(await actionsFor(ids.rule)).toEqual(
        expect.arrayContaining([
          AuditAction.OPTION_RULE_CREATED,
          AuditAction.OPTION_RULE_UPDATED,
          AuditAction.OPTION_RULE_DELETED,
        ]),
      );

      /* Reorder is recorded against the SET, as every reorder in this API is. */
      expect(await actionsFor(ids.set)).toContain(AuditAction.OPTION_RULE_REORDERED);
    }, 60_000);

    /**
     * The check that makes this a coverage test rather than a list.
     *
     * Every action the codebase defines must be produced by driving routes, or
     * be listed below as covered elsewhere with a reason. An action defined and
     * never reachable is a hole in the trail nobody notices, because the
     * constant looks like proof it works.
     *
     * **This originally filtered to `^option[_.]` and so could not see the
     * `member.*` actions at all** — which is how `member.joined` came to be
     * defined and recorded nowhere while this test passed. It now covers every
     * action, and anything not exercised here must be named.
     */
    it('leaves no audit action defined but unreachable', async () => {
      const produced = new Set((await allRows()).map((row) => row.action));

      /**
       * Covered by another suite, each for a stated reason. A name may only
       * appear here if driving it from this suite is genuinely impossible.
       */
      const coveredElsewhere: Record<string, string> = {
        /*
         * Needs a whole exported document to rebuild from — the import suite
         * has one, and building a second here would be a second definition of
         * what an exported set looks like.
         */
        [AuditAction.OPTION_SET_IMPORTED]: 'option-sets-http.e2e-spec',
        // Needs a rule targeting the value; the cascade suite creates one.
        [AuditAction.OPTION_VALUE_DELETE_REFUSED]: 'cascade.e2e-spec',
        // Team lifecycle: a second user, an invitation and its acceptance.
        [AuditAction.MEMBER_INVITED]: 'team.e2e-spec',
        [AuditAction.MEMBER_JOINED]: 'team.e2e-spec',
        [AuditAction.MEMBER_ROLE_CHANGED]: 'team.e2e-spec',
        [AuditAction.MEMBER_REMOVED]: 'team.e2e-spec',
        // Needs a full handshake: initiate, then a merchant's approval.
        [AuditAction.STORE_CONNECT_AUTHORIZED]: 'connect-handshake.e2e-spec',
        [AuditAction.STORE_RECONNECT_AUTHORIZED]: 'connect-handshake.e2e-spec',
        // Needs the whole handshake plus a PKCE redemption.
        [AuditAction.STORE_CONNECTED]: 'connect-handshake.e2e-spec',
        // Needs a connected store with a live credential to replace.
        [AuditAction.STORE_DISCONNECTED]: 'store-ownership.e2e-spec',
        [AuditAction.STORE_CREDENTIAL_ROTATED]: 'store-ownership.e2e-spec',
        // Needs a store credential and a plugin reporting a state we disagree with.
        [AuditAction.STORE_STATE_MISMATCH]: 'store-heartbeat.e2e-spec',
        // Needs a plugin reporting that it refused a document it could not read.
        [AuditAction.STORE_SCHEMA_UNSUPPORTED]: 'store-heartbeat.e2e-spec',

        /*
         * Authentication, added 2026-09-03. Driven from `auth-audit.e2e-spec`
         * rather than here: this suite signs in **once** in `beforeAll` and
         * spends the rest of its life holding a token, so it cannot exercise a
         * failed sign-in, a sign-out, or a password reset without destroying the
         * session every other test depends on.
         *
         * That suite asserts the absences too — a duplicate registration, a
         * failed login's missing reason, an unknown logout token — which is half
         * of what these actions are for.
         */
        [AuditAction.USER_REGISTERED]: 'auth-audit.e2e-spec',
        [AuditAction.USER_EMAIL_VERIFIED]: 'auth-audit.e2e-spec',
        [AuditAction.USER_LOGGED_IN]: 'auth-audit.e2e-spec',
        [AuditAction.USER_LOGIN_FAILED]: 'auth-audit.e2e-spec',
        [AuditAction.USER_LOGGED_OUT]: 'auth-audit.e2e-spec',
        [AuditAction.USER_PASSWORD_RESET_REQUESTED]: 'auth-audit.e2e-spec',
        [AuditAction.USER_PASSWORD_RESET]: 'auth-audit.e2e-spec',
      };

      /**
       * Declared with the state machine, produced by a step not yet built.
       *
       * `[8f]` declares every state's audit action alongside M8.1b's transition
       * table rather than letting each later step invent its own — that is what
       * makes a missing entry a compile error instead of an oversight. The cost
       * is a window where an action exists and no route reaches it.
       *
       * **This list is not `coveredElsewhere`.** That one claims another suite
       * exercises the action; this one admits nothing does, and names the step
       * that will. `records every action claimed as covered elsewhere` verifies
       * the first list honestly, and the assertion below does the same for this
       * one: a name may sit here only while its owning step is unbuilt, and the
       * check fails once that step ships.
       */
      const awaitingItsStep: Record<string, string> = {
        /**
         * `[8i]`, not `[8g]`.
         *
         * `[8f]` mapped this to `[8g]` on the assumption that disconnecting
         * revokes — but `disconnect` moves a store to `DISCONNECTED`, and
         * `rotate` does not transition at all. The state diagram labels this
         * edge "cloud revokes", and M8.1b names its trigger: a `site_url`
         * change requiring re-authorisation, which is `[8i]`.
         *
         * The expiry check below would have caught the wrong mapping the moment
         * `[8g]` shipped, which is what it is for.
         */
        /**
         * Not `[8i]` either.
         *
         * `[8h]` re-pointed this here on the assumption that a site-URL mismatch
         * revokes. It does not: `X-Optionia-Site` is a plain header, so revoking
         * on a mismatch would let a stolen credential disconnect the merchant's
         * live store, and would kill a legitimate domain migration outright.
         * `[8i]` refuses the request and records `store.site_mismatch`; the
         * store keeps working.
         *
         * That leaves `REVOKED` as an act a human performs — an operator acting
         * on the evidence — which is Phase 26's surface. Third time this action
         * has moved, which is the argument for assigning an action when its
         * *producer* is designed rather than when the action is declared.
         */
        [AuditAction.STORE_REVOKED]: 'phase 26',
        /**
         * Phase 9, not `[8h]`.
         *
         * `[8f]` assumed the heartbeat would set `ERROR`. It cannot: the
         * contract forbids writing `stores.status` from the plugin's claim, and
         * a heartbeat is the plugin *succeeding* at reaching the cloud. The
         * `CONNECTED → ERROR` edge belongs to config sync.
         *
         * `phase 9` rather than a step letter — the expiry check below matches
         * whatever marker the contract still carries, and Phase 9 has no step
         * markers yet.
         */
        [AuditAction.STORE_ERRORED]: 'phase 9',
        // Produced by the site-URL guard, built in this step.
        [AuditAction.STORE_SITE_MISMATCH]: '8i',
      };

      const unaccounted = Object.values(AuditAction).filter(
        (action) =>
          !produced.has(action) &&
          !(action in coveredElsewhere) &&
          !(action in awaitingItsStep),
      );

      expect(unaccounted).toEqual([]);

      /**
       * The exemption expires on its own.
       *
       * Once the owning step marks its routes `[built]` in the contract, the
       * action must be produced rather than excused — otherwise this list is a
       * way to silence the gate permanently.
       */
      const contract = readFileSync('docs/API-CONTRACT.md', 'utf8');

      Object.entries(awaitingItsStep).forEach(([action, step]) => {
        if (!contract.includes(`[${step}]`)) {
          throw new Error(
            `${action} is excused pending [${step}], but no [${step}] marker remains in ` +
              `the contract — that step has shipped, so the action must now be exercised.`,
          );
        }
      });
    }, 60_000);

    /**
     * The other half of the same guarantee: every name claimed as "covered
     * elsewhere" must actually be recorded by something.
     *
     * Without this, moving an action into that list is a way to silence the
     * check above rather than satisfy it.
     */
    it('records every action claimed as covered elsewhere', async () => {
      const claimed = [
        AuditAction.OPTION_VALUE_DELETE_REFUSED,
        AuditAction.MEMBER_INVITED,
        AuditAction.MEMBER_JOINED,
        AuditAction.MEMBER_ROLE_CHANGED,
        AuditAction.MEMBER_REMOVED,
        AuditAction.STORE_SCHEMA_UNSUPPORTED,
        AuditAction.STORE_CONNECT_AUTHORIZED,
        AuditAction.STORE_RECONNECT_AUTHORIZED,
        AuditAction.STORE_CONNECTED,
        AuditAction.STORE_DISCONNECTED,
        AuditAction.STORE_CREDENTIAL_ROTATED,
        AuditAction.STORE_STATE_MISMATCH,
      ];

      const source = readFileSync('src/tenants/team.service.ts', 'utf8');
      const values = readFileSync('src/option-sets/option-values.service.ts', 'utf8');
      const connect = readFileSync('src/stores/connect.service.ts', 'utf8');
      const stores = readFileSync('src/stores/stores.service.ts', 'utf8');
      const both = source + values + connect + stores;

      claimed.forEach((action) => {
        const constant = Object.entries(AuditAction).find(([, value]) => value === action)?.[0];

        expect(both).toContain(`AuditAction.${constant}`);
      });
    }, 60_000);
  });

  /**
   * Reading it back.
   *
   * The trail was write-only: `AUDIT_LOG_VIEW` was granted to owner and admin
   * and no route consumed it, so the data a merchant is told is kept for their
   * protection could not be shown to them.
   */
  describe('reading the trail', () => {
    const get = (path: string, auth = token) =>
      request(app.getHttpServer()).get(`/v1${path}`).set('Authorization', `Bearer ${auth}`);

    beforeAll(async () => {
      await exerciseEveryMutation();
    }, 240_000);

    it('returns entries newest first', async () => {
      const response = await get('/audit-logs');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);

      const ids = response.body.data.map((entry: { id: string }) => Number(entry.id));
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
    }, 60_000);

    /** A `VARBINARY` read straight out of MySQL is unreadable. */
    it('returns the IP readable, not as packed bytes', async () => {
      const [entry] = (await get('/audit-logs')).body.data;

      expect(entry.ip).toMatch(/^[\d.]+$|^[\da-f:]+$/);
      expect(entry.userId).not.toBeNull();
      expect(entry.changes).not.toBeNull();
    }, 60_000);

    it('filters by action', async () => {
      const response = await get(`/audit-logs?action=${AuditAction.OPTION_SET_PUBLISHED}`);

      expect(response.body.data.length).toBeGreaterThan(0);
      response.body.data.forEach((entry: { action: string }) =>
        expect(entry.action).toBe(AuditAction.OPTION_SET_PUBLISHED),
      );
    }, 60_000);

    it('filters by resource', async () => {
      const set = idOf(await post('/option-sets', { name: 'Filtered', storeId }), 'set');

      const response = await get(`/audit-logs?resourceId=${set}`);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].action).toBe(AuditAction.OPTION_SET_CREATED);
    }, 60_000);

    it('pages without repeating or skipping a row', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const response = await get(`/audit-logs?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
        response.body.data.forEach((entry: { id: string }) => seen.push(entry.id));
        cursor = response.body.meta.pagination.cursor as string | null;
        pages += 1;
      } while (cursor && pages < 20);

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeGreaterThan(5);
    }, 120_000);

    /** Same reasoning as every other cursor: silent restart is an infinite loop. */
    it.each([['garbage', '@@@'], ['a non-numeric id', Buffer.from('abc').toString('base64url')]])(
      'refuses %s as a cursor',
      async (_label, cursor) => {
        const response = await get(`/audit-logs?cursor=${encodeURIComponent(cursor)}`);

        expect(response.status).toBe(400);
        expect(response.body.error.details).toEqual([
          { field: 'cursor', code: 'INVALID_CURSOR' },
        ]);
      },
      60_000,
    );

    /**
     * Who did what, from which address, is an ownership question — and the
     * trail carries personal data.
     */
    it('refuses an editor and a viewer', async () => {
      for (const role of ['editor', 'viewer']) {
        const email = `${NS}-${role}@example.com`;

        await request(app.getHttpServer())
          .post('/v1/auth/register')
          .send({ email, password: PASSWORD, name: role, tenantName: `${NS}-${role}` });
        await dataSource.query(`UPDATE users SET emailVerifiedAt = NOW(3) WHERE email = ?`, [
          email,
        ]);
        await dataSource.query(
          `UPDATE tenants t JOIN tenant_members tm ON tm.tenantId = t.id
             JOIN users u ON u.id = tm.userId SET t.slug = ? WHERE u.email = ?`,
          [`${NS}-${role}`, email],
        );
        await dataSource.query(
          `UPDATE tenant_members tm JOIN users u ON u.id = tm.userId
              SET tm.tenantId = ?, tm.role = ? WHERE u.email = ?`,
          [tenantId, role, email],
        );

        const theirToken = tokenFrom(
          await request(app.getHttpServer())
            .post('/v1/auth/login')
            .send({ email, password: PASSWORD }),
          email,
        );

        const response = await get('/audit-logs', theirToken);

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('INSUFFICIENT_ROLE');
      }
    }, 180_000);

    it('refuses an unauthenticated request', async () => {
      expect((await request(app.getHttpServer()).get('/v1/audit-logs')).status).toBe(401);
    }, 60_000);

    /**
     * A trail that leaked across tenants would be worse than none, because it
     * is trusted.
     *
     * Asserted against a **second tenant that actually has entries**. Checking
     * only that this tenant's rows come back cannot fail when no other tenant
     * has any — removing the scoping predicate passed that version of this
     * test, which is exactly the shape of hole this codebase keeps finding.
     */
    it('never shows another tenant’s entries', async () => {
      /**
       * The second workspace is provisioned in `beforeAll`, not here.
       *
       * Registering mid-test runs the auth stack while other suites' fixtures
       * are in flight, and this test failed intermittently for exactly that
       * reason — the same shape found in the config-document suite. Fixtures
       * belong in setup.
       */
      const otherToken = otherTenantToken;
      const otherTenant = { id: await harness.tenantIdOf('other') };

      const [theirRows] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE tenantId = ?`,
        [otherTenant.id],
      );
      expect(Number(theirRows.n)).toBeGreaterThan(0);

      // Now read as the first tenant: none of theirs may appear.
      const mine = await get('/audit-logs?limit=100');
      const ids = mine.body.data.map((entry: { id: string }) => entry.id);

      const [leaked] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE id IN (?) AND tenantId <> ?`,
        [ids.length > 0 ? ids : ['0'], tenantId],
      );

      expect(Number(leaked.n)).toBe(0);

      // And the reverse: they see theirs, not ours.
      const theirs = await get('/audit-logs?limit=100', otherToken);
      expect(theirs.body.data.length).toBe(Number(theirRows.n));
    }, 180_000);
  });

  describe('actor, diff and IP — the three M7.6 names', () => {
    beforeAll(async () => {
      await exerciseEveryMutation();
    }, 240_000);

    it('stamps an actor on every row', async () => {
      const rows = await allRows();

      expect(rows.length).toBeGreaterThan(15);
      rows.forEach((row) => expect(row.userId).not.toBeNull());
    }, 60_000);

    it('stamps an IP on every row, packed to 16 bytes', async () => {
      const rows = await allRows();

      rows.forEach((row) => {
        expect(row.ip).not.toBeNull();
        expect(row.ip).toHaveLength(16);
      });
    }, 60_000);

    it('records a diff on every row', async () => {
      const rows = await allRows();

      rows.forEach((row) => {
        expect(row.changes).not.toBeNull();
        expect(Object.keys(row.changes as object).length).toBeGreaterThan(0);
      });
    }, 60_000);
  });
});
