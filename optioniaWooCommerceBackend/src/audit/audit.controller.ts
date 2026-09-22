import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { ApiBearerAuth } from '@nestjs/swagger';

import { ApiErrors } from '../common/openapi/api-errors.decorator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { PaginatedResult } from '../common/http/api-response.types';
import {
  AuditQueryService,
  DEFAULT_AUDIT_PAGE_SIZE,
  type AuditEntryView,
} from './audit-query.service';
import { ListAuditDto } from './dto/list-audit.dto';

/**
 * Reading the audit trail (M7.6).
 *
 * `audit_log:view` is held by **owner and admin only** — not editor. An editor
 * changes configuration; who changed what, from which address, is an ownership
 * question, and the trail contains IP addresses that are personal data.
 */
@Controller('audit-logs')
/**
 * Declares the realm in the generated spec (AC8).
 *
 * The guard chain below enforces it; this makes the spec say so, and a
 * generated client send the right token. Without it every operation reads
 * as public — the schemes were defined and referenced by nothing.
 */
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @RequireCapability(Capability.AUDIT_LOG_VIEW)
  @ApiErrors(200, 400, 401, 403, 429)
  async list(@Query() query: ListAuditDto): Promise<PaginatedResult<AuditEntryView>> {
    const limit = query.limit ?? DEFAULT_AUDIT_PAGE_SIZE;
    const page = await this.audit.list({ ...query, limit });

    return new PaginatedResult([...page.items], {
      cursor: page.cursor,
      hasMore: page.hasMore,
      limit,
    });
  }
}
