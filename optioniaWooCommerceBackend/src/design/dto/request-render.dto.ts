import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, IsString, Length, Min } from 'class-validator';

/**
 * A store asking for one print file (M26e.4).
 *
 * 🔴 **The scene arrives RESOLVED.** M26e.1's rule — *"no geometry computed in
 * PHP"* — cuts both ways: the plugin does not compute, and the cloud does not
 * re-derive. What the dashboard's own renderer built is what gets rasterised,
 * which is the only way the print file matches the preview a merchant approved.
 */
export class RequestRenderDto {
  /**
   * The cart line this belongs to, as the STORE identifies it.
   *
   * 📌 **Opaque to the cloud.** WooCommerce names a cart line with its own
   * hash; the cloud has no order table to join against and ADR-016 says it
   * should not. This is the handle the plugin presents when it asks what
   * became of its request — and the key that makes a retry idempotent.
   */
  @IsString()
  @Length(1, 128)
  @ApiProperty({ type: String })
  line_ref: string;

  /**
   * ⚠️ **Shape unvalidated here, deliberately** — the same decision
   * `option_values.design` records. The scene is an arbitrary tree of layers
   * and text nodes that no DTO could usefully describe, and the renderer
   * refuses what it cannot draw. What IS validated is everything that bounds
   * the work: the dimensions below.
   */
  @IsObject()
  @ApiProperty({ type: Object })
  scene: Record<string, unknown>;

  /**
   * 🔴 **Bounded at the door, not at the renderer.** An unbounded canvas is an
   * OOM kill the worker cannot survive or report — measured at 50000×50000:
   * 46 seconds, ~10 GB, killed by the kernel with no catchable error. `@Min(1)`
   * stops the degenerate case here; `checkRenderBounds` applies the megapixel
   * ceiling in the service, where the two dimensions can be judged together.
   */
  @IsInt()
  @Min(1)
  @ApiProperty({ type: Number })
  width: number;

  @IsInt()
  @Min(1)
  @ApiProperty({ type: Number })
  height: number;
}
