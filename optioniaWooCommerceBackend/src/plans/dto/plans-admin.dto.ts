import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsString, Length, Min } from 'class-validator';

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
