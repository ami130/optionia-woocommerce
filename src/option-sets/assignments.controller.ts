import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { Capability } from '../auth/permissions/capabilities';
import { CapabilityGuard } from '../auth/permissions/capability.guard';
import { RequireCapability } from '../auth/permissions/require-capability.decorator';
import { ApiErrors } from '../common/openapi/api-errors.decorator';
import {
  AssignmentsService,
  type AssignmentView,
  type AssignmentWriteResult,
} from './assignments.service';
import { AssignProductsDto } from './dto/assign-product.dto';

/**
 * Which products an option set applies to (M13.6).
 *
 * The write half of the picker; `GET /products` is the read half. This is the
 * first place in the product that creates a `MANUAL` assignment — until now the
 * only source was `demo.seed.ts`, which is why Phase 10's renderer had nothing
 * real to resolve.
 */
@Controller('option-sets/:id/assignments')
@ApiBearerAuth('tenant')
@UseGuards(JwtAuthGuard, TenantGuard, CapabilityGuard)
export class AssignmentsController {
  constructor(private readonly service: AssignmentsService) {}

  /**
   * A set's live assignments.
   *
   * `option_sets:view` rather than `products:assign`: reading which products a
   * set applies to is part of reading the set.
   */
  @Get()
  @RequireCapability(Capability.OPTION_SETS_VIEW)
  @ApiErrors(200, 401, 403, 404, 429)
  async list(@Param('id', ParseUUIDPipe) id: string): Promise<AssignmentView[]> {
    return this.service.list(id);
  }

  /**
   * Assign the set to one or more products.
   *
   * `200`, not `201`: the call is idempotent, so a repeat assigns nothing new
   * and creating a resource is not what happened. The response carries the
   * resulting assignment list and the new `configVersion`, so the dashboard can
   * show a merchant which revision their storefront needs to reach.
   */
  @Post()
  @HttpCode(200)
  @RequireCapability(Capability.PRODUCTS_ASSIGN)
  @ApiErrors(200, 400, 401, 403, 404, 429)
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignProductsDto,
  ): Promise<AssignmentWriteResult> {
    return this.service.assign(id, dto.externalProductIds);
  }

  /**
   * Unassign one product.
   *
   * The product id is WooCommerce's, so it is **not** a UUID and must not be
   * parsed as one — `ParseUUIDPipe` here would reject every real id.
   */
  @Delete(':externalProductId')
  @HttpCode(200)
  @RequireCapability(Capability.PRODUCTS_ASSIGN)
  @ApiErrors(200, 401, 403, 404, 429)
  async unassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('externalProductId') externalProductId: string,
  ): Promise<AssignmentWriteResult> {
    return this.service.unassign(id, externalProductId);
  }
}
