import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, Min } from 'class-validator';

/**
 * A storefront asking for the SVG it overlays on a product image (M26e.1).
 *
 * 🔴 **The same scene shape the print request carries**, minus `line_ref`.
 * A preview belongs to no cart line — a customer is still choosing — so there
 * is nothing to be idempotent about and nothing to store. That absence is the
 * whole difference between this and `RequestRenderDto`.
 *
 * ⚠️ **Shape unvalidated, deliberately**, for the reason that DTO records: the
 * scene is an arbitrary tree of layers and text nodes no DTO could usefully
 * describe, and the serializer refuses what it cannot draw. What IS validated
 * is everything that bounds the work.
 */
export class PreviewSceneDto {
  @IsObject()
  @ApiProperty({ type: Object })
  scene: Record<string, unknown>;

  /**
   * 🔴 **Bounded, even though nothing is rasterised here.** An SVG is a string
   * rather than a pixel buffer, so this cannot OOM the way the renderer can —
   * but the dimensions reach `viewBox` and every coordinate in the document,
   * and an unbounded canvas would produce a string no browser will mount. The
   * same ceiling as the print path keeps preview and print in step, which is
   * the property this whole route exists to preserve.
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
