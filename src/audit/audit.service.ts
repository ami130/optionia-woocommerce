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
