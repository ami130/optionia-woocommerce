import { ApiProperty } from '@nestjs/swagger';
import { IsStrictBoolean } from '../../common/validation/strict-boolean.decorator';

/**
 * Dismiss or restore the setup checklist (M20b.2).
 *
 * 📌 **An explicit boolean rather than a bodiless POST.** "Show it again" is a
 * real action the dashboard offers, and a route that only ever dismisses would
 * need a second one to undo it — two ways to write one column.
 */
export class SetChecklistDismissedDto {
  @ApiProperty({
    description: 'True to dismiss the setup checklist, false to show it again.',
    example: true,
  })
  @IsStrictBoolean()
  dismissed: boolean;
}
