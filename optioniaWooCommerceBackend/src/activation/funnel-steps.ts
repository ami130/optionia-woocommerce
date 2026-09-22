import { LIVE_SENTINEL_SQL } from '../common/database/base.entity';

/**
 * The activation funnel (M20b.1).
 *
 * ```text
 * signup → email verified → plugin installed → store connected
 *        → products synced → option set created → assigned → PUBLISHED
 *        → first customer selection → first order with options
 * ```
 *
 * **Activation is `published`.** The two steps after it are value-realized, and
 * are reported separately for that reason: a merchant who published has adopted
 * the product, and whether a customer has since bought through it is a different
 * question with a different remedy.
 *
 * ## Why these are derived, not events
 *
 * M20b.1 says "every transition is an event", and the audit log is where such
 * events would live. Measurement ruled it out: **every one of the 17,768
 * `user.registered` rows carries a NULL `tenantId` and a NULL `userId`**, because
 * `AuditService.record()` fills both from the authenticated request context and
 * registration has none. The rows exist and cannot be attributed, so a funnel
 * built on them reports zero at step one.
 *
 * The domain tables answer the same question from state that is already correct,
 * and they answer it *retroactively* — every merchant who ever signed up is in
 * the denominator, including the ones who signed up before this code existed.
 * An event stream only ever knows about the future. See ADR-086.
 *
 * ## Why each predicate is an independent EXISTS
 *
 * ⚠️ **This funnel is deliberately not monotone**, and a reader who assumes it is
 * will file a bug against correct output. Measured against live data:
 *
 * ```text
 * installed 3  >  connected 2
 * ```
 *
 * That is not a counting error. A merchant who connected a store, synced
 * products, and later disconnected keeps their connection-code history and their
 * synced products while `stores.status` is no longer `connected`. Each step asks
 * *"has this tenant ever reached this state?"* — except `connected` and
 * `published`, which ask about **current** state because that is what the word
 * means to the person reading the number.
 *
 * Forcing monotonicity by nesting the predicates would answer a question nobody
 * asked ("how many are currently at exactly step N"), and would hide the
 * regression the gap actually reveals — a merchant who churned after connecting.
 */
export const ACTIVATION_STEPS = [
  'signed_up',
  'verified',
  'installed',
  'connected',
  'synced',
  'created',
  'assigned',
  'published',
  'selected',
  'ordered',
] as const;

export type ActivationStep = (typeof ACTIVATION_STEPS)[number];

/** The step that counts as activation. Everything after it is value-realized. */
export const ACTIVATION_STEP: ActivationStep = 'published';

/**
 * A SQL predicate per step, correlated to a `tenants` row aliased `t`.
 *
 * `signed_up` is absent: it is the denominator — a tenant row *is* a signup — and
 * a predicate that is always true would invite someone to filter on it.
 *
 * ## The soft-delete trap
 *
 * `option_sets` and `option_set_assignments` extend `SoftDeletableEntity`, where a
 * **live row is `deletedAt = '1970-01-01 00:00:00.000'`, never NULL** (ADR-014).
 * Three of these predicates touch those tables, and the obvious
 * `deletedAt IS NULL` matches *nothing* while its absence silently counts deleted
 * option sets as progress. The first draft of this query omitted it and
 * overcounted; see the spec, which proves each of the three.
 *
 * Every other table here extends `BaseEntity` and has no `deletedAt` at all —
 * verified per entity rather than assumed, because adding the filter to a table
 * that lacks the column is a hard error and omitting it where it belongs is a
 * silent one.
 */
