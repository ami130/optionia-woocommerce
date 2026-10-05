import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * The plugin confirming it has stored a print file (M26e.4, Decision 3a).
 *
 * 🔴 **This is what ends the transfer.** Until it arrives the bytes sit in the
 * cloud's buffer and the job reads `rendered`; after it, the merchant's
 * WordPress holds the file and the job reads `ready`. The cloud never learns
 * the URL any other way — Decision 3 put the permanent home on the merchant's
 * own server, so only the plugin knows where it landed.
 */
export class CollectedRenderDto {
  /**
   * Where the plugin stored it.
   *
   * ⚠️ **`require_tld` is off and `https` is NOT required**, because a merchant
   * store may be on an intranet host or plain HTTP in development, and refusing
   * those would refuse the collection rather than the URL. What is enforced is
   * that it is a URL at all — this string ends up in an order record a
   * fulfiller clicks.
   */
  @IsString()
  @MaxLength(500)
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @ApiProperty({ type: String })
  file_url: string;
}
