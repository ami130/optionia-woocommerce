import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { getContext } from '../common/context/request-context';
import { packIpAddress } from '../common/net/ip-address';
import { AuditLog } from './entities/audit-log.entity';

/**
 * The audit trail.
 *
 * M6.5 rule 3 requires recording every privileged action — role changes,
 * publishes, billing changes, deletions — with actor, target, before/after and
 * IP. The table existed from Phase 5 and nothing wrote to it, which made the rule
 * documentation rather than a control.
 *
 * **Writing must never fail the action it records.** An audit row that cannot be
 * written is a problem for operations; a role change that fails because of one is
 * a problem for the merchant, and the second is worse. Failures are logged at
 * error and swallowed.
 */

/** Stable action names. Queried by support, so they do not get renamed casually. */
export const AuditAction = {
  /**
   * Authentication (M6.x).
   *
   * 🔴 **These were missing while `AuditService` was already injected into
   * `auth.module.ts`** — wired and unused, which is the easiest kind of gap to
   * mistake for coverage. A system that logs who renamed an option value but not
   * who signed in has its priorities inverted: the sign-in is what an incident
   * response starts from.
   *
   * ## What is recorded, and what is deliberately not
   *
   * **`LOGIN_FAILED` carries no password and no reason.** The route answers a
   * wrong password and an unregistered address identically, on purpose — and an
   * audit row distinguishing them would rebuild the membership oracle the route
   * refuses to be, for anyone who can read the log.
   *
   * **`refresh` is absent.** It fires on a timer, not on an intent: recording it
   * would add a row every few minutes per active session and bury the events a
   * reader is actually looking for. Refresh-token *reuse* is a real signal and is
   * already logged as a warning by the sessions service, which is where it
   * belongs — it is an attack indicator, not a user action.
   *
   * **`me` is absent** for the same reason: reading your own profile is not an
   * event.
   */
  USER_REGISTERED: 'user.registered',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  USER_PASSWORD_RESET: 'user.password_reset',

  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_INVITED: 'member.invited',
  MEMBER_JOINED: 'member.joined',

  OPTION_SET_CREATED: 'option_set.created',
  OPTION_SET_UPDATED: 'option_set.updated',
  OPTION_SET_DELETED: 'option_set.deleted',
  OPTION_SET_DUPLICATED: 'option_set.duplicated',
  OPTION_SET_REORDERED: 'option_set.reordered',
  OPTION_SET_PURGED: 'option_set.purged',
  OPTION_SET_PUBLISHED: 'option_set.published',
  OPTION_SET_ROLLED_BACK: 'option_set.rolled_back',

  OPTION_GROUP_CREATED: 'option_group.created',
  OPTION_GROUP_UPDATED: 'option_group.updated',
  OPTION_GROUP_DELETED: 'option_group.deleted',
  OPTION_GROUP_DUPLICATED: 'option_group.duplicated',
  OPTION_GROUP_REORDERED: 'option_group.reordered',

  OPTION_CREATED: 'option.created',
  OPTION_UPDATED: 'option.updated',
  OPTION_DELETED: 'option.deleted',
  OPTION_DUPLICATED: 'option.duplicated',
  OPTION_REORDERED: 'option.reordered',

  OPTION_VALUE_CREATED: 'option_value.created',
  OPTION_VALUE_UPDATED: 'option_value.updated',
  OPTION_VALUE_DELETED: 'option_value.deleted',
  OPTION_VALUE_DUPLICATED: 'option_value.duplicated',
  OPTION_VALUE_DELETE_REFUSED: 'option_value.delete_refused',

  /**
   * Presentational items (M5.4c).
   *
   * Recorded like any other authoring mutation, even though an item asks the
   * customer nothing and never reaches the pricing engine. It still changes what
   * a storefront shows, and "who deleted the allergy warning above the flavour
   * picker" is a support question with real consequences behind it.
   */
  PRESENTATIONAL_ITEM_CREATED: 'presentational_item.created',
  PRESENTATIONAL_ITEM_UPDATED: 'presentational_item.updated',
  PRESENTATIONAL_ITEM_DELETED: 'presentational_item.deleted',
  PRESENTATIONAL_ITEM_REORDERED: 'presentational_item.reordered',

  /**
   * Conditional rules (M17.1).
   *
   * 🔴 **A rule decides whether a customer is charged**, so its trail matters
   * more than most: `set_price` replaces a value's delta (ADR-049), and a
   * `hide` removes an option from the line entirely (ADR-051). "Why did this
   * order cost that" is answerable only if every change to the logic is
   * recorded with who made it.
   *
   * No `RULE_DISABLED` action: a rule disabled because its target was deleted is
   * written by the cascade, and the cascade's own delete action already records
   * the cause. A second row for the consequence would say the same thing twice
   * and invite the two to disagree.
   */
  OPTION_RULE_CREATED: 'option_rule.created',
  OPTION_RULE_UPDATED: 'option_rule.updated',
  OPTION_RULE_DELETED: 'option_rule.deleted',
  OPTION_RULE_REORDERED: 'option_rule.reordered',

  /**
   * Store connection transitions (M8.1b).
   *
   * `connect/initiate` is deliberately absent. It is `@Public()` and carries no
   * tenant, while `audit_logs` is read through a tenant-scoped query — an entry
   * with a null tenant would be invisible to every consumer, written to satisfy a
   * rule nobody can read. M8.1b's "every transition is logged" is read as every
   * transition **of a store**, and a pending request is not yet a store: nothing
   * exists to transition until `authorize` creates or reuses one.
   */
  STORE_CONNECT_AUTHORIZED: 'store.connect_authorized',
  STORE_RECONNECT_AUTHORIZED: 'store.reconnect_authorized',

  /**
   * The handshake completing: `CONNECTING` → `CONNECTED` (`[8e]`).
   *
   * Written with an **explicit `tenantId`**, unlike every other action here.
   * `connect/exchange` is `@Public()` and has no tenant in context — but unlike
   * `initiate`, the tenant is *knowable*: it was recorded on the connection code
   * when the merchant approved. Naming it directly is what keeps a completed
   * connection visible to the tenant-scoped audit query.
   */
  STORE_CONNECTED: 'store.connected',

  /**
   * The remaining states of M8.1b's machine, declared here rather than by
   * whichever step first needs one.
   *
   * `[8g]` disconnects, `[8h]` reports failure and recovery, `[8i]` revokes on a
   * site-URL change. Adding each action alongside its step made the coverage
   * gate unable to tell a missing action from a deliberate omission — it caught
   * exactly that twice already. Declaring the set with the state machine means a
   * transition without an audit entry is a compile error, not an oversight.
   */
  STORE_DISCONNECTED: 'store.disconnected',
  STORE_REVOKED: 'store.revoked',

  /**
   * A request arrived from a site the credential was not issued to (M8.1b).
   *
   * Recorded, never acted on automatically. `X-Optionia-Site` is a plain header
   * and whoever holds the credential controls it, so revoking on a mismatch
   * would let a stolen token disconnect the merchant's live store — and would
   * kill a legitimate domain migration on its first request. The clone is
   * refused; a human decides what it means.
   */
  STORE_SITE_MISMATCH: 'store.site_mismatch',

  /**
   * A sync or auth failure, which is **Phase 9's** to record.
   *
   * `[8f]` declared this expecting `[8h]` to produce it. The heartbeat cannot:
   * it is the plugin *succeeding* at reaching the cloud, and the contract
   * forbids writing `stores.status` from the plugin's own claim — that claim is
   * one of the two things in dispute. The `CONNECTED → ERROR` edge is a config
   * sync failing, which arrives with the sync itself.
   */
  STORE_ERRORED: 'store.errored',

  /**
   * The plugin's view of its connection disagrees with the cloud's (M8.1b).
   *
   * Recorded rather than resolved: a database restore, a migrated site and a
   * cloned staging environment all produce this, and each has a different right
   * answer. Guessing is what M8.1b calls the largest source of support tickets in
   * this category of product.
   */
  STORE_STATE_MISMATCH: 'store.state_mismatch',

  /**
   * A store cannot read the documents this cloud is sending (M9.5).
   *
   * The plugin refuses a `schema_version` above what its build understands and
   * keeps its previous copy — correct, and silent: that shop goes on serving
   * old configuration while its heartbeat, its connection state and its
   * credential all look healthy. Nothing else in the system says "this merchant
   * needs to update their plugin".
   *
   * Recorded rather than acted on, for the same reason as a state mismatch: the
   * answer is a merchant updating software the cloud does not control, so this
   * is an operations item for Phase 26 rather than something to resolve here.
   */
  STORE_SCHEMA_UNSUPPORTED: 'store.schema_unsupported',

  /**
   * A credential replaced without the store changing state.
   *
   * Rotation is **not** a transition — the store stays `CONNECTED` throughout —
   * so it cannot borrow one of the state actions above. It is the one store
   * event that records a change to a credential rather than to a connection.
   */
  STORE_CREDENTIAL_ROTATED: 'store.credential_rotated',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  readonly action: AuditAction;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  /** Before and after, so "what changed" is answerable without a diff of rows. */
  readonly changes?: Record<string, unknown> | null;
  /** Overrides the request context, for a job acting on a tenant's behalf. */
  readonly tenantId?: string | null;
  readonly userId?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly logs: Repository<AuditLog>,
  ) {}

  /**
   * Record one privileged action.
   *
   * Actor and tenant come from the request context by default, so a caller
   * cannot forget them and cannot attribute an action to someone else.
   */
  /**
   * Record an entry **only when it differs from the last one like it**.
   *
   * For conditions that persist rather than happen: a plugin reporting a state
   * the cloud disagrees with, a cloned site presenting the wrong URL. Those
   * recur on every request, and the trail is a log of *events* — a condition
   * that has not changed is a repetition, not news.
   *
   * The scale is the reason this exists. A store that cannot be reconciled
   * disagrees on every heartbeat: daily that is 365 entries a year, and against
   * the 60-per-hour limit a misbehaving plugin writes **1,440 a day for one
   * store** — into a table that has no retention sweep behind it.
   *
   * `fields` names what makes an entry "the same". Everything else in `changes`
   * is carried but not compared, so a timestamp or a message can vary without
   * defeating the check. Comparing the whole object would do exactly that.
   *
   * Extracted after the same deduplication was written twice — once for
   * `store.state_mismatch` and again, missing, for `store.site_mismatch`. Two
   * occurrences is a pattern, and Phase 9's sync failures are the third.
   */
  async recordChange(entry: AuditEntry, fields: readonly string[]): Promise<void> {
    if (!entry.resourceId) {
      // Nothing to key the comparison on; record it rather than drop it.
      await this.record(entry);

      return;
    }

    try {
      const previous = await this.logs.findOne({
        where: {
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          action: entry.action,
        },
        order: { createdAt: 'DESC' },
      });

      const last = previous?.changes ?? null;
      const next = entry.changes ?? null;

      if (last && next && fields.every((field) => last[field] === next[field])) {
        return;
      }
    } catch (error) {
      // A failed lookup must not lose the entry — recording twice is a worse
      // trail than recording once, and losing it entirely is worse than both.
      this.logger.warn(
        `Could not read the previous ${entry.action} entry; recording unconditionally: ` +
          `${(error as Error).message}`,
      );
    }

    await this.record(entry);
  }

  async record(entry: AuditEntry): Promise<void> {
    const context = getContext();

    try {
      await this.logs.save(
        this.logs.create({
          tenantId: entry.tenantId ?? context?.tenantId ?? null,
          userId: entry.userId ?? context?.userId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          changes: entry.changes ?? null,
          // From the request context, not the entry: an audit row must record
          // where the action actually came from, so a caller cannot supply it.
          ip: packIpAddress(context?.ip),
          userAgent: context?.userAgent ?? null,
        }),
      );
    } catch (error) {
      // Deliberately swallowed. See the class comment: the recorded action has
      // already happened, and failing it now would be a worse outcome than an
      // incomplete trail — which is at least visible here.
      this.logger.error(
        `failed to record audit entry ${entry.action}: ${(error as Error).message}`,
      );
    }
  }
}