export const STEP_PREDICATES: Readonly<Record<Exclude<ActivationStep, 'signed_up'>, string>> = {
  /**
   * Any **current** member of the tenant has a verified email.
   *
   * Through `tenant_members` rather than an owner column, because a tenant whose
   * owner never verified but whose invited colleague did is verified in every
   * sense that matters to onboarding.
   *
   * 🔴 **`revokedAt IS NULL` matches `TenantGuard`, which is the authority on
   * what a member is.** Without it a tenant whose only verified member had been
   * removed still read as verified — while that person could no longer reach the
   * tenant at all, because the guard filters them out. Two definitions of
   * "member" in one system, disagreeing.
   *
   * ⚠️ **`acceptedAt` is deliberately not filtered**, for the same reason: the
   * guard does not filter it either. An invited colleague who has verified their
   * address but not yet accepted is still a member to every other part of this
   * system, and inventing a stricter rule here would be a third definition.
   *
   * Measured when this was found: **0 revoked and 0 pending memberships**, so the
   * count was 14 either way — the same profile as the two soft-delete defects
   * this phase produced. A predicate written against the happy shape of a table
   * that carries a lifecycle column, invisible in the data available.
   */
  verified: `EXISTS(SELECT 1 FROM tenant_members tm JOIN users u ON u.id = tm.userId
              WHERE tm.tenantId = t.id
                AND tm.revokedAt IS NULL
                AND u.emailVerifiedAt IS NOT NULL)`,

  /**
   * The plugin has run on the merchant's WordPress and started a handshake.
   *
   * `store_connection_codes` rows are **created by the plugin** — the row carries
   * `siteUrl`, `challenge` and `pluginVersion` from a PKCE request that only
   * installed, running plugin code can send. Its `tenantId` is NULL at insert and
   * filled on approval, so this counts handshakes the merchant approved.
   *
   * ⚠️ This is the closest honest proxy, not a direct observation. A merchant who
   * installed the plugin and never clicked Connect is invisible here and counts as
   * not-installed. The alternative — matching unapproved rows by `siteUrl` — has no
   * tenant to attribute them to, which is the same wall the audit log hit.
   * M20b.3's "I've installed it — check" button is what closes this gap.
   */
  installed: `EXISTS(SELECT 1 FROM store_connection_codes c WHERE c.tenantId = t.id)`,

  /** A store is connected **right now** — present tense, unlike `installed`. */
  connected: `EXISTS(SELECT 1 FROM stores s WHERE s.tenantId = t.id
               AND s.status = 'connected')`,

  /** Products reached us. Scoped through `stores`: `store_products` has no `tenantId`. */
  synced: `EXISTS(SELECT 1 FROM store_products p JOIN stores s2 ON s2.id = p.storeId
            WHERE s2.tenantId = t.id)`,

  created: `EXISTS(SELECT 1 FROM option_sets o WHERE o.tenantId = t.id
             AND o.deletedAt = '${LIVE_SENTINEL_SQL}')`,

  /**
   * Both the assignment and its set must be live.
   *
   * `option_set_assignments` has no `tenantId`; it scopes through `option_sets`.
   * Checking only the assignment would count one attached to a deleted set.
   */
  assigned: `EXISTS(SELECT 1 FROM option_set_assignments a
              JOIN option_sets o2 ON o2.id = a.optionSetId
              WHERE o2.tenantId = t.id
                AND a.deletedAt = '${LIVE_SENTINEL_SQL}'
                AND o2.deletedAt = '${LIVE_SENTINEL_SQL}')`,

  /** **Activation.** Current status, so un-publishing moves a merchant back out. */
  published: `EXISTS(SELECT 1 FROM option_sets o3 WHERE o3.tenantId = t.id
               AND o3.status = 'published'
               AND o3.deletedAt = '${LIVE_SENTINEL_SQL}')`,

  /**
   * A real customer chose an option — value realized, not just configured.
   *
   * `order_selections` is the join that makes this "an order **with options**"
   * rather than any order at all.
   */
  selected: `EXISTS(SELECT 1 FROM order_selections sel
              JOIN order_events e ON e.id = sel.orderEventId
              JOIN stores s3 ON s3.id = e.storeId WHERE s3.tenantId = t.id)`,

  /** Any order reached us from this tenant's stores. */
  ordered: `EXISTS(SELECT 1 FROM order_events e2 JOIN stores s4 ON s4.id = e2.storeId
             WHERE s4.tenantId = t.id)`,
} as const;
