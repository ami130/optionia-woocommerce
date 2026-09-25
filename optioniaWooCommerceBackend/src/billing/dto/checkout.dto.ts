import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

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
