import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * Filters for the audit trail.
 *
 * Deliberately narrow. A trail is read to answer a specific question — "who
 * deleted this option set?", "what happened to this store yesterday?" — and a
 * filter for every column invites queries no index serves. `audit_logs` carries
 * `(tenantId, createdAt)` and `(resourceType, resourceId)`, and these filters
 * are the ones those indexes answer.
 */
export class ListAuditDto {
  /** Exact action, e.g. `option_set.deleted`. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @ApiPropertyOptional({ type: String })
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @ApiPropertyOptional({ type: String })
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ type: String })
  resourceId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ type: Number })
  limit?: number;

  /** Opaque cursor from a previous page. Clients must not construct one. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  cursor?: string;
}
