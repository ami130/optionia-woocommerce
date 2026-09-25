import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

/**
 * The period a tax report covers (M22.E6).
 *
 * 🔴 **Both bounds are required.** A tax return is filed for a stated period,
 * and a report that defaulted one would be a number someone might file without
 * noticing which quarter it covered.
 *
 * 📌 **Half-open `[from, to)`**, so consecutive periods neither overlap nor
 * leave a gap — a closed upper bound double-counts every invoice issued exactly
 * on the boundary, in both quarters.
 */
export class TaxReportQueryDto {
  @ApiProperty({ description: 'Start of the period, inclusive. ISO 8601.' })
  @IsISO8601()
  from: string;

  @ApiProperty({ description: 'End of the period, exclusive. ISO 8601.' })
  @IsISO8601()
  to: string;
}
