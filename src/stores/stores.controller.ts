import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import { RotateCredentialDto } from './dto/connect.dto';
import { StoresService, type DisconnectResult, type RotateResult } from './stores.service';

/**
 * Store ownership acts (M8.6).
 *
 * Both routes are destructive and both are tenant-realm. The store is resolved
 * through a tenant-scoped repository, so another tenant's id is a **404, not a
 * 403** — a 403 would confirm the store exists (ADR-010).
 */
@Controller('stores')
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class StoresController {
  constructor(private readonly service: StoresService) {}

  /**
   * Disconnect a store, revoking every live credential.
   *
   * 20 per hour per tenant, tighter than the global default: this is a
   * destructive ownership act, not a read.
   */
  @Post(':id/disconnect')
  @RequireCapability(Capability.STORES_CONNECT)
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async disconnect(@Param('id', ParseUUIDPipe) id: string): Promise<DisconnectResult> {
    return this.service.disconnect(id);
  }

  /**
   * Replace the store's credential, revoking the old one immediately.
   *
   * Carries `stores:rotate_credential` rather than `stores:connect`: the
   * permission matrix draws them separately, and rotation is the finer-grained
   * of the two.
   */
  @Post(':id/rotate-credential')
  @RequireCapability(Capability.STORES_ROTATE_CREDENTIAL)
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @ApiErrors(200, 400, 401, 403, 404, 409, 429)
  async rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RotateCredentialDto,
  ): Promise<RotateResult> {
    return this.service.rotate(id, dto.reason);
  }
}
