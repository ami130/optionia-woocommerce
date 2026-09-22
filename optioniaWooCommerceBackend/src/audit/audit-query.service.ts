import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { requireTenantId } from '../common/context/request-context';
import { DomainException } from '../common/errors/domain.exception';
import { unpackIpAddress } from '../common/net/ip-address';
import { AuditLog } from './entities/audit-log.entity';

/** One entry, as a person reads it. */
export interface AuditEntryView {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly userId: string | null;
  /** Readable, not the packed bytes the column holds. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly changes: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface AuditPage {
  readonly items: readonly AuditEntryView[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export interface AuditFilters {
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/** Matches the option-set list endpoints. */
export const DEFAULT_AUDIT_PAGE_SIZE = 50;

/**
 * Reading the audit trail (M7.6).
 *
 * The trail was **write-only**: every mutation recorded, and nothing able to
 * read it back. `AUDIT_LOG_VIEW` existed in the permission matrix, was granted
 * to owner and admin, and no route consumed it — so the data a merchant is told
 * is kept for their protection could not be shown to them, and the questions it
 * exists to answer ("who deleted that option set?") had to be answered by
 * someone with database access.
 *
 * ## Why a separate service from `AuditService`
 *
 * `AuditService.record` deliberately swallows its own failures: the action it
 * describes has already happened, and failing it afterwards is worse than an
 * incomplete trail. Reading has the opposite disposition — a query that fails
 * must say so, because a trail that silently returns nothing is
 * indistinguishable from a clean history.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly logs: Repository<AuditLog>,
  ) {}

  /**
   * One page of the acting tenant's trail, newest first.
   *
   * **Scoped by `requireTenantId()`, which throws when absent.** The trail
   * records who did what inside one workspace; there is no legitimate caller
   * without a tenant, so a missing one is a bug rather than a case to handle.
   */
  async list(filters: AuditFilters): Promise<AuditPage> {
    const tenantId = requireTenantId();

    const query = this.logs
      .createQueryBuilder('a')
      .where('a.tenantId = :tenantId', { tenantId });

    if (filters.action) {
      query.andWhere('a.action = :action', { action: filters.action });
    }

    if (filters.resourceType) {
      query.andWhere('a.resourceType = :resourceType', {
        resourceType: filters.resourceType,
      });
    }

    if (filters.resourceId) {
      query.andWhere('a.resourceId = :resourceId', { resourceId: filters.resourceId });
    }

    const after = decodeAuditCursor(filters.cursor);

    if (after !== null) {
      // Strictly older than the last row of the previous page.
      query.andWhere('a.id < :after', { after });
    }

    /**
     * Ordered by `id` alone, descending.
     *
     * `audit_logs.id` is a monotonic `BIGINT`, not a UUID, so it is both the
     * insertion order and a total order — no timestamp tie-break is needed, and
     * two rows written in the same millisecond still page correctly. That is
     * why this does not reuse the shared `(createdAt, id)` cursor.
     */
    query.orderBy('a.id', 'DESC');

    const rows = await query.take(filters.limit + 1).getMany();
    const hasMore = rows.length > filters.limit;
    const items = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map(toView),
      cursor: hasMore && last ? encodeAuditCursor(last.id) : null,
      hasMore,
    };
  }
}

/** Opaque by construction, like every other cursor in the API. */
function encodeAuditCursor(id: string): string {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

/**
 * Decode an audit cursor, **refusing a malformed one**.
 *
 * Same reasoning as the keyset cursor it deliberately does not share: treating
 * an unusable cursor as absent returns page one with a 200, and a client cannot
 * tell that from a genuine first page.
 */
function decodeAuditCursor(cursor?: string): string | null {
  if (cursor === undefined) {
    return null;
  }

  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

  if (!/^\d{1,20}$/.test(decoded)) {
    throw DomainException.validation([{ field: 'cursor', code: 'INVALID_CURSOR' }]);
  }

  return decoded;
}

/**
 * An entry as a person reads it.
 *
 * `ip` is unpacked from the 16 bytes the column stores — a `VARBINARY` read
 * straight out of MySQL is unreadable, and the trail exists to be read.
 *
 * ⚠️ An IP is personal data under GDPR. It is shown to `audit_log:view` holders
 * (owner and admin) and is subject to the Phase 26b retention policy.
 */
function toView(row: AuditLog): AuditEntryView {
  return {
    id: String(row.id),
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    userId: row.userId,
    ip: unpackIpAddress(row.ip),
    userAgent: row.userAgent,
    changes: row.changes,
    createdAt: row.createdAt.toISOString(),
  };
}
