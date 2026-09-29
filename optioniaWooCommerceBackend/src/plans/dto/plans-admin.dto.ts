import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsString, Length, Min } from 'class-validator';

/**
 * Setting a plan's price (M22.1a).
 *
 * 🔴 **Minor units, always.** A price given as `29.00` invites a float, and a
 * float that has been through JSON is how a charge becomes 2899 cents. The
 * whole system stores money as integers for this reason.
 */
export class SetPlanPriceDto {
  @ApiProperty({ description: 'ISO 4217, e.g. USD.', minLength: 3, maxLength: 3 })
  @IsString()
  @Length(3, 3)
  currency: string;

  @ApiProperty({ enum: ['month', 'year'] })
  @IsIn(['month', 'year'])
  interval: string;

  /**
   * ⚠️ **Zero is allowed.** A free tier is a real price at zero, not the absence
   * of one — and `plan_prices` carries a row for it so a subscription can pin to
   * something.
   */
  @ApiProperty({ description: 'Amount in minor units, e.g. 2900 for $29.00.', minimum: 0 })
  @IsInt()
  @Min(0)
  amountMinor: number;
}

/**
 * Showing or hiding a plan at signup (M22.1a).
 *
 * 📌 **Hiding is not cancelling.** Nobody on the plan is affected; only what a
 * new signup may choose changes.
 */
export class SetPlanVisibilityDto {
  @ApiProperty({ description: 'Whether new signups may choose this plan.' })
  @IsBoolean()
  isPublic: boolean;
}

/**
 * Replacing a plan's enforceable allowances (B10).
 *
 * 🔴 **The keys are validated in the SERVICE, not here**, and deliberately so.
 * The set of enforceable metrics is `COUNTABLE_METRICS`, derived from the same
 * constant `UsageCounterService` and `PlanLimitGuard` use — restating it as a
 * decorator would be a second list to drift, which is the defect this whole
 * milestone keeps meeting. `@IsObject()` establishes the shape; the service
 * establishes the meaning.
 *
 * ⚠️ **`null` is unlimited and an absent key is unmetered**, and the two are
 * different. `PlanLimitGuard` treats a missing key as "this plan has no opinion
 * about this metric", so a replace — not a merge — is the only way to express
 * removing a limit.
 */
export class SetPlanLimitsDto {
  @ApiProperty({
    description:
      'Every limit this plan enforces, keyed by metric. `null` means unlimited; ' +
      'an omitted key means the plan does not meter that metric at all. ' +
      'This REPLACES the existing limits rather than merging into them.',
    example: { option_sets: 50, stores: 3, team_seats: 5, products_assigned: null },
    type: 'object',
    additionalProperties: { type: 'number', nullable: true },
  })
  @IsObject()
  limits: Record<string, number | null>;
}

/**
 * Replacing a plan's capability flags (B10).
 *
 * ⚠️ **An absent key reads as OFF**, which is why this replaces rather than
 * merges: omitting a feature is how a plan stops including it, and a merge could
 * never express that.
 */
export class SetPlanFeaturesDto {
  @ApiProperty({
    description:
      'Every capability this plan includes, keyed by feature. An omitted key is off. ' +
      'This REPLACES the existing features rather than merging into them.',
    example: { analytics: true, conditional_rules: true, rich_text_html: false },
    type: 'object',
    additionalProperties: { type: 'boolean' },
  })
  @IsObject()
  features: Record<string, boolean>;
}
