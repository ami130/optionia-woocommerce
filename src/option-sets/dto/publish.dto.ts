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
  note?: string;
}

export class RollbackDto {
  /** The version to restore. Published as a *new* version, never rewritten. */
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
