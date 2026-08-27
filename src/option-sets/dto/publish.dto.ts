import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Request shapes for publishing (M7.4). */

export class PublishDto {
  /**
   * The version the client loaded (M7.4b).
   *
   * Optional, like every other `rowVersion`: a script publishing on a schedule
   * has no loaded version. A dashboard always sends one, because publishing a
   * draft a colleague changed puts unreviewed work in front of customers.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  rowVersion?: number;

  /**
   * Why this version was published.
   *
   * Optional, because requiring a note on every publish trains merchants to type
   * "update" — and a history of "update" is no history at all.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class RollbackDto {
  /** The version to restore. Published as a *new* version, never rewritten. */
  @IsInt()
  @Min(1)
  @ApiProperty({ type: Number })
  version: number;

  /**
   * The set's version the client loaded (M7.4b).
   *
   * Rollback is the most consequential write on an option set — it changes what
   * every storefront receives — and the merchant picks a version from a history
   * list. A stale list means reverting on the strength of something that has
   * since changed.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ type: Number })
  rowVersion?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @ApiPropertyOptional({ type: String })
  note?: string;
}
