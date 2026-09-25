import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * Starting a checkout (M22.D1).
 *
 * 🔴 **A price, not a plan.** The interface's rule, carried all the way to the
 * wire: what a merchant is charged is the immutable `plan_prices` row they
 * bought. Accepting a `planId` here would let a price edit re-charge a merchant
 * who already paid, which is the defect `plan_prices` exists to prevent.
 */
export class StartCheckoutDto {
  @ApiProperty({
    description: 'The plan_prices row to buy. Must be current and offered.',
    format: 'uuid',
  })
  @IsUUID()
  planPriceId: string;
}

/**
 * Moving to a different price (M22.E3).
 *
 * 📌 Same shape as starting a checkout, and deliberately so: both name the
 * immutable `plan_prices` row, never a plan.
 */
export class ChangePlanDto {
  @ApiProperty({
    description: 'The plan_prices row to move to. Must be current and offered.',
    format: 'uuid',
  })
  @IsUUID()
  planPriceId: string;
}

/**
 * Cancelling (M22.E4).
 *
 * ⚠️ **`atPeriodEnd` defaults to true**, because the merchant has paid for the
 * term and ending it early takes something they bought. Immediate cancellation
 * has to be asked for.
 */
export class CancelSubscriptionDto {
  @ApiPropertyOptional({
    description: 'Cancel at the end of the paid term rather than immediately.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  atPeriodEnd?: boolean;

  /**
   * 🔴 **Optional, and that is a decision not an oversight.** A required field
   * on the way out produces junk answers from people who want the dialog gone,
   * which is worse than no data because it looks like data.
   */
  @ApiPropertyOptional({ description: 'Why, in the merchant\'s words.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Paging invoice history (M22.E2). */
export class ListInvoicesDto {
  /**
   * ⚠️ Capped at 100. An unbounded list endpoint is a denial-of-service someone
   * finds by accident, and no merchant reads a thousand invoices in one screen.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
