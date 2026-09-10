import { Controller, Get, INestApplication, Module, UseGuards } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

import { AuditModule } from '../src/audit/audit.module';
import { AuthModule } from '../src/auth/auth.module';
import { SiteMatchGuard } from '../src/auth/guards/site-match.guard';
import { StoreRoute } from '../src/auth/guards/store-route.decorator';
import { StoreStatus } from '../src/common/database/enums';
import { generateStoreToken } from '../src/common/crypto/tokens';

import { bootstrapTestApp, createHarness, type Harness } from './harness';

/**
 * The store heartbeat (M8.5, `[8h]`).
 *
 * The store realm's first route, and the endpoint support depends on: it reveals
 * stale installs and dead connections before a merchant reports them.
 */
/**
 * `SiteMatchGuard` applied **without** `StoreTokenGuard` — the misordering the
 * guard's own precondition exists to defend against.
 *
 * Unreachable on the heartbeat, where the two are declared together in order. It
 * becomes reachable the moment a future route applies this guard alone, which is
 * exactly when a silent admit would matter: the guard would be reading a context
 * nothing had populated.
 *
 * Verified by mutation — making that branch `return true` broke no test until
 * this probe existed.
 */
@Controller('store/orphan-site-probe')
@StoreRoute()
@UseGuards(SiteMatchGuard)
class OrphanSiteProbeController {
  @Get()
  reached(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ imports: [AuthModule, AuditModule], controllers: [OrphanSiteProbeController] })
class OrphanSiteProbeModule {}

describe('store heartbeat (e2e)', () => {
  let app: INestApplication;
  let harness: Harness;
  let dataSource: DataSource;
  let tenantId = '';

  beforeAll(async () => {
    app = await bootstrapTestApp([OrphanSiteProbeModule]);
    harness = await createHarness('hb8h');
    dataSource = app.get(DataSource);

    await harness.cleanup();
    await harness.tenant('a');
    tenantId = await harness.tenantIdOf('a');
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
    await harness?.close();
    await app?.close();
  });

  /** A connected store with a live credential — a plugin that can ping. */
  async function connected(
    status: StoreStatus = StoreStatus.CONNECTED,
    configVersion = 0,
  ): Promise<{ id: string; token: string }> {
    const id = await harness.store('a');
    const credential = generateStoreToken();

    await dataSource.query(`UPDATE stores SET status = ?, configVersion = ? WHERE id = ?`, [
      status,
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

  const ping = (token: string, body: object = {}, site?: string): request.Test => {
    const call = request(app.getHttpServer())
      .post('/v1/store/heartbeat')
      .set('Authorization', `Bearer ${token}`);

    return (site ? call.set('X-Optionia-Site', site) : call).send(body);
  };

  /** The URL the harness connected a store at. */
  const urlOf = async (storeId: string): Promise<string> => {
    const [row] = await dataSource.query(`SELECT storeUrl FROM stores WHERE id = ?`, [storeId]);

    return row.storeUrl as string;
  };

  const siteMismatches = async (storeId: string): Promise<number> => {
    const [row] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE resourceId = ? AND action = 'store.site_mismatch'`,
      [storeId],
    );

    return Number(row.n);
  };

  const storeRow = async (id: string): Promise<Record<string, unknown>> => {
    const [row] = await dataSource.query(`SELECT * FROM stores WHERE id = ?`, [id]);

    return row;
  };

  const mismatches = async (storeId: string): Promise<number> => {
    const [row] = await dataSource.query(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE resourceId = ? AND action = 'store.state_mismatch'`,
      [storeId],
    );

    return Number(row.n);
  };

  describe('telemetry', () => {
    /**
     * The persisted row, not the response.
     *
     * The response is entirely derived values, so asserting it proves the
     * handler returns what it was given. `stores` is where the endpoint's only
     * real effect lands.
     */
    it('records what the install is running', async () => {
      const store = await connected();

      const response = await ping(store.token, {
        plugin_version: '1.2.3',
        wp_version: '6.5.2',
        wc_version: '8.7.0',
        php_version: '8.2.15',
        connection_state: StoreStatus.CONNECTED,
        config_version: 0,
        cache_age_seconds: 3600,
      });

      expect(response.status).toBe(200);

      const row = await storeRow(store.id);

      expect(row.pluginVersion).toBe('1.2.3');
      expect(row.wpVersion).toBe('6.5.2');
      expect(row.wcVersion).toBe('8.7.0');
      expect(row.phpVersion).toBe('8.2.15');
    });

    /** The column is indexed precisely so stale installs are visible. */
    it('stamps lastSeenAt on every ping', async () => {
      const store = await connected();

      expect((await storeRow(store.id)).lastSeenAt).toBeNull();

      await ping(store.token, { connection_state: StoreStatus.CONNECTED });

      expect((await storeRow(store.id)).lastSeenAt).not.toBeNull();
    });

    /**
     * A ping that omits a field must not erase what was already known — a
     * plugin that cannot read `WC_VERSION` should not blank the last value
     * support saw.
     */
    it('leaves a known version untouched when a ping omits it', async () => {
      const store = await connected();

      await ping(store.token, { wc_version: '8.7.0' });
      await ping(store.token, { plugin_version: '1.2.3' });

      const row = await storeRow(store.id);

      expect(row.wcVersion).toBe('8.7.0');
      expect(row.pluginVersion).toBe('1.2.3');
    });

    it('accepts an empty body', async () => {
      const store = await connected();

      expect((await ping(store.token)).status).toBe(200);
      expect((await storeRow(store.id)).lastSeenAt).not.toBeNull();
    });
  });

  describe('the response', () => {
    it('answers the cloud’s config version, so a plugin learns it is behind', async () => {
      const store = await connected(StoreStatus.CONNECTED, 43);
      const response = await ping(store.token, { config_version: 42 });

      expect(response.body.data.config_version).toBe(43);
    });

    /**
     * `configVersion` is a `BIGINT`, read here through a raw query.
     *
     * `bigintTransformer` throws rather than truncating a value JavaScript
     * cannot represent, and a raw query bypasses it — so the same check is
     * applied at this boundary. Unreachable in practice (one increment per
     * publish, ~9 quadrillion to overflow), and asserted anyway because the
     * guard exists precisely so the failure is loud rather than silent.
     *
     * Verified by mutation: removing the check broke no test until this one.
     */
    it('refuses a config version it cannot represent exactly', async () => {
      const store = await connected();

      // 2^53 + 1 — the smallest integer a double rounds away.
      await dataSource.query(`UPDATE stores SET configVersion = ? WHERE id = ?`, [
        '9007199254740993',
        store.id,
      ]);

      const response = await ping(store.token);

      // A 500, not a wrong number quietly returned to a plugin that trusts it.
      expect(response.status).toBe(500);
    });

    /** The cloud's view, never the plugin's echoed back. */
    it('answers the cloud’s status, not the plugin’s claim', async () => {
      const store = await connected(StoreStatus.ERROR);
      const response = await ping(store.token, { connection_state: StoreStatus.CONNECTED });

      expect(response.body.data.status).toBe(StoreStatus.ERROR);
    });
  });

  /**
   * M8.1b: the two views can disagree, and guessing which is right is the
   * largest source of support tickets in this category of product.
   */
  describe('reconciliation', () => {
    it('records a mismatch, carrying both views', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.ERROR });

      const [row] = await dataSource.query(
        `SELECT changes, tenantId FROM audit_logs
          WHERE resourceId = ? AND action = 'store.state_mismatch' LIMIT 1`,
        [store.id],
      );

      expect(row).toBeDefined();
      expect(row.tenantId).toBe(tenantId);

      const changes = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;

      expect(changes.pluginState).toBe(StoreStatus.ERROR);
      expect(changes.cloudState).toBe(StoreStatus.CONNECTED);
    });

    /**
     * **The cloud never adopts the plugin's claim.** A cloned staging site
     * reports on a production store it is impersonating; believing it would let
     * a clone degrade the original.
     */
    it('never writes the plugin’s claim to stores.status', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.DISCONNECTED });

      expect((await storeRow(store.id)).status).toBe(StoreStatus.CONNECTED);
    });

    /**
     * The amplification guard.
     *
     * A store that cannot be reconciled disagrees on **every** heartbeat: daily
     * that is 365 entries a year, and against the 60-per-hour limit a
     * misbehaving plugin writes 1,440 a day for one store — into a table with no
     * retention sweep. An unchanged disagreement is a repetition, not news.
     */
    it('records a repeated, unchanged mismatch only once', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      for (let ping_ = 0; ping_ < 5; ping_ += 1) {
        await ping(store.token, { connection_state: StoreStatus.ERROR });
      }

      expect(await mismatches(store.id)).toBe(1);
    });

    /** A *changed* disagreement is news, and is recorded. */
    it('records again when the plugin’s claim changes', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.ERROR });
      await ping(store.token, { connection_state: StoreStatus.ERROR });
      await ping(store.token, { connection_state: StoreStatus.DISCONNECTED });

      expect(await mismatches(store.id)).toBe(2);
    });

    /** And when the *cloud's* view moves while the plugin's claim holds. */
    it('records again when the cloud’s view changes', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.ERROR });

      await dataSource.query(`UPDATE stores SET status = ? WHERE id = ?`, [
        StoreStatus.REVOKED,
        store.id,
      ]);

      await ping(store.token, { connection_state: StoreStatus.ERROR });

      expect(await mismatches(store.id)).toBe(2);
    });

    /**
     * A rotated credential is not drift.
     *
     * `stores.status` never reaches `REVOKED` in Phase 8 — that is an operator
     * act on Phase 26's surface, and `audit-coverage.e2e-spec` enforces the
     * deferral. The plugin reaches `REVOKED` on its own the moment a request
     * is refused, which is precisely what rotating a credential causes.
     *
     * Both sides are then right: the cloud holds a live replacement, and the
     * plugin correctly knows the credential it has is dead. Reporting that
     * would raise a Phase 26 operations item on a routine merchant action —
     * and one nothing could ever clear, because the cloud cannot enter
     * `REVOKED` to agree with it.
     */
    it('records nothing when a plugin reports revoked against a live store', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.REVOKED });

      expect(await mismatches(store.id)).toBe(0);
    });

    /** The same holds from `ERROR`, which also carries a live credential. */
    it('records nothing when a plugin reports revoked against an erroring store', async () => {
      const store = await connected(StoreStatus.ERROR);

      await ping(store.token, { connection_state: StoreStatus.REVOKED });

      expect(await mismatches(store.id)).toBe(0);
    });

    /**
     * The exemption is one-directional, and narrow.
     *
     * A plugin claiming `REVOKED` against a store the cloud has already
     * disconnected *is* a disagreement worth an operator's attention: the two
     * sides reached different conclusions about a finished connection.
     */
    it('still records revoked against a disconnected store', async () => {
      const store = await connected(StoreStatus.DISCONNECTED);

      await ping(store.token, { connection_state: StoreStatus.REVOKED });

      expect(await mismatches(store.id)).toBe(1);
    });

    /**
     * A plugin too old to read what this cloud is sending (M9.5).
     *
     * The refusal happens in the plugin and is correct — it keeps the previous
     * copy rather than losing the merchant's options — which is exactly what
     * makes it invisible here: the heartbeat arrives on time, the state says
     * connected, the credential works. This entry is the only thing that says
     * "this merchant needs to update their plugin".
     */
    it('records a store that refused a document it could not read', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, {
        connection_state: StoreStatus.CONNECTED,
        supported_schema_version: 1,
        schema_refused: true,
        plugin_version: '0.9.0',
      });

      const [row] = await dataSource.query(
        `SELECT changes FROM audit_logs
          WHERE resourceId = ? AND action = 'store.schema_unsupported' LIMIT 1`,
        [store.id],
      );

      expect(row).toBeDefined();

      const changes = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;

      expect(changes.supportedSchemaVersion).toBe(1);
      expect(changes.pluginVersion).toBe('0.9.0');
    });

    /**
     * A healthy store records nothing.
     *
     * `supported_schema_version` on its own is a capability, true of every
     * store on that build. Recording it would make every heartbeat an
     * operations item.
     */
    it('records nothing when the plugin refused nothing', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, {
        connection_state: StoreStatus.CONNECTED,
        supported_schema_version: 1,
        schema_refused: false,
      });

      const rows = await dataSource.query(
        `SELECT id FROM audit_logs WHERE resourceId = ? AND action = 'store.schema_unsupported'`,
        [store.id],
      );

      expect(rows).toHaveLength(0);
    });

    /**
     * Reported on every heartbeat, recorded once.
     *
     * A store in this state says so daily until the merchant updates, and a
     * trail repeating it is one support reads and misbelieves.
     */
    it('records a persisting refusal only once', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      const body = {
        connection_state: StoreStatus.CONNECTED,
        supported_schema_version: 1,
        schema_refused: true,
        plugin_version: '0.9.0',
      };

      await ping(store.token, body);
      await ping(store.token, body);
      await ping(store.token, body);

      const rows = await dataSource.query(
        `SELECT id FROM audit_logs WHERE resourceId = ? AND action = 'store.schema_unsupported'`,
        [store.id],
      );

      expect(rows).toHaveLength(1);
    });

    /**
     * A partial upgrade is a new fact, and gets a new entry.
     *
     * A merchant on 0.9.0 who updates to 0.9.5 and is *still* too old has
     * changed something support needs to see — they acted, and it was not
     * enough. Deduplicating on the store or its URL would swallow that:
     * the entry would stay pinned to the version they were running months ago.
     */
    it('records again when the plugin moves but is still too old', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      const refusing = (pluginVersion: string): object => ({
        connection_state: StoreStatus.CONNECTED,
        supported_schema_version: 1,
        schema_refused: true,
        plugin_version: pluginVersion,
      });

      await ping(store.token, refusing('0.9.0'));
      await ping(store.token, refusing('0.9.0'));
      await ping(store.token, refusing('0.9.5'));

      const rows = await dataSource.query(
        `SELECT changes FROM audit_logs
          WHERE resourceId = ? AND action = 'store.schema_unsupported' ORDER BY id`,
        [store.id],
      );

      expect(rows).toHaveLength(2);

      const latest =
        typeof rows[1].changes === 'string' ? JSON.parse(rows[1].changes) : rows[1].changes;

      expect(latest.pluginVersion).toBe('0.9.5');
    });

    it('records nothing when the views agree', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { connection_state: StoreStatus.CONNECTED });

      expect(await mismatches(store.id)).toBe(0);
    });

    /** A silent heartbeat is not a disagreement. */
    it('records nothing when the plugin sends no view', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      await ping(store.token, { plugin_version: '1.0.0' });

      expect(await mismatches(store.id)).toBe(0);
    });
  });

  /**
   * Site-URL change detection (M8.1b, `[8i]`).
   *
   * A cloned staging site inherits production's credential and would report
   * orders as the live shop. It reports **its own** URL while the credential
   * still names the original, which is what makes the mismatch detectable.
   */
  describe('the site it was issued to', () => {
    it('admits a request from the store’s own URL', async () => {
      const store = await connected();

      expect((await ping(store.token, {}, await urlOf(store.id))).status).toBe(200);
    });

    /**
     * WordPress reports `home_url( '/' )`, with the slash. `initiate` stored a
     * normalised URL without one, so a byte comparison would refuse every honest
     * plugin — the same rule as `[8e]`'s `site_url`.
     */
    it('admits the trailing slash WordPress actually sends', async () => {
      const store = await connected();

      expect((await ping(store.token, {}, `${await urlOf(store.id)}/`)).status).toBe(200);
    });

    it('admits a differently-cased host', async () => {
      const store = await connected();
      const url = await urlOf(store.id);

      expect((await ping(store.token, {}, url.toUpperCase())).status).toBe(200);
    });

    /** The clone. `403` — the credential is genuine, the site is not. */
    it('refuses a request from another site', async () => {
      const store = await connected();
      const response = await ping(store.token, {}, 'https://staging-clone.example.com');

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    /**
     * `403`, never `401`. A `401` would send the plugin into a reconnect loop it
     * cannot win: the new credential would be presented from the same wrong
     * address.
     */
    it('answers 403 rather than 401', async () => {
      const store = await connected();

      expect((await ping(store.token, {}, 'https://elsewhere.example.com')).status).not.toBe(401);
    });

    /**
     * **It refuses; it never revokes.** The header is caller-controlled, so
     * revoking would let a stolen credential disconnect the merchant's live
     * store — and would kill a legitimate domain migration outright.
     */
    it('leaves the store connected and its credential live', async () => {
      const store = await connected();

      await ping(store.token, {}, 'https://staging-clone.example.com');

      const row = await storeRow(store.id);

      expect(row.status).toBe(StoreStatus.CONNECTED);

      // And the original site still works.
      expect((await ping(store.token, {}, await urlOf(store.id))).status).toBe(200);
    });

    /** Refusing without recording would leave nobody aware a clone exists. */
    it('records the mismatch, naming both URLs', async () => {
      const store = await connected();
      const clone = 'https://staging-clone.example.com';

      await ping(store.token, {}, clone);

      const [row] = await dataSource.query(
        `SELECT changes, tenantId FROM audit_logs
          WHERE resourceId = ? AND action = 'store.site_mismatch' LIMIT 1`,
        [store.id],
      );

      expect(row).toBeDefined();
      expect(row.tenantId).toBe(tenantId);

      const changes = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;

      expect(changes.presented).toBe(clone);
      expect(changes.expected).toBe(await urlOf(store.id));
    });

    /**
     * A clone sends the same wrong URL on every heartbeat, and at 60 an hour
     * that is 1,440 entries a day for one store — into a table with no
     * retention sweep. The condition persists; the event does not repeat.
     */
    it('records a repeated refusal from the same site only once', async () => {
      const store = await connected();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await ping(store.token, {}, 'https://clone.example.com')).status).toBe(403);
      }

      expect(await siteMismatches(store.id)).toBe(1);
    });

    /** A clone appearing at a *different* address is news. */
    it('records again when the presented site changes', async () => {
      const store = await connected();

      await ping(store.token, {}, 'https://clone-one.example.com');
      await ping(store.token, {}, 'https://clone-one.example.com');
      await ping(store.token, {}, 'https://clone-two.example.com');

      expect(await siteMismatches(store.id)).toBe(2);
    });

    /**
     * Deduplicating the *record* must not soften the *refusal*. Every request
     * from the wrong site is refused, whether or not it was worth logging.
     */
    it('refuses every attempt, not only the first', async () => {
      const store = await connected();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await ping(store.token, {}, 'https://clone.example.com')).status).toBe(403);
      }
    });

    /**
     * A missing header is not a mismatch. A proxy stripping unknown headers, or
     * an engineer with `curl`, must not be refused — they have told us nothing,
     * while a wrong header tells us something.
     */
    it('admits a request that sends no header at all', async () => {
      const store = await connected();

      expect((await ping(store.token)).status).toBe(200);
      expect(await siteMismatches(store.id)).toBe(0);
    });

    /**
     * The guard fails **closed** when nothing established a store.
     *
     * Admitting there would make it a decoration on a route that is already
     * unauthenticated — and `@StoreRoute()` tells the global `JwtAuthGuard` to
     * stand aside, so nothing else would refuse the request either.
     */
    it('refuses when StoreTokenGuard did not run', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/store/orphan-site-probe')
        .set('X-Optionia-Site', 'https://anything.example.com');

      expect(response.status).toBe(401);
    });

    /** An unparseable header fails to match rather than becoming a 500. */
    it('refuses junk without crashing', async () => {
      const store = await connected();

      expect((await ping(store.token, {}, 'not-a-url')).status).toBe(403);
    });
  });

  describe('the realm', () => {
    it('refuses a request with no credential', async () => {
      const response = await request(app.getHttpServer()).post('/v1/store/heartbeat').send({});

      expect(response.status).toBe(401);
    });

    it('refuses an unknown credential', async () => {
      expect((await ping(generateStoreToken().plaintext)).status).toBe(401);
    });

    /** M8.6: revocation takes effect on the very next request. */
    it('refuses a revoked credential', async () => {
      const store = await connected();

      expect((await ping(store.token)).status).toBe(200);

      await dataSource.query(`UPDATE store_credentials SET revokedAt = NOW(3) WHERE storeId = ?`, [
        store.id,
      ]);

      expect((await ping(store.token)).status).toBe(401);
    });

    /** A merchant's JWT is a different realm entirely. */
    it('refuses a tenant token', async () => {
      const merchant = await harness.tenant('b');

      expect((await ping(merchant)).status).toBe(401);
    });
  });

  describe('validation', () => {
    it('refuses an unknown connection state', async () => {
      const store = await connected();

      expect((await ping(store.token, { connection_state: 'exploded' })).status).toBe(400);
    });

    it('refuses a negative config version', async () => {
      const store = await connected();

      expect((await ping(store.token, { config_version: -1 })).status).toBe(400);
    });

    it('refuses an over-long version string', async () => {
      const store = await connected();

      expect((await ping(store.token, { plugin_version: 'x'.repeat(21) })).status).toBe(400);
    });

    it('refuses an unknown field', async () => {
      const store = await connected();

      expect((await ping(store.token, { unexpected: 'x' })).status).toBe(400);
    });

    /**
     * All five states are accepted, including ones a healthy plugin would never
     * report — narrowing the field would reject the anomalous report at
     * validation and lose the signal reconciliation exists to capture.
     */
    it('accepts every declared state, and reconciles the odd ones', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      for (const state of Object.values(StoreStatus)) {
        expect((await ping(store.token, { connection_state: state })).status).toBe(200);
      }

      /**
       * Five states, minus the one that agrees with `CONNECTED`, minus
       * `REVOKED` — which is the expected result of a credential rotation and
       * is deliberately not reported. Each remaining claim differs from the one
       * before, so deduplication does not collapse them; a repeated identical
       * claim is covered separately above.
       *
       * Counted from the enum rather than hardcoded, so adding a sixth state
       * fails here and forces a decision about how it reconciles.
       */
      const reported = Object.values(StoreStatus).filter(
        (state) => state !== StoreStatus.CONNECTED && state !== StoreStatus.REVOKED,
      );

      expect(await mismatches(store.id)).toBe(reported.length);
    });
  });

  /**
   * The wire shape the plugin parses.
   *
   * The plugin reads `data.config_version`; this asserts the API actually
   * sends that. It did not always: every plugin caller read the envelope's
   * outer level, so against the real API the handshake returned null, the
   * callback stored no token and the heartbeat recorded no version — while
   * both suites passed, because this side asserted `body.data.*` and every
   * plugin fixture was flat.
   *
   * Two internally-consistent halves that disagree is not something either
   * suite can catch alone. This is the cloud's half of the contract; the
   * plugin's is `bin/check-envelope.sh` and `ResponseEnvelopeTest`.
   */
  describe('the wire contract', () => {
    it('wraps the heartbeat response in the envelope the plugin parses', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      const response = await ping(store.token, { connection_state: StoreStatus.CONNECTED });

      expect(response.status).toBe(200);

      // The envelope itself.
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta.requestId');

      // The payload the plugin reads, one level in — never at the top.
      expect(response.body.data).toHaveProperty('config_version');
      expect(response.body).not.toHaveProperty('config_version');
    });

    it('keeps store routes inside the envelope', async () => {
      const store = await connected(StoreStatus.CONNECTED);

      const response = await ping(store.token, {});

      /**
       * `UNWRAPPED_ROUTES` is matched on path and holds only `/health`. A store
       * route added to it would silently change the shape every plugin build in
       * the field expects — and a shipped plugin cannot be updated in step.
       */
      expect(Object.keys(response.body).sort()).toEqual(['data', 'meta']);
    });
  });

  /**
   * The plugin telling the cloud it is leaving (U8).
   *
   * 🔴 **Found by a merchant, not by a test.** Pressing Disconnect in WordPress
   * cleared the plugin's token and left the cloud believing the store was still
   * connected — **with a live credential**. Every automated suite passed, because
   * the canonical E2E disconnects through the *dashboard*, the path that already
   * worked.
   */
  describe('store-initiated disconnect', () => {
    it('revokes the credential that made the call', async () => {
      const { id, token } = await connected();

      const response = await request(app.getHttpServer())
        .post('/v1/store/disconnect')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.data.disconnected).toBe(true);

      const [store] = await dataSource.query(`SELECT status FROM stores WHERE id = ?`, [id]);
      const [live] = await dataSource.query(
        `SELECT COUNT(*) AS n FROM store_credentials WHERE storeId = ? AND revokedAt IS NULL`,
        [id],
      );

      expect(store.status).toBe('disconnected');
      expect(Number(live.n)).toBe(0);
    }, 30_000);

    /** The credential is dead the moment it is used to disconnect. */
    it('leaves the used credential unusable', async () => {
      const { token } = await connected();

      await request(app.getHttpServer())
        .post('/v1/store/disconnect')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      await ping(token, {}).expect(401);
    }, 30_000);

    /** No credential, no disconnect — it must not be a way to close someone else's store. */
    it('refuses an unauthenticated call', async () => {
      await request(app.getHttpServer()).post('/v1/store/disconnect').send({}).expect(401);
    }, 30_000);
  });
});
